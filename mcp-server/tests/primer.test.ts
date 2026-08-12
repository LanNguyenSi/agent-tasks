import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HANDSHAKE_PRIMER, WORKFLOW_PRIMER } from "../src/primer.js";
import { DEFAULT_WORKFLOW_STATES } from "../src/default-workflow.js";
import { buildTools } from "../src/tools.js";
import { AgentTasksClient } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const TOOLS_TS_PATH = resolve(__filename, "..", "..", "src", "tools.ts");
const RECEIPT_TS_PATH = resolve(__filename, "..", "..", "src", "receipt.ts");
const REPO_README_PATH = resolve(__filename, "..", "..", "..", "README.md");

// docs/response-contract-v1.md's "Onboarding channels by rate of change" table:
// HANDSHAKE_PRIMER targets ~300-500 tokens with a HARD budget of 2000 chars
// (character-count proxy for token count, same convention as
// receipt.test.ts's TIER1_BUDGET_CHARS / TIER2_BUDGET_CHARS).
const HANDSHAKE_PRIMER_HARD_BUDGET_CHARS = 2000;

function registeredVerbNames(): Set<string> {
  const client = new AgentTasksClient({ baseUrl: "https://example.test", token: "tok" });
  return new Set(buildTools(client).map((t) => t.name));
}

// ── Default-deny verb-name guard (rc-v1-C004 review round 1, finding #5) ────
//
// The previous guard only matched tokens that already looked like a known
// verb-name family (task_*, tasks_*, project_*, ...), which is default-ALLOW:
// a fabricated verb from an unrelated family (measured: agents_register,
// teams_bootstrap, artifacts_upload) never matched the pattern at all and so
// passed the "mentions only registered verbs" check unnoticed. This instead
// matches EVERY snake_case token in the text and requires each one to be
// either a real registered verb name (derived from buildTools, never
// hardcoded) or an explicit entry in NON_VERB_TOKENS below. A brand-new
// snake_case token that is neither now fails loudly instead of silently
// passing.
const SNAKE_CASE_TOKEN_PATTERN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

// Measured by running this suite against HANDSHAKE_PRIMER, WORKFLOW_PRIMER,
// and the repo README's "First five minutes as an agent" section: every
// snake_case token those texts use that is not a registered verb name. A new
// snake_case token appearing in any of those three texts must be added here
// deliberately (state name, outcome literal, or error code quoted for the
// reader), never absorbed by widening the pattern above.
const NON_VERB_TOKENS = new Set([
  "in_progress", // DEFAULT_WORKFLOW_STATES state name
  "request_changes", // task_finish outcome literal / review action label
  "precondition_failed", // 422 error code (unmet workflow gate)
  "cross_repo_pr_rejected", // 400 error code (task_submit_pr)
  "already_claimed", // 409 error code example (rc-v1-C004 review round 2)
]);

function snakeCaseTokens(text: string): string[] {
  return Array.from(new Set(text.match(SNAKE_CASE_TOKEN_PATTERN) ?? []));
}

function assertOnlyKnownTokens(text: string, registered: Set<string>): void {
  for (const token of snakeCaseTokens(text)) {
    expect(
      registered.has(token) || NON_VERB_TOKENS.has(token),
      `unexpected snake_case token "${token}": not a registered verb name and not in NON_VERB_TOKENS`,
    ).toBe(true);
  }
}

describe("HANDSHAKE_PRIMER (initialize.instructions)", () => {
  it(`is <= ${HANDSHAKE_PRIMER_HARD_BUDGET_CHARS} chars (hard budget; measured ${HANDSHAKE_PRIMER.length})`, () => {
    expect(HANDSHAKE_PRIMER.length).toBeLessThanOrEqual(HANDSHAKE_PRIMER_HARD_BUDGET_CHARS);
  });

  it("carries no per-task data (no UUID-shaped taskId)", () => {
    expect(HANDSHAKE_PRIMER).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("has no em dashes", () => {
    expect(HANDSHAKE_PRIMER).not.toContain("—");
  });

  it("states the lifecycle in the actual default-workflow state order, derived not hardcoded", () => {
    const order = DEFAULT_WORKFLOW_STATES.map((s) => s.name).join(" -> ");
    expect(HANDSHAKE_PRIMER).toContain(order);
  });

  it("points to workflow_primer and projects_get_effective_gates", () => {
    expect(HANDSHAKE_PRIMER).toContain("workflow_primer");
    expect(HANDSHAKE_PRIMER).toContain("projects_get_effective_gates");
  });

  it("does not claim task_start returns the full task (contradicts receipt defaults)", () => {
    expect(HANDSHAKE_PRIMER).not.toMatch(/task_start returns the full task/i);
  });

  it("mentions only verb names that are actually registered, or an explicitly allowlisted non-verb token (default-deny)", () => {
    assertOnlyKnownTokens(HANDSHAKE_PRIMER, registeredVerbNames());
  });

  it("scopes the receipt-by-default promise to the actual converted verb set, not stated unconditionally (task_pickup and task_start are named separately)", () => {
    // rc-v1-C004 review round 1, finding #2: the promise held for only 10 of
    // 37 verbs and was flatly wrong for task_pickup (full spec by default,
    // not a receipt). rc-v1-C004 review round 2: round 1's own fix ("write
    // verbs return small receipts") was STILL overbroad, true for only the 8
    // converted verbs, not every write-capable tool. This supersedes the
    // round 1 pin with round 2's precise wording: the converted set is named
    // (checked mechanically against buildTools below), task_pickup/
    // task_start are named as separate cases, and every other tool is told
    // it gets the raw backend body.
    expect(HANDSHAKE_PRIMER).toMatch(/task_pickup returns the full spec/i);
    expect(HANDSHAKE_PRIMER).toMatch(
      /every other tool returns the raw backend body and ignores include/i,
    );
  });
});

// ── rc-v1-C004 review round 2, finding #2 (MEDIUM) ──────────────────────────
//
// HANDSHAKE_PRIMER's converted-verb list must never be hand-typed truth: it
// is checked here against the actual buildTools() registration (whether each
// tool's inputShape declares an `include` key), so a future verb conversion
// (or reversion) that forgets to update the primer sentence fails this test,
// not just silently drifts.
describe("HANDSHAKE_PRIMER's converted-verb list is grounded in buildTools, not hand-typed", () => {
  function includeAcceptingVerbNames(): Set<string> {
    const client = new AgentTasksClient({ baseUrl: "https://example.test", token: "tok" });
    return new Set(
      buildTools(client)
        .filter((t) => Object.keys(t.inputShape).includes("include"))
        .map((t) => t.name),
    );
  }

  function sentenceConvertedVerbs(): string[] {
    const match = HANDSHAKE_PRIMER.match(/The converted v2 write verbs \(([^)]+)\)/);
    if (!match) {
      throw new Error(
        'HANDSHAKE_PRIMER\'s "The converted v2 write verbs (...)" sentence not found (reworded?)',
      );
    }
    return match[1].split(",").map((s) => s.trim());
  }

  it("every verb named in the primer's converted-verb sentence actually accepts include in buildTools", () => {
    const derived = includeAcceptingVerbNames();
    for (const verb of sentenceConvertedVerbs()) {
      expect(
        derived.has(verb),
        `"${verb}" is named in HANDSHAKE_PRIMER as converted but its buildTools inputShape has no "include" key`,
      ).toBe(true);
    }
  });

  it("buildTools' include-accepting set, minus task_pickup and task_start, equals exactly the primer's named converted-verb list", () => {
    const derived = includeAcceptingVerbNames();
    derived.delete("task_pickup");
    derived.delete("task_start");
    expect(derived).toEqual(new Set(sentenceConvertedVerbs()));
  });
});

describe("WORKFLOW_PRIMER (workflow_primer verb)", () => {
  it("is deterministic across repeated reads", () => {
    expect(WORKFLOW_PRIMER).toBe(WORKFLOW_PRIMER);
    // Re-import identity: a plain module-level const, so two reads in the
    // same process are always the same string. Pinned as a regression guard
    // against the exported value drifting between builds.
    expect(WORKFLOW_PRIMER).toMatchSnapshot();
  });

  it("has no em dashes", () => {
    expect(WORKFLOW_PRIMER).not.toContain("—");
  });

  it("carries no per-task data (no UUID-shaped taskId)", () => {
    expect(WORKFLOW_PRIMER).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("reuses every DEFAULT_WORKFLOW_STATES agentInstructions string verbatim (single source, no third copy)", () => {
    for (const state of DEFAULT_WORKFLOW_STATES) {
      expect(WORKFLOW_PRIMER).toContain(state.agentInstructions);
    }
  });

  it("describes task_start's default as a receipt + per-task slice, not the full task (matches the Named exception in docs/response-contract-v1.md)", () => {
    expect(WORKFLOW_PRIMER).toMatch(/task_start:\s+a receipt plus a small per-task slice/);
    expect(WORKFLOW_PRIMER).not.toMatch(/task_start returns the full task/i);
  });

  it("describes task_pickup's default as the full spec without comments (matches the one write-verb exception in docs/response-contract-v1.md)", () => {
    expect(WORKFLOW_PRIMER).toMatch(/task_pickup:\s+the full task spec, without comments/);
  });

  it("does not present the future teaching-error catalog (code/recipe/allowedNext) as already implemented", () => {
    expect(WORKFLOW_PRIMER).toMatch(/planned for a future release/i);
    expect(WORKFLOW_PRIMER).not.toMatch(/"recipe":|"allowedNext":/);
  });

  it("mentions only verb names that are actually registered, or an explicitly allowlisted non-verb token (default-deny)", () => {
    assertOnlyKnownTokens(WORKFLOW_PRIMER, registeredVerbNames());
  });

  it("documents wrap()'s raw-backend-body suffix, not just the status/message pair", () => {
    // rc-v1-C004 review round 1, finding #6: tools.ts's wrap() appends the
    // parsed backend body (which carries the structured error code) after
    // the status/message pair when the backend returned one; the old prose
    // only documented the status/message half of that string.
    expect(WORKFLOW_PRIMER).toMatch(/optionally followed by the raw backend body/i);
  });

  it("does not claim the backend body avoids repeating the message (rc-v1-C004 review round 2, MEDIUM finding: this was false)", () => {
    expect(WORKFLOW_PRIMER).not.toMatch(/not a second copy/i);
  });
});

// ── rc-v1-C004 review round 2, finding #1 (MEDIUM) ──────────────────────────
//
// Ground truth test for the "## Errors today" sentence: drives an actual
// write-verb handler (task_pickup) through wrap() with a stubbed fetch
// returning a verbatim backend 409 body, captures the real thrown error
// text, and checks the primer's format sentence against what wrap() actually
// produces, not against a hand-typed belief about it. wrap() (tools.ts)
// builds `agent-tasks API <status>: <err.message>` then appends
// ` — ${JSON.stringify(err.body)}`; err.message is itself read out of the
// same body's own `message` field (client.ts's request()), so the backend
// message text appears TWICE in the final string: once as the extracted
// message, once again inside the raw JSON body tail.
describe("wrap()'s actual error text matches WORKFLOW_PRIMER's format sentence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a verbatim backend 409 body's message is repeated (not deduped) in the thrown error text", async () => {
    const backendBody = {
      error: "already_claimed",
      message: "You already hold an active claim on another task.",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(backendBody), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentTasksClient({ baseUrl: "https://example.test", token: "tok" });
    const pickup = buildTools(client).find((t) => t.name === "task_pickup");
    if (!pickup) throw new Error("task_pickup not registered");

    let captured = "";
    try {
      await pickup.handler({});
      throw new Error("expected task_pickup's handler to throw on a 409");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }

    // (a) starts with the status/message prefix.
    expect(captured.startsWith("agent-tasks API 409: ")).toBe(true);
    // (b) contains the raw backend body verbatim.
    expect(captured).toContain(JSON.stringify(backendBody));
    // The backend's own message text appears exactly twice: once extracted,
    // once inside the appended JSON body. This is the measured fact the
    // primer's format sentence must describe, not deny.
    const occurrences = captured.split(backendBody.message).length - 1;
    expect(occurrences).toBe(2);

    // (c) the primer's format sentence substrings match what was captured.
    expect(WORKFLOW_PRIMER).not.toMatch(/not a second copy/i);
    expect(WORKFLOW_PRIMER).toMatch(/the body repeats that same message/i);
    expect(WORKFLOW_PRIMER).toMatch(/already_claimed/);
  });
});

// ── rc-v1-C004 review round 1, finding #1 (HIGH) ────────────────────────────
//
// task_pickup performs NO claim of any kind: the backend pickup route writes
// no claim fields, task_finish's own description says "task_pickup alone
// returns a candidate but does not claim", and WORKFLOW_PRIMER's own
// canonical-flows line already attributes the review-claim to task_start, not
// task_pickup. Neither primer may say or imply task_pickup claims/review-claims
// anything.
describe("claim model: task_pickup never claims", () => {
  const PICKUP_CLAIMS_PATTERN = /task_pickup'?s? (review-)?claim/i;

  it("HANDSHAKE_PRIMER does not attribute a claim/review-claim to task_pickup", () => {
    expect(HANDSHAKE_PRIMER).not.toMatch(PICKUP_CLAIMS_PATTERN);
  });

  it("WORKFLOW_PRIMER does not attribute a claim/review-claim to task_pickup", () => {
    expect(WORKFLOW_PRIMER).not.toMatch(PICKUP_CLAIMS_PATTERN);
  });
});

// ── rc-v1-C004 review round 1, finding #3 (MEDIUM) ──────────────────────────
//
// The receipt shape line in WORKFLOW_PRIMER's "Receipt defaults" section must
// name exactly the fields a Receipt (receipt.ts) can actually be built with
// today: no field that no receiptFor* builder ever emits (like `transition`
// used to be, before this fix), and no missing field that a builder in that
// exact verb list does emit (like `confidence`, previously missing for
// task_create / task_respec).
describe("WORKFLOW_PRIMER's receipt shape line", () => {
  // Fields Receipt (receipt.ts) can actually carry via a receiptFor* builder
  // call today. Hardcoded (not derived from the Receipt TYPE) because
  // `transition` legitimately exists on the Receipt interface and on
  // buildReceipt's BuildReceiptOpts, but no current builder ever passes it
  // (see receipt.ts's own comments on receiptForFinish and receiptForMerge)
  // -- a type-derived list could not express "declared but never emitted" on
  // its own. Re-add `transition` here, and to the primer line, together, the
  // day a builder starts emitting it.
  const RECEIPT_SHAPE_FIELDS = ["ok", "task", "confidence", "deviations", "next"];

  function extractBracedShape(text: string, marker: string): string {
    const markerIdx = text.indexOf(marker);
    if (markerIdx === -1) {
      throw new Error(`marker not found in WORKFLOW_PRIMER: ${JSON.stringify(marker)}`);
    }
    const start = text.indexOf("{", markerIdx);
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    throw new Error("unbalanced braces while extracting the receipt shape literal");
  }

  // Splits only on TOP-LEVEL commas (brace depth 0 relative to the shape's
  // own outer braces), so the nested `task: { id, status? }` entry's inner
  // `id` / `status` never get mistaken for top-level receipt fields.
  function topLevelFieldNames(shape: string): string[] {
    const inner = shape.trim().replace(/^\{/, "").replace(/\}$/, "");
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of inner) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current);
    return parts.map((p) => p.trim().split(":")[0].trim().replace(/\?$/, ""));
  }

  it("names exactly the fields a Receipt (receipt.ts) can actually produce today, no more and no less", () => {
    const shape = extractBracedShape(WORKFLOW_PRIMER, "shaped {");
    const fieldNames = topLevelFieldNames(shape);
    expect(new Set(fieldNames)).toEqual(new Set(RECEIPT_SHAPE_FIELDS));
  });

  // ── rc-v1-C004 review round 2, finding #5 (LOW) ────────────────────────────
  //
  // RECEIPT_SHAPE_FIELDS above is still hand-typed (necessarily: it encodes
  // "declared but never emitted" for `transition`, which no type-derived list
  // could express on its own). These two tests pin the premise IN SOURCE,
  // the same way the C005 marker test below reads tools.ts directly, so a
  // future emitter that starts passing `transition` reddens THIS test, not
  // only receipt.test.ts.
  const receiptSource = readFileSync(RECEIPT_TS_PATH, "utf8");

  // Finds every `buildReceipt({ ... })` CALL SITE (not the `function
  // buildReceipt(opts: ...)` declaration, which has no `{` immediately after
  // the `(`), balanced-brace aware so a nested object inside a call's
  // arguments doesn't truncate the match early.
  function buildReceiptCallBodies(source: string): string[] {
    const bodies: string[] = [];
    let searchFrom = 0;
    for (;;) {
      const callIdx = source.indexOf("buildReceipt(", searchFrom);
      if (callIdx === -1) break;
      const braceStart = callIdx + "buildReceipt(".length;
      if (source[braceStart] !== "{") {
        // Not a `buildReceipt({...})` call (e.g. the function declaration
        // itself, `buildReceipt(opts: BuildReceiptOpts)`).
        searchFrom = braceStart;
        continue;
      }
      let depth = 0;
      let i = braceStart;
      for (; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      bodies.push(source.slice(braceStart, i + 1));
      searchFrom = i + 1;
    }
    return bodies;
  }

  it("no buildReceipt call site passes transition: pins why RECEIPT_SHAPE_FIELDS omits a field the Receipt type declares (never emitted, not absent from the type)", () => {
    const bodies = buildReceiptCallBodies(receiptSource);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toMatch(/\btransition\s*:/);
    }
  });

  it("RECEIPT_SHAPE_FIELDS is a subset of the Receipt interface's own declared field names", () => {
    const interfaceMatch = receiptSource.match(/export interface Receipt \{([\s\S]*?)\n\}/);
    if (!interfaceMatch) {
      throw new Error("Receipt interface not found in receipt.ts (renamed or restructured?)");
    }
    const body = interfaceMatch[1];
    for (const field of RECEIPT_SHAPE_FIELDS) {
      expect(
        new RegExp(`^\\s*${field}\\??\\s*:`, "m").test(body),
        `Receipt interface (receipt.ts) has no declared field "${field}"`,
      ).toBe(true);
    }
  });
});

// ── rc-v1-C004 review round 1, additional test D (cross-file, README) ───────
describe('repo README.md "First five minutes as an agent" section', () => {
  function firstFiveMinutesSection(): string {
    const text = readFileSync(REPO_README_PATH, "utf8");
    const match = text.match(/## First five minutes as an agent\n([\s\S]*?)\n## Next steps/);
    if (!match) {
      throw new Error(
        'README.md section "First five minutes as an agent" not found (heading renamed, moved, or removed?)',
      );
    }
    return match[1];
  }

  it("mentions only verb names that are actually registered, or an explicitly allowlisted non-verb token (default-deny, same guard as both primers)", () => {
    assertOnlyKnownTokens(firstFiveMinutesSection(), registeredVerbNames());
  });

  // rc-v1-C004 review round 2, finding #6 (LOW): assertOnlyKnownTokens loops
  // over snakeCaseTokens(text) -- an empty token list would make that loop
  // run zero times and the test above pass without checking anything. Pin
  // non-vacuity directly: the section must actually contain snake_case
  // tokens to check, and specifically the verb this section is built around.
  it("is not vacuous: actually contains snake_case verb tokens for the guard above to check", () => {
    const section = firstFiveMinutesSection();
    expect(section).toContain("task_pickup");
    expect(snakeCaseTokens(section).length).toBeGreaterThan(0);
  });
});

// ── rc-v1-C004 review round 1, additional test C (C005-blocking marker) ─────
//
// Converts the "primer silently goes stale" risk into a red test: this pins
// the CURRENT, pre-catalog state, so rc-v1-C005 (the structured teaching-error
// catalog: code/message/recipe/allowedNext, docs/response-contract-v1.md's
// "Error shape (block tier)" section) cannot ship without this test (and the
// primer's "Errors today" prose) being updated in the same change.
describe("rc-v1-C005 must update the Errors today section", () => {
  it("this test pins the pre-C005 state and MUST be updated together with the catalog", () => {
    expect(WORKFLOW_PRIMER).toMatch(/planned for a future release/i);
    // Read the real source, not a copy, so this fails the moment tools.ts's
    // wrap() starts emitting a structured `allowedNext` field, forcing
    // rc-v1-C005 to update this test (and the primer prose) together rather
    // than leaving the primer's "planned" claim silently stale.
    const toolsSource = readFileSync(TOOLS_TS_PATH, "utf8");
    expect(toolsSource).not.toContain("allowedNext");
  });
});
