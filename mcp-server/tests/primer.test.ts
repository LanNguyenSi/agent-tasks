import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HANDSHAKE_PRIMER, WORKFLOW_PRIMER } from "../src/primer.js";
import { DEFAULT_WORKFLOW_STATES } from "../src/default-workflow.js";
import { buildTools } from "../src/tools.js";
import { AgentTasksClient } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const RECEIPT_TS_PATH = resolve(__filename, "..", "..", "src", "receipt.ts");
const ERRORS_TS_PATH = resolve(__filename, "..", "..", "src", "errors.ts");
const TOOLS_TS_PATH = resolve(__filename, "..", "..", "src", "tools.ts");
const REPO_README_PATH = resolve(__filename, "..", "..", "..", "README.md");

// docs/response-contract-v1.md's "Onboarding channels by rate of change"
// table gives WORKFLOW_PRIMER no per-call budget (it is pulled once, not
// replayed automatically), but "no cap" is not the same as "no ceiling
// worth noticing": this is a sane upper bound, not a hard contract number,
// so a future addition that blows way past it fails loudly instead of the
// primer silently growing into something nobody meant to ship. Measured
// growth so far: 3877 chars pre-rc-v1-C005 -> 4484 with the "## Errors"
// section added -> 5390 after round 1's low_confidence catalog entry.
const WORKFLOW_PRIMER_SANITY_CEILING_CHARS = 6000;

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
  "not_claimed", // 403 error code (rc-v1-C005: acting without a claim)
  "pr_author_mismatch", // 403 error code (rc-v1-C005: task_submit_pr)
  "force_admin_only", // 403 error code (rc-v1-C005: tasks_transition force=true)
  "respec_conflict", // 409 error code (rc-v1-C005: task_respec state conflict)
  "result_not_plain_string", // client-side error code (rc-v1-C005: task_finish result guard)
  "low_confidence", // 422 error code (rc-v1-C005 review round 1, finding #2: confidence-gate detail preservation)
  "project_addressing_conflict", // client-side error code (rc-v1-C006 round-2 review: task_create's projectId/projectSlug exactly-one guard)
  "unknown_project_slug", // client-side error code (rc-v1-C006: an unresolvable projectSlug/project value)
]);

function snakeCaseTokens(text: string): string[] {
  return Array.from(new Set(text.match(SNAKE_CASE_TOKEN_PATTERN) ?? []));
}

function assertOnlyKnownTokens(
  text: string,
  registered: Set<string>,
  extraAllowlist: Set<string> = NON_VERB_TOKENS,
): void {
  for (const token of snakeCaseTokens(text)) {
    expect(
      registered.has(token) || extraAllowlist.has(token),
      `unexpected snake_case token "${token}": not a registered verb name and not in the allowlist`,
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
    // rc-v1-C006 round-2 review (MEDIUM): "every other tool returns the raw
    // backend body" was false for signals_poll (it caps+cursors locally via
    // paginateSignals, no include param involved at all) -- the carve-out
    // clause must appear BEFORE the every-other-tool claim, not just
    // somewhere in the text, so the claim that follows it is actually true
    // of what remains.
    expect(HANDSHAKE_PRIMER).toMatch(
      /signals_poll caps and cursors the backend response locally.*every other tool returns the raw backend body and ignores include/is,
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

  // rc-v1-C006: tasks_get is the primer's own separately-worded read-verb
  // addition (its own clause, "tasks_get returns a summary by default and
  // accepts include:[...]", not a member of the "converted v2 write verbs"
  // parenthetical list) — it is excluded here the same way task_pickup and
  // task_start already were, and asserted on its own right below instead.
  it("buildTools' include-accepting set, minus task_pickup, task_start, and tasks_get, equals exactly the primer's named converted-verb list", () => {
    const derived = includeAcceptingVerbNames();
    derived.delete("task_pickup");
    derived.delete("task_start");
    derived.delete("tasks_get");
    expect(derived).toEqual(new Set(sentenceConvertedVerbs()));
  });

  it("tasks_get (rc-v1-C006's read-verb include addition) actually accepts include in buildTools and is named in its own primer clause (not folded into the write-verb parenthetical list)", () => {
    const derived = includeAcceptingVerbNames();
    expect(derived.has("tasks_get")).toBe(true);
    expect(HANDSHAKE_PRIMER).toMatch(/tasks_get returns a summary by default and accepts include/i);
    expect(sentenceConvertedVerbs()).not.toContain("tasks_get");
  });
});

// ── rc-v1-C006 round-2 review (MEDIUM): signals_poll carve-out grounded in
// tools.ts, not hand-typed ──────────────────────────────────────────────
//
// The previous "every other tool returns the raw backend body and ignores
// include" claim was false for signals_poll: its handler reshapes the
// backend response locally (read.ts's paginateSignals: caps + cursors +
// atBackendFetchCeiling) without accepting an `include` param at all, so
// the include-accepting-set mechanical guard above (which the converted-
// verb sentence is checked against) could never have caught this drift --
// signals_poll was never going to appear in that set either way. This ties
// the primer's signals_poll carve-out to the actual source instead: any
// tools.ts handler that calls paginateSignals must be named in the
// carve-out clause, so a future non-include reshaping verb added the same
// way (calls a local projector, takes no include param) is caught here.
//
// Deliberately narrower than a fully general "reshapes vs passes through"
// classifier over every tools.ts handler (which the review sketched as a
// possible wider tie): that would require distinguishing "returns wrap()'s
// result unchanged" from "transforms it" for every handler shape in the
// file (bare-expression arrows, block-body arrows with an early include
// valve, receiptFor* projections, try/catch wrappers around
// ProjectSlugNotFoundError, ...), and a source-text heuristic robust
// enough to classify all of those correctly would be its own substantial,
// easy-to-get-subtly-wrong surface -- exactly the kind of unpinned claim
// this fix exists to close, not extend. The narrower, function-name-
// grounded tie below is cheap, exact, and closes the actual gap the
// finding was about (signals_poll specifically); a similarly narrow,
// grounded tie is the recommended pattern for the next such verb, rather
// than reaching for the general classifier.
describe("HANDSHAKE_PRIMER's signals_poll carve-out is grounded in tools.ts, not hand-typed", () => {
  function toolsSource(): string {
    return readFileSync(TOOLS_TS_PATH, "utf8");
  }

  // Crude but sufficient: finds each `name: "..."` tool-definition marker
  // and the handler text up to the next one, and reports which tool names
  // own a handler block that calls paginateSignals -- the actual reshaping
  // function signals_poll relies on (see read.ts). Verbs whose inputShape
  // has its own "include" key are handled by the separate converted-verb
  // guard above and excluded here so this guard stays scoped to the "no
  // include param, but still reshapes" class the false claim was about.
  function nonIncludeReshapingVerbNames(): string[] {
    const source = toolsSource();
    const defBlocks = source.split(/\n {4}def\(\{/).slice(1);
    // Non-vacuity: the 4-space-indent split must see EVERY def({ in the
    // file, or this guard fails open on a re-indent (measured in review:
    // a def block at 6-space indent slips past the split entirely). If a
    // reformat changes the indent convention, update the split pattern
    // here rather than letting the guard silently stop scanning.
    expect(defBlocks.length).toBe((source.match(/def\(\{/g) ?? []).length);
    const names: string[] = [];
    for (const block of defBlocks) {
      const nameMatch = block.match(/name:\s*"([a-zA-Z_]+)"/);
      if (!nameMatch) continue;
      const hasInclude = /include:\s*(?:includeSchema|\w*IncludeSchema)/.test(block);
      const reshapesLocally = block.includes("paginateSignals(");
      if (reshapesLocally && !hasInclude) names.push(nameMatch[1]);
    }
    return names;
  }

  it("tools.ts has exactly one non-include-accepting verb whose handler reshapes locally (paginateSignals), and it is signals_poll", () => {
    expect(nonIncludeReshapingVerbNames()).toEqual(["signals_poll"]);
  });

  it("every verb tools.ts names as a non-include local-reshaping verb is named in HANDSHAKE_PRIMER's carve-out clause", () => {
    const everyOtherToolAt = HANDSHAKE_PRIMER.indexOf(
      "every other tool returns the raw backend body",
    );
    expect(everyOtherToolAt).toBeGreaterThan(0);
    for (const verb of nonIncludeReshapingVerbNames()) {
      const verbAt = HANDSHAKE_PRIMER.indexOf(verb);
      expect(
        verbAt >= 0 && verbAt < everyOtherToolAt,
        `"${verb}" reshapes its response locally without an include param (tools.ts), but is not named in HANDSHAKE_PRIMER's carve-out clause BEFORE the "every other tool" claim (position asserted, not mere presence)`,
      ).toBe(true);
    }
  });
});

describe("WORKFLOW_PRIMER (workflow_primer verb)", () => {
  it(`stays under a sanity ceiling of ${WORKFLOW_PRIMER_SANITY_CEILING_CHARS} chars (measured ${WORKFLOW_PRIMER.length}; no per-call budget applies here, but unbounded growth should still fail loudly)`, () => {
    expect(WORKFLOW_PRIMER.length).toBeLessThanOrEqual(WORKFLOW_PRIMER_SANITY_CEILING_CHARS);
  });

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

  // rc-v1-C005: the teaching-error catalog (code/message/recipe/allowedNext)
  // is now implemented (errors.ts, wired through tools.ts's wrap()). The
  // primer must describe it as the CURRENT shape, not a future one, and
  // must not still carry the old "planned for a future release" hedge.
  it("presents the teaching-error shape (code/message/recipe/allowedNext) as implemented today, not planned", () => {
    expect(WORKFLOW_PRIMER).not.toMatch(/planned for a future release/i);
    expect(WORKFLOW_PRIMER).toMatch(/code, message, recipe, allowedNext/);
  });

  it("mentions only verb names that are actually registered, or an explicitly allowlisted non-verb token (default-deny)", () => {
    assertOnlyKnownTokens(WORKFLOW_PRIMER, registeredVerbNames());
  });

  // rc-v1-C005 superseded the old "status/message pair, optionally followed
  // by the raw backend body" string format entirely: wrap() now always
  // emits the structured teaching-error object (errors.ts's TeachingError),
  // so the primer documents THAT shape's fields instead of the retired
  // format the two tests below (same spot, pre-rc-v1-C005) used to pin.
  it("documents the detail field carrying structured extras (not a prose blob) for the codes that have one", () => {
    expect(WORKFLOW_PRIMER).toMatch(/detail\.failed/);
    expect(WORKFLOW_PRIMER).toMatch(/lists each failing rule individually/i);
  });

  it("documents allowedNext as machine-checkable verb names, distinct from a receipt's free-form next[]", () => {
    expect(WORKFLOW_PRIMER).toMatch(/machine-checkable/i);
  });
});

// ── rc-v1-C006 round-2 review (MEDIUM): the trap list stays in sync with
// errors.ts's own catalog, mechanically, not by remembering to hand-update
// prose every time a new code is added (the gap this closes: project_
// addressing_conflict and unknown_project_slug shipped in errors.ts but
// were missing from WORKFLOW_PRIMER's trap list until this fix) ──────────
describe("WORKFLOW_PRIMER's trap list stays in sync with errors.ts's catalog codes (mechanical guard)", () => {
  // Literal `code: "..."` string constants from every catalog entry builder
  // in errors.ts (buildTeachingError call sites with a hardcoded code).
  // Deliberately does NOT attempt to enumerate the generic degrade path's
  // code (status-derived `http_<status>`, or a passthrough of whatever the
  // backend's own `error` field says): that path has no fixed code to
  // check for, and is already covered by the primer's own trailing "Any
  // other backend error still degrades to the same shape" sentence rather
  // than a per-code trap-list entry.
  const CATALOG_CODE_PATTERN = /code:\s*"([a-z_]+)"/g;

  // Codes deliberately excused from appearing verbatim in WORKFLOW_PRIMER's
  // trap list, with a recorded reason. Empty today -- every literal catalog
  // code below IS named in the trap list -- so a future catalog entry can
  // opt out deliberately (with a reason recorded here) instead of this
  // guard being weakened silently by deleting the assertion.
  //
  // BUDGET SQUEEZE, recorded 2026-08-12: WORKFLOW_PRIMER sits at ~5.9k of
  // its 6000-char ceiling while this guard makes naming every new catalog
  // code mandatory. The next catalog entry will red BOTH tests at once.
  // Intended resolution: tighten existing trap-list wording or raise the
  // ceiling DELIBERATELY (it is a sanity bound, not a contract number).
  // This exclusion list is a semantic opt-out, NOT a budget valve -- do
  // not park a code here just to fit the ceiling.
  const TRAP_LIST_EXCLUSIONS: Record<string, string> = {};

  function catalogCodes(): Set<string> {
    const source = readFileSync(ERRORS_TS_PATH, "utf8");
    return new Set(Array.from(source.matchAll(CATALOG_CODE_PATTERN)).map((m) => m[1]));
  }

  it("every literal catalog code in errors.ts appears in WORKFLOW_PRIMER's trap list, or is named in TRAP_LIST_EXCLUSIONS with a reason", () => {
    for (const code of catalogCodes()) {
      const named = WORKFLOW_PRIMER.includes(code);
      const excused = code in TRAP_LIST_EXCLUSIONS;
      expect(
        named || excused,
        `catalog code "${code}" (errors.ts) is missing from WORKFLOW_PRIMER's trap list and not in TRAP_LIST_EXCLUSIONS`,
      ).toBe(true);
    }
  });

  // rc-v1-C004 review round 2, finding #6-style non-vacuity pin: a pattern
  // that matched nothing would make the loop above run zero times and pass
  // without checking anything.
  it("is not vacuous: errors.ts actually has literal catalog codes for the guard above to check", () => {
    expect(catalogCodes().size).toBeGreaterThan(5);
  });
});

// ── rc-v1-C005 (supersedes the rc-v1-C004 round 2 finding #1 ground-truth
// test that used to live here, for the retired string format) ──────────────
//
// Ground truth test for the "## Errors" section: drives two real write-verb
// handlers through wrap() with stubbed fetches returning verbatim backend
// error bodies, captures the real thrown error text, and checks it against
// both errors.ts's own mapBackendError/serializeTeachingError (not a
// hand-typed belief about what they do) and the primer's prose (so a future
// change to either the mapping or the primer that silently diverges from
// the other fails here, not just in errors.test.ts).
describe("wrap()'s actual error text matches errors.ts and WORKFLOW_PRIMER's Errors section", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a verbatim backend 409 already_claimed body maps to the documented teaching-error shape", async () => {
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

    const parsed = JSON.parse(captured);
    expect(parsed).toEqual({
      ok: false,
      error: {
        code: "already_claimed",
        message: backendBody.message,
        recipe: "call task_finish or task_abandon on your current task before claiming another",
        allowedNext: ["task_finish", "task_abandon"],
      },
    });
    // The backend's own message text appears exactly once (no duplication,
    // unlike the retired string format this test used to pin).
    const occurrences = captured.split(backendBody.message).length - 1;
    expect(occurrences).toBe(1);

    // The primer's Errors section matches what was actually captured.
    expect(WORKFLOW_PRIMER).toMatch(/already_claimed/);
    expect(WORKFLOW_PRIMER).toMatch(/call task_finish or task_abandon on your current task first/i);
  });

  it("a verbatim backend 403 not-claimed body on task_finish maps to the not_claimed catalog entry", async () => {
    const backendBody = {
      error: "forbidden",
      message:
        "You do not hold a claim on this task. Call task_start to claim it before task_finish, even if you just finished an unrelated task in the same session.",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(backendBody), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentTasksClient({ baseUrl: "https://example.test", token: "tok" });
    const finish = buildTools(client).find((t) => t.name === "task_finish");
    if (!finish) throw new Error("task_finish not registered");

    let captured = "";
    try {
      await finish.handler({ taskId: "11111111-1111-1111-1111-111111111111" } as never);
      throw new Error("expected task_finish's handler to throw on a 403");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }

    const parsed = JSON.parse(captured);
    expect(parsed.error.code).toBe("not_claimed");
    expect(parsed.error.recipe).toBe("call task_start to claim this task first");
    expect(parsed.error.allowedNext).toEqual(["task_start"]);

    expect(WORKFLOW_PRIMER).toMatch(/not_claimed/);
    expect(WORKFLOW_PRIMER).toMatch(/call task_start first/i);
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

// ── rc-v1-C004 review round 1, additional test C (C005-blocking marker),
// updated by rc-v1-C005 itself ──────────────────────────────────────────────
//
// This test used to pin the PRE-catalog state (WORKFLOW_PRIMER hedging the
// teaching-error shape as "planned", tools.ts carrying no `allowedNext`
// field anywhere) specifically so rc-v1-C005 could not ship without turning
// it red and updating it here. rc-v1-C005 now pins the POST-catalog state
// instead: the primer no longer hedges, and the real implementation (not a
// copy) actually wires the mapping, so a future regression back to raw
// error forwarding fails THIS test, not just the primer's own prose
// assertions above.
describe("rc-v1-C005: Errors section stays in sync with the teaching-error implementation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // This test used to grep tools.ts's and errors.ts's SOURCE TEXT for the
  // strings "mapBackendError", "serializeTeachingError", and "allowedNext"
  // as a proxy for "the catalog is actually wired". That proxy is inert:
  // all three names also appear in this file's own doc comments (see
  // errors.ts's file header and tools.ts's wrap() comment, both of which
  // discuss mapBackendError/serializeTeachingError/allowedNext at length),
  // so a hypothetical regression that fully unwires errors.ts from tools.ts
  // -- deletes wrap()'s mapBackendError call, reverting to the retired raw
  // `agent-tasks API <status>: <message>` forwarding -- leaves every
  // grepped string present in the surrounding comments regardless, and this
  // test stayed green while the feature it exists to protect regressed to
  // nothing (measured directly: commenting out wrap()'s mapBackendError
  // call in tools.ts kept the old version of this test passing and tsc
  // clean). This drives a REAL write-verb handler through a REAL 409
  // already_claimed backend body instead, so the test can only pass if
  // wrap() actually still calls into errors.ts at runtime, not merely
  // mentions its exports in prose.
  it("pins the POST-catalog state behaviorally: a real 409 already_claimed body, driven through a real handler's wrap() call, produces the teaching-error shape, not the retired raw-forward format", async () => {
    // Primer-drift assertions, unchanged from before this fix.
    expect(WORKFLOW_PRIMER).not.toMatch(/planned for a future release/i);
    expect(WORKFLOW_PRIMER).toMatch(/allowedNext/);

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
    const start = buildTools(client).find((t) => t.name === "task_start");
    if (!start) throw new Error("task_start not registered");

    let captured = "";
    try {
      await start.handler({ taskId: "22222222-2222-2222-2222-222222222222" } as never);
      throw new Error("expected task_start's handler to throw on a 409");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }

    // Not the retired raw-forward format (`agent-tasks API <status>:
    // <message>`; see tests/tools.test.ts's own comment on the retirement).
    // This is the assertion that actually goes red if wrap() is unwired:
    // an unwired wrap() throws `new Error(err.message)` directly, which
    // fails JSON.parse below AND would match this pattern.
    expect(captured).not.toMatch(/^agent-tasks API /);

    const parsed = JSON.parse(captured);
    expect(parsed.error.code).toBe("already_claimed");
    expect(Array.isArray(parsed.error.allowedNext)).toBe(true);
    expect(parsed.error.allowedNext.length).toBeGreaterThan(0);
  });
});

// ── rc-v1-C007 fix round (HIGH finding #1): default-registered tool
// descriptions must not go stale the way task_create's and project_tasks's
// unknown_project_slug recipe text did (both used to name projects_list as
// THE recipe unconditionally, which rc-v1-C007 made false the moment
// projects_list itself became legacy-flag-only) ──────────────────────────
//
// Reuses the same default-deny snake_case token guard as the two primers
// and the README section above, now run over every DEFAULT-registered
// tool's own `description` string (tools.ts, not primer.ts). A pruned v1
// verb's bare name (tasks_update, tasks_list, projects_get, projects_list,
// ...) is not a registered verb in DEFAULT mode, so it fails this guard the
// same way a fabricated verb would, UNLESS explicitly allowlisted below --
// which happens only for the two mentions that are deliberately kept
// (task_create's and project_tasks's unknown_project_slug recipe,
// task_submit_pr's replacement-history clause), each inside a sentence
// that also names AGENT_TASKS_MCP_LEGACY (checked separately below, not
// just presence-checked).
describe("every DEFAULT-registered tool's description mentions only known verb names (default-deny, rc-v1-C007 fix round)", () => {
  // Legitimate non-verb snake_case tokens that appear ONLY in tool
  // descriptions (tools.ts), not in either primer or the README section
  // above, so they do not belong in the shared NON_VERB_TOKENS list: enum
  // literals, GateCode examples, a signal name, and OAuth-style scope-name
  // fragments (github:pr_create / github:pr_merge), quoted for the reader
  // the same way NON_VERB_TOKENS's own entries are.
  const DESCRIPTION_ONLY_NON_VERB_TOKENS = new Set([
    "changes_requested", // task_finish: the signal emitted on outcome=request_changes
    "build_log", // task_artifact_create's artifact-type enum literal
    "test_report", // task_artifact_create's artifact-type enum literal
    "generated_code", // task_artifact_create's artifact-type enum literal
    "self_merge_blocked", // task_merge: 403 error code
    "pr_merge", // task_merge / pull_requests_merge: the github:pr_merge scope-name fragment
    "pr_create", // pull_requests_create: the github:pr_create scope-name fragment
    "distinct_reviewer", // projects_get_effective_gates: GateCode example
    "self_merge", // projects_get_effective_gates: GateCode example
    "task_status_for_merge", // projects_get_effective_gates: GateCode example
    "pr_repo_matches_project", // projects_get_effective_gates: GateCode example
  ]);

  // rc-v1-C007: a pruned verb's bare name may appear in a DEFAULT tool's
  // description ONLY inside a sentence that also names the
  // AGENT_TASKS_MCP_LEGACY escape hatch -- matching errors.ts's own
  // unknown_project_slug recipe wording, and task_submit_pr's
  // replacement-history clause -- never as a bare "use X instead" mention
  // with no flag context. Each entry here is deliberate: a new pruned-verb
  // mention must be added here explicitly (and pass the flag-context test
  // below), never absorbed silently by widening NON_VERB_TOKENS instead.
  const LEGACY_VERB_MENTIONS_IN_DESCRIPTIONS = new Set([
    "projects_list", // task_create / project_tasks: unknown_project_slug recipe
    "tasks_update", // task_submit_pr: v1-replacement clause
  ]);

  const DESCRIPTION_ALLOWLIST = new Set([
    ...NON_VERB_TOKENS,
    ...DESCRIPTION_ONLY_NON_VERB_TOKENS,
    ...LEGACY_VERB_MENTIONS_IN_DESCRIPTIONS,
  ]);

  function defaultToolDescriptions(): { name: string; description: string }[] {
    const client = new AgentTasksClient({ baseUrl: "https://example.test", token: "tok" });
    return buildTools(client).map((t) => ({ name: t.name, description: t.description }));
  }

  it("mentions only registered default verb names, or an explicitly allowlisted non-verb / flag-gated-legacy token, in every description", () => {
    const registered = registeredVerbNames();
    for (const { name, description } of defaultToolDescriptions()) {
      for (const token of snakeCaseTokens(description)) {
        expect(
          registered.has(token) || DESCRIPTION_ALLOWLIST.has(token),
          `tool "${name}"'s description mentions unexpected snake_case token "${token}": not a registered default verb and not in the allowlist`,
        ).toBe(true);
      }
    }
  });

  // Non-vacuity for the test below: without this, an accidental removal of
  // both flag-gated mentions would make the "every mention names the flag"
  // loop run zero times and pass without checking anything.
  it("is not vacuous: at least one default tool's description actually mentions a flag-gated legacy verb", () => {
    const descriptions = defaultToolDescriptions().map((t) => t.description);
    const mentionsAny = descriptions.some((d) =>
      Array.from(LEGACY_VERB_MENTIONS_IN_DESCRIPTIONS).some((v) => d.includes(v)),
    );
    expect(mentionsAny).toBe(true);
  });

  it("every flag-gated legacy-verb mention sits in a description that also names AGENT_TASKS_MCP_LEGACY (never a bare 'use X' reference)", () => {
    for (const { name, description } of defaultToolDescriptions()) {
      for (const legacyVerb of LEGACY_VERB_MENTIONS_IN_DESCRIPTIONS) {
        if (!description.includes(legacyVerb)) continue;
        expect(
          description.includes("AGENT_TASKS_MCP_LEGACY"),
          `tool "${name}"'s description mentions legacy verb "${legacyVerb}" without naming AGENT_TASKS_MCP_LEGACY anywhere in the same description`,
        ).toBe(true);
      }
    }
  });
});
