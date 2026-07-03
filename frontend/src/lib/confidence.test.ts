import { describe, expect, it } from "vitest";
import {
  calculateConfidence,
  descriptionQuality,
  extractSpecSections,
  EVALS_KEYSTONE_CAP,
  FIELD_WEIGHTS,
} from "./confidence";

type Input = Parameters<typeof calculateConfidence>[0];
type Result = ReturnType<typeof calculateConfidence>;
// The parity loop asserts the scalar/array scoring outputs; findings[] (the
// prose-bearing, parity-fragile part) is asserted separately below against the
// backend ground-truth so a future mirror edit to buildFindings or the cap-merge
// breaks a test instead of silently drifting.
type Expected = Omit<Result, "findings">;

/**
 * Parity fixtures. The `expected` values are GROUND TRUTH: produced by running
 * the authoritative backend scorer (backend/src/lib/confidence.ts, prose-first
 * calibration) over the exact same `input`. The frontend scorer is a mirror, so
 * every field — score, blocking, missing[], inferredTaskType, and all 7
 * subscores — must match the backend byte-for-byte. If the backend scorer is
 * re-tuned, regenerate these via the backend harness and update here.
 */
const FIXTURES: { name: string; input: Input; expected: Expected }[] = [
  {
    name: "empty",
    input: { title: "", description: null, templateData: null, templateFields: null },
    expected: {
      score: 0,
      blocking: true,
      missing: ["title", "description", "goal", "acceptanceCriteria", "scope", "outOfScope", "dependencies", "risk", "agentPrompt"],
      inferredTaskType: undefined,
      subscores: { completeness: 0, concreteness: 0, testability: 0, scopeClarity: 0, contextQuality: 0, structure: 0, ambiguityRisk: 100 },
    },
  },
  {
    name: "title-only-no-desc",
    input: { title: "Add exponential backoff to the GitHub webhook retry", description: null, templateData: null, templateFields: null },
    expected: {
      score: 10,
      blocking: true,
      missing: ["description", "goal", "acceptanceCriteria", "scope", "outOfScope", "dependencies", "risk", "agentPrompt"],
      inferredTaskType: undefined,
      subscores: { completeness: 50, concreteness: 0, testability: 0, scopeClarity: 0, contextQuality: 0, structure: 0, ambiguityRisk: 100 },
    },
  },
  {
    name: "rich-prose-no-verification",
    input: {
      title: "Sync the frontend confidence scorer",
      description:
        "## Context\nThe dashboard board badge shows a stale number because the client scorer in `frontend/src/lib/confidence.ts` diverged from the backend prose-first scorer.\n\n## Goal\nMirror the 9 prose-first weights so the badge a human sees matches what the gate computes for the 75-task corpus.",
      templateData: null,
      templateFields: null,
    },
    expected: {
      score: 55,
      blocking: true,
      missing: ["acceptanceCriteria", "scope", "outOfScope", "dependencies", "risk", "agentPrompt"],
      inferredTaskType: undefined,
      subscores: { completeness: 100, concreteness: 100, testability: 0, scopeClarity: 0, contextQuality: 100, structure: 65, ambiguityRisk: 100 },
    },
  },
  {
    name: "rich-prose-with-verification",
    input: {
      title: "Sync the frontend confidence scorer",
      description:
        "## Context\nThe dashboard board badge shows a stale number because the client scorer in `frontend/src/lib/confidence.ts` diverged from the backend prose-first scorer.\n\n## Goal\nMirror the 9 prose-first weights so the badge matches the gate.\n\n## Verify\nVerify by running `npm test` and confirm the parity suite is green.",
      templateData: null,
      templateFields: null,
    },
    expected: {
      score: 75,
      blocking: false,
      missing: ["scope", "outOfScope", "dependencies", "risk", "agentPrompt"],
      inferredTaskType: undefined,
      subscores: { completeness: 100, concreteness: 75, testability: 100, scopeClarity: 0, contextQuality: 100, structure: 65, ambiguityRisk: 100 },
    },
  },
  {
    name: "full-strong-with-ac",
    input: {
      title: "Sync the frontend confidence scorer to scorer-v2",
      description:
        "## Context\nThe client scorer in `frontend/src/lib/confidence.ts` diverged from the backend after the prose-first calibration.\n\n## Goal\nPort the fixed-denominator weights and the keystone cap so badges match the gate for all 75 tasks.",
      templateData: {
        goal: "Badges show the same score the gate computes.",
        acceptanceCriteria: "- A parity test asserts 8 fixtures match the backend\n- next build passes",
        scope: "frontend/src/lib/confidence.ts and its 3 call-sites",
        constraints: "Do not change the backend weights; mirror them only.",
        risk: "Medium: visible badge numbers change.",
        dependencies: "none",
      },
      templateFields: null,
    },
    expected: {
      score: 84,
      blocking: false,
      missing: ["outOfScope", "agentPrompt"],
      inferredTaskType: undefined,
      subscores: { completeness: 100, concreteness: 100, testability: 100, scopeClarity: 100, contextQuality: 100, structure: 65, ambiguityRisk: 100 },
    },
  },
  {
    name: "vague-no-anchors",
    input: {
      title: "Make it better",
      description: "We should fix and improve and optimize the thing somehow, quickly.",
      templateData: null,
      templateFields: null,
    },
    expected: {
      score: 28,
      blocking: true,
      missing: ["description", "goal", "acceptanceCriteria", "scope", "outOfScope", "dependencies", "risk", "agentPrompt"],
      inferredTaskType: undefined,
      subscores: { completeness: 100, concreteness: 0, testability: 60, scopeClarity: 0, contextQuality: 15, structure: 0, ambiguityRisk: 50 },
    },
  },
  {
    name: "template-fields-completeness",
    input: {
      title: "Wire the dependency graph into the scorer",
      description:
        "## Context\nThe scorer treats `dependencies` as satisfied by any prose. Tie it to the real dependsOn[] edges in `backend/src/routes/tasks.ts`.\n\n## Goal\nThe scorer reads the edge set so 'none' is distinct from an actual prerequisite.",
      templateData: null,
      templateFields: { goal: true, acceptanceCriteria: true, context: true, constraints: true },
    },
    expected: {
      score: 55,
      blocking: true,
      missing: ["acceptanceCriteria", "scope", "outOfScope", "dependencies", "risk", "agentPrompt"],
      inferredTaskType: undefined,
      subscores: { completeness: 67, concreteness: 75, testability: 0, scopeClarity: 0, contextQuality: 100, structure: 65, ambiguityRisk: 100 },
    },
  },
  {
    name: "typed-feature-with-ac",
    input: {
      title: "Render create-time confidence on the dashboard",
      description:
        "## Goal\nSurface the server `confidence` object after a create in `frontend/src/app/dashboard/page.tsx`.\n\n## Verify\nRun the e2e and check the panel shows score, missing, and nextActions.",
      templateData: {
        acceptanceCriteria: "- createTask exposes { task, confidence }\n- the panel renders nextActions",
        taskType: "feature",
        agentPrompt: "1. Widen createTask. 2. Render the panel. 3. Run next build.",
      },
      templateFields: null,
    },
    expected: {
      score: 74,
      blocking: false,
      missing: ["scope", "outOfScope", "dependencies", "risk"],
      inferredTaskType: "feature",
      subscores: { completeness: 100, concreteness: 75, testability: 100, scopeClarity: 0, contextQuality: 43, structure: 65, ambiguityRisk: 100 },
    },
  },
];

const byName = Object.fromEntries(FIXTURES.map((f) => [f.name, f.input] as const));

describe("calculateConfidence — backend parity", () => {
  for (const { name, input, expected } of FIXTURES) {
    it(`matches the backend scorer: ${name}`, () => {
      const result = calculateConfidence(input);
      expect(result.score).toBe(expected.score);
      expect(result.blocking).toBe(expected.blocking);
      expect(result.missing).toEqual(expected.missing);
      expect(result.inferredTaskType).toBe(expected.inferredTaskType);
      expect(result.subscores).toEqual(expected.subscores);
    });
  }
});

/**
 * findings[] ground-truth (verbatim backend output). These three fixtures lock
 * the parity-fragile finding logic the score/blocking assertions cannot reach:
 *  - empty: the cap-finding merge-by-code, where a triggered cap appends its
 *    "lift this cap (current ceiling N/100)" suffix onto the rule finding
 *    (missing_title/30, missing_or_thin_description/40, missing_acceptance_criteria/55),
 *    plus the standalone cap findings (low_testability/scope_clarity/concreteness).
 *  - rich-prose-with-verification: a spec whose `## Goal` and `## Verify` headings
 *    are recognized as sections, so goal + acceptanceCriteria are satisfied from
 *    the description and only the advisory boundary findings plus the
 *    low_scope_clarity cap remain.
 *  - full-strong-with-ac: the minimal high-score path (only the two genuinely
 *    absent fields surface).
 * The message strings (em dashes included) are copied byte-for-byte from the
 * backend; this asserts the mirror reproduces them exactly.
 */
const FINDINGS_GROUND_TRUTH: Record<string, Result["findings"]> = {
  empty: [
    { code: "missing_title", severity: "blocking", dimension: "completeness", message: "Title is empty.", suggestion: "Add a short imperative title naming the change. Add the missing element to lift this cap (current ceiling 30/100)." },
    { code: "missing_or_thin_description", severity: "blocking", dimension: "structure", message: "Description is missing or below quality threshold.", suggestion: "Add a short Context and Goal section with concrete anchors. Add the missing element to lift this cap (current ceiling 40/100)." },
    { code: "missing_goal", severity: "warning", dimension: "completeness", message: "Goal is missing.", suggestion: "Add a one-line Goal stating the intended outcome." },
    { code: "missing_acceptance_criteria", severity: "blocking", dimension: "testability", message: "No acceptance criteria and no verification path in the description.", suggestion: "Add 2-5 bullets describing observable completion conditions (the task's evals). Add the missing element to lift this cap (current ceiling 55/100).", keystone: true },
    { code: "missing_scope", severity: "warning", dimension: "scopeClarity", message: "Scope (what may change) is missing.", suggestion: "List the files, modules, or surfaces the change may touch." },
    { code: "missing_out_of_scope", severity: "info", dimension: "scopeClarity", message: "Out-of-scope boundary is missing.", suggestion: "Name what must NOT change so a weak agent does not wander." },
    { code: "missing_dependencies", severity: "info", dimension: "completeness", message: "Dependencies are unstated.", suggestion: "State prerequisite work, or 'none' if there is no prerequisite." },
    { code: "missing_risk", severity: "info", dimension: "ambiguityRisk", message: "Risk / blast radius is unstated.", suggestion: "Note the risk level or blast radius (low / medium / high, and why)." },
    { code: "missing_agent_prompt", severity: "warning", dimension: "completeness", message: "No literal agent instruction block (agentPrompt).", suggestion: "Add a step-by-step instruction block a weak agent can execute verbatim.", keystone: true },
    { code: "low_testability", severity: "warning", dimension: "testability", message: "Score capped at 70: low testability — no acceptance criteria and no test/verify/expect/assert/should/given/when/then language, so there is no way to know the task is done.", suggestion: "Add the missing element to lift this cap (current ceiling 70/100)." },
    { code: "low_scope_clarity", severity: "warning", dimension: "scopeClarity", message: "Score capped at 75: low scope clarity — no constraints and no in-scope/out-of-scope markers, so a weak agent can wander.", suggestion: "Add the missing element to lift this cap (current ceiling 75/100)." },
    { code: "low_concreteness", severity: "warning", dimension: "concreteness", message: "Score capped at 80: no concrete anchors — no file path, code reference, URL, or number to ground the work.", suggestion: "Add the missing element to lift this cap (current ceiling 80/100)." },
  ],
  "rich-prose-with-verification": [
    { code: "missing_scope", severity: "warning", dimension: "scopeClarity", message: "Scope (what may change) is missing.", suggestion: "List the files, modules, or surfaces the change may touch." },
    { code: "missing_out_of_scope", severity: "info", dimension: "scopeClarity", message: "Out-of-scope boundary is missing.", suggestion: "Name what must NOT change so a weak agent does not wander." },
    { code: "missing_dependencies", severity: "info", dimension: "completeness", message: "Dependencies are unstated.", suggestion: "State prerequisite work, or 'none' if there is no prerequisite." },
    { code: "missing_risk", severity: "info", dimension: "ambiguityRisk", message: "Risk / blast radius is unstated.", suggestion: "Note the risk level or blast radius (low / medium / high, and why)." },
    { code: "missing_agent_prompt", severity: "warning", dimension: "completeness", message: "No literal agent instruction block (agentPrompt).", suggestion: "Add a step-by-step instruction block a weak agent can execute verbatim.", keystone: true },
    { code: "low_scope_clarity", severity: "warning", dimension: "scopeClarity", message: "Score capped at 75: low scope clarity — no constraints and no in-scope/out-of-scope markers, so a weak agent can wander.", suggestion: "Add the missing element to lift this cap (current ceiling 75/100)." },
  ],
  "full-strong-with-ac": [
    { code: "missing_out_of_scope", severity: "info", dimension: "scopeClarity", message: "Out-of-scope boundary is missing.", suggestion: "Name what must NOT change so a weak agent does not wander." },
    { code: "missing_agent_prompt", severity: "warning", dimension: "completeness", message: "No literal agent instruction block (agentPrompt).", suggestion: "Add a step-by-step instruction block a weak agent can execute verbatim.", keystone: true },
  ],
};

describe("calculateConfidence — findings parity (keystone downgrade + cap merge)", () => {
  for (const [name, findings] of Object.entries(FINDINGS_GROUND_TRUTH)) {
    it(`reproduces the backend findings byte-for-byte: ${name}`, () => {
      const result = calculateConfidence(byName[name]);
      expect(result.findings).toEqual(findings);
    });
  }

  it("the AC keystone is blocking without a verification signal but downgrades to a warning with a prose one", () => {
    // Prose-only descriptions (no ## headings), so acPresent stays false and the
    // signal comes from the verification regex, not a recognized AC section.
    const noVerify = calculateConfidence({
      title: "ok",
      description: "Refactor the signup handler in src/routes/auth.ts to extract body validation",
      templateData: { goal: "g" },
      templateFields: null,
    });
    const acNoVerify = noVerify.findings.find((f) => f.code === "missing_acceptance_criteria");
    expect(acNoVerify?.severity).toBe("blocking");
    expect(acNoVerify?.keystone).toBe(true);

    const withVerify = calculateConfidence({
      title: "ok",
      description: "Verify via `curl /api/signup` that src/routes/auth.ts returns 400 on an empty body",
      templateData: { goal: "g" },
      templateFields: null,
    });
    const acWithVerify = withVerify.findings.find((f) => f.code === "missing_acceptance_criteria");
    expect(acWithVerify?.severity).toBe("warning");
    expect(acWithVerify?.keystone).toBeUndefined();
    // Pin the distinctive downgrade wording byte-for-byte (parity-fragile).
    expect(acWithVerify?.message).toBe(
      "No structured acceptance criteria; the description's verification signal is the only evals path.",
    );
  });

  it("pins the interpolated cap / subscore finding messages byte-for-byte (parity-fragile)", () => {
    // vague-no-anchors is the only fixture that trips ambiguous_scope +
    // vague_language + no_concrete_anchors; those messages are otherwise
    // unasserted and would drift silently against the backend.
    const r = calculateConfidence(byName["vague-no-anchors"]);
    const msg = (code: string) => r.findings.find((f) => f.code === code)?.message;
    expect(msg("ambiguous_scope")).toBe(
      "Score capped at 75: 5 vague terms with no concrete anchors (file path, URL, inline code, or number).",
    );
    expect(msg("vague_language")).toBe("Description contains vague terms an agent cannot act on directly.");
    expect(msg("no_concrete_anchors")).toBe("Description has no file paths, code references, URLs, or numbers.");
  });
});

describe("scorer invariants", () => {
  it("FIELD_WEIGHTS sum to exactly 100 (fixed denominator)", () => {
    const sum = Object.values(FIELD_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it("descriptionQuality is 0 for empty and bounded to 1", () => {
    expect(descriptionQuality("")).toBe(0);
    expect(descriptionQuality("   ")).toBe(0);
    const rich = descriptionQuality("a ".repeat(400) + " `code` /a/path file.ts http://x 1234");
    expect(rich).toBeLessThanOrEqual(1);
    expect(rich).toBeGreaterThan(0);
  });

  it("a verifiable, well-formed task is never flagged blocking", () => {
    const r = calculateConfidence({
      title: "Fix the off-by-one in pagination",
      description: "Update `getPage()` in api.ts so the last page is included.",
      templateData: { acceptanceCriteria: "- page N returns the final row\n- a vitest covers it" },
      templateFields: null,
    });
    expect(r.blocking).toBe(false);
  });
});

// ── Markdown spec sections (ported from the backend suite) ──────────────────
// The blocks below are a faithful port of backend/tests/unit/confidence.test.ts
// (describe "extractSpecSections" + "markdown spec sections (friction #99)"),
// asserting the mirror parses `##` headings — including the decorated house
// style — exactly like the server. The backend's console.info spy is dropped
// (the frontend scorer has no ops log side effect).

// Fully specced v2 create: all seven scored sections as `##` headings with real
// bodies, templateData null. Identical to the backend fixture of the same name.
const SECTIONED_DESC = [
  "## Goal",
  "",
  "The `signup` handler in src/routes/auth.ts returns 400 on an empty body.",
  "",
  "## Context",
  "",
  "Posting an empty body 500s today; see incident 4711.",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] POST /api/signup with `{}` returns 400",
  "- [ ] A unit test covers the empty-body branch and CI is green",
  "",
  "## Scope",
  "",
  "- src/routes/auth.ts signup handler only",
  "",
  "## Out of scope",
  "",
  "- Session middleware stays untouched",
  "",
  "## Dependencies",
  "",
  "none",
  "",
  "## Risk",
  "",
  "low: single handler, no migration",
  "",
  "## Agent Prompt",
  "",
  "1. Add a zod body schema.",
  "2. Return 400 on parse failure.",
  "3. Add a unit test.",
].join("\n");

describe("extractSpecSections", () => {
  it("parses every aliased section from ## headings", () => {
    const s = extractSpecSections(SECTIONED_DESC);
    expect(s.goal).toContain("signup");
    expect(s.acceptanceCriteria).toContain("returns 400");
    expect(s.scope).toBe("- src/routes/auth.ts signup handler only");
    expect(s.outOfScope).toContain("Session middleware");
    expect(s.dependencies).toBe("none");
    expect(s.risk).toContain("low");
    expect(s.agentPrompt).toContain("zod body schema");
    expect(s.context).toContain("500s today");
  });

  it("matches case-insensitively, with trailing colon, at any heading level", () => {
    const s = extractSpecSections("### GOAL:\nShip it correctly.\n#### risks\nlow blast radius");
    expect(s.goal).toBe("Ship it correctly.");
    expect(s.risk).toBe("low blast radius");
  });

  it("maps the acceptanceCriteria aliases 'Done when', 'Evals', 'Verify', 'Verification', and 'Success criteria'", () => {
    for (const alias of ["Done when", "Evals", "Verify", "Verification", "Success criteria"]) {
      expect(extractSpecSections(`## ${alias}\n- endpoint returns 400`).acceptanceCriteria).toBe("- endpoint returns 400");
    }
  });

  it("never satisfies scope via an 'Out of scope' heading", () => {
    const s = extractSpecSections("## Out of scope\n- the session middleware");
    expect(s.scope).toBeUndefined();
    expect(s.outOfScope).toBe("- the session middleware");
  });

  it("strips a trailing parenthetical decorator (house style of the review-created tasks)", () => {
    const s = extractSpecSections(
      "## Scope (harness, mechanical)\n- src/lib/confidence.ts\n## Acceptance criteria (mutation-testable)\n- decorated headings are recognized",
    );
    expect(s.scope).toBe("- src/lib/confidence.ts");
    expect(s.acceptanceCriteria).toBe("- decorated headings are recognized");
  });

  it("a decorated 'Out of scope (...)' heading maps to outOfScope, never scope (negative control)", () => {
    const s = extractSpecSections("## Out of scope (agent-dx packages/orchestrator-workflow)\n- the session middleware");
    expect(s.outOfScope).toBe("- the session middleware");
    expect(s.scope).toBeUndefined();
  });

  it("strips the decorator even when a colon follows it", () => {
    const s = extractSpecSections("## Risk (blast radius):\nlow");
    expect(s.risk).toBe("low");
  });

  it("does not recognize a heading that is only a parenthetical", () => {
    const s = extractSpecSections("## (context)\nbody");
    expect(s.context).toBeUndefined();
    expect(s.goal).toBeUndefined();
  });

  it("leaves a NON-trailing parenthetical in place (only a trailing decorator is stripped)", () => {
    const s = extractSpecSections("## Scope (a) and more\n- x");
    expect(s.scope).toBeUndefined();
  });

  it("strips only the LAST trailing group, so multiple trailing groups stay unrecognized", () => {
    const s = extractSpecSections("## Scope (a) (b)\n- x");
    expect(s.scope).toBeUndefined();
  });

  it("treats an empty-bodied section as absent", () => {
    const s = extractSpecSections("## Goal\n\n## Scope\n- src/x.ts");
    expect(s.goal).toBeUndefined();
    expect(s.scope).toBe("- src/x.ts");
  });

  it("ignores headings inside code fences", () => {
    const s = extractSpecSections("Example spec:\n```\n## Goal\nfaked goal\n```\nplain text");
    expect(s.goal).toBeUndefined();
  });

  it("a mismatched fence marker does not close the fence (``` stays open across ~~~)", () => {
    const s = extractSpecSections("```\n~~~\n## Goal\nstill inside the backtick fence\n```\nafter");
    expect(s.goal).toBeUndefined();
  });

  it("an unclosed fence swallows the rest of the description (fail-safe toward missing)", () => {
    const s = extractSpecSections("intro\n```\n## Acceptance Criteria\n- looks real but is fenced");
    expect(s.acceptanceCriteria).toBeUndefined();
  });

  it("handles CRLF line endings in headings, bodies, and fences", () => {
    const s = extractSpecSections("## Goal\r\nShip it correctly.\r\n\r\n## Risk\r\nlow\r\n");
    expect(s.goal).toBe("Ship it correctly.");
    expect(s.risk).toBe("low");
    const fenced = extractSpecSections("```\r\n## Goal\r\nfenced example\r\n```\r\n");
    expect(fenced.goal).toBeUndefined();
  });

  it("keeps a fenced code block as part of the enclosing section's body", () => {
    const s = extractSpecSections("## Agent Prompt\nRun this:\n```\n## not a heading\nnpm ci\n```");
    expect(s.agentPrompt).toContain("npm ci");
    expect(s.goal).toBeUndefined();
  });

  it("keeps the first occurrence when a heading repeats", () => {
    const s = extractSpecSections("## Goal\nfirst goal\n## Goal\nsecond goal");
    expect(s.goal).toBe("first goal");
  });

  it("does not leak an unmapped section's body into the previous section", () => {
    const s = extractSpecSections("## Goal\nthe real goal\n## Refs\nreviewer finding on PR #379");
    expect(s.goal).toBe("the real goal");
  });

  it("an unmapped heading closes an empty mapped section instead of donating its body", () => {
    const s = extractSpecSections("## Goal\n\n## Refs\nleaked body");
    expect(s.goal).toBeUndefined();
  });
});

describe("calculateConfidence — markdown spec sections (friction #99)", () => {
  it("reports no missing spec fields for a fully sectioned description without templateData", () => {
    const result = calculateConfidence({
      title: "Return 400 on empty signup body",
      description: SECTIONED_DESC,
      templateData: null,
      templateFields: null,
    });
    for (const field of ["goal", "acceptanceCriteria", "scope", "outOfScope", "dependencies", "risk", "agentPrompt"]) {
      expect(result.missing).not.toContain(field);
    }
    expect(result.findings).toEqual([]);
    expect(result.blocking).toBe(false);
    expect(result.score).toBeGreaterThan(85);
    expect(result.subscores.testability).toBe(100);
  });

  it("still reports a section that is genuinely absent (negative control)", () => {
    const withoutRisk = SECTIONED_DESC.replace("## Risk\n\nlow: single handler, no migration\n\n", "");
    const result = calculateConfidence({
      title: "Return 400 on empty signup body",
      description: withoutRisk,
      templateData: null,
      templateFields: null,
    });
    expect(result.missing).toContain("risk");
    expect(result.findings.find((f) => f.code === "missing_risk")).toBeDefined();
    expect(result.missing).not.toContain("goal");
  });

  it("an empty-bodied ## Goal still counts as missing (negative control)", () => {
    const result = calculateConfidence({
      title: "ok",
      description: "## Goal\n\n## Scope\n- src/x.ts verify via a unit test",
      templateData: null,
      templateFields: null,
    });
    expect(result.missing).toContain("goal");
    expect(result.missing).not.toContain("scope");
  });

  it("an ## Acceptance Criteria section defuses the evals keystone", () => {
    const result = calculateConfidence({
      title: "Extract signup validation",
      description: "## Goal\nExtract the body validation from src/routes/auth.ts into a helper.\n## Acceptance Criteria\n- POST /api/signup with `{}` yields a 400 response",
      templateData: null,
      templateFields: null,
    });
    expect(result.blocking).toBe(false);
    expect(result.subscores.testability).toBe(100);
    expect(result.findings.find((f) => f.code === "missing_acceptance_criteria")).toBeUndefined();
  });

  it("sections without any AC or verification prose still trip the keystone (negative control)", () => {
    const result = calculateConfidence({
      title: "Extract signup validation",
      description: "## Goal\nExtract the body validation from src/routes/auth.ts into a helper.\n## Scope\n- src/routes/auth.ts",
      templateData: null,
      templateFields: null,
    });
    expect(result.blocking).toBe(true);
    expect(result.score).toBeLessThanOrEqual(EVALS_KEYSTONE_CAP);
    expect(result.findings.find((f) => f.code === "missing_acceptance_criteria")?.severity).toBe("blocking");
  });

  it("decorated section headings stop the false missing_scope / missing_acceptance_criteria", () => {
    const description = [
      "## Goal",
      "",
      "Recognize decorated headings in the client scorer.",
      "",
      "## Scope (harness, mechanical)",
      "",
      "- frontend/src/lib/confidence.ts normalizeHeading",
      "",
      "## Acceptance criteria (mutation-testable)",
      "",
      "- [ ] decorated `## Scope (x)` headings satisfy scope",
      "",
      "## Out of scope (agent-dx packages/orchestrator-workflow)",
      "",
      "- no new aliases",
    ].join("\n");
    const result = calculateConfidence({
      title: "Recognize decorated headings",
      description,
      templateData: null,
      templateFields: null,
    });
    for (const field of ["goal", "scope", "acceptanceCriteria", "outOfScope"]) {
      expect(result.missing).not.toContain(field);
    }
    expect(result.findings.find((f) => f.code === "missing_scope")).toBeUndefined();
    expect(result.findings.find((f) => f.code === "missing_acceptance_criteria")).toBeUndefined();
  });

  it("structured templateData still satisfies fields when the description has no sections", () => {
    const result = calculateConfidence({
      title: "ok",
      description: "Add `validateSignup()` in src/routes/auth.ts:42 returning 400 on an empty body",
      templateData: {
        goal: "Validate the signup request body",
        acceptanceCriteria: "- Returns 400 on empty email\n- Returns 201 on a valid body",
        scope: "src/routes/auth.ts signup handler only",
        outOfScope: "do not touch the session middleware",
        dependencies: "none",
        risk: "low — single handler, no migration",
        agentPrompt: "1. Add a zod body schema. 2. Return 400 on parse failure. 3. Add a unit test.",
      },
      templateFields: null,
    });
    expect(result.missing).toEqual([]);
  });
});

describe("calculateConfidence — backend parity on the fully sectioned fixture", () => {
  it("scores SECTIONED_DESC identically to the backend (score/missing/blocking)", () => {
    const result = calculateConfidence({
      title: "Return 400 on empty signup body",
      description: SECTIONED_DESC,
      templateData: null,
      templateFields: null,
    });
    // Ground truth from backend/src/lib/confidence.ts over the identical input.
    expect(result.score).toBe(98);
    expect(result.blocking).toBe(false);
    expect(result.missing).toEqual([]);
  });
});
