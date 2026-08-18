import { describe, expect, it } from "vitest";
import {
  calculateConfidence,
  descriptionQuality,
  extractSpecSections,
  deriveNextActions,
  EVALS_KEYSTONE_CAP,
  FIELD_WEIGHTS,
  REQUIRED_SIGNAL_ONLY_CODES,
  type TemplateData,
  type QualityFinding,
} from "./confidence";
import {
  RICH_TEMPLATE_DATA_NO_DESC,
  SECTIONED_DESC,
  CONFIDENCE_PARITY_FIXTURES,
} from "./__fixtures__/confidence-fixtures";

type Input = Parameters<typeof calculateConfidence>[0];
type Result = ReturnType<typeof calculateConfidence>;
// The parity loop asserts the scalar/array scoring outputs; findings[] (the
// prose-bearing, parity-fragile part) is asserted separately below against the
// backend ground-truth so a future mirror edit to buildFindings or the cap-merge
// breaks a test instead of silently drifting.
type Expected = Omit<Result, "findings">;

// ── templateData.goal + context as a description equivalent (ported from the
// backend suite) ─────────────────────────────────────────────────────────────
// RICH_TEMPLATE_DATA_NO_DESC now lives in
// frontend/src/lib/__fixtures__/confidence-fixtures.ts (task 79621590) — it
// was byte-identical to backend's own copy of the same fixture, exactly the
// kind of duplicated literal that can silently drift.
// Both the parity fixture below and the dedicated describe block further
// down still share the exact same imported object.

// `input` for each fixture below is looked up BY NAME from the shared
// corpus (CONFIDENCE_PARITY_FIXTURES) instead of being retyped here:
// retyping created a second copy of each input literal that could silently
// drift from the corpus the parity suite (confidence.parity.test.ts)
// actually exercises. A mutated shared input left every suite green
// because this file's own copy never changed. `expected` stays a local,
// hand-verified ground-truth value; only `input` is shared.
const parityInputByName = Object.fromEntries(
  CONFIDENCE_PARITY_FIXTURES.map((f) => [f.name, f.input] as const),
);

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
    input: parityInputByName["empty"],
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
    input: parityInputByName["title-only-no-desc"],
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
    input: parityInputByName["rich-prose-no-verification"],
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
    input: parityInputByName["rich-prose-with-verification"],
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
    input: parityInputByName["full-strong-with-ac"],
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
    input: parityInputByName["vague-no-anchors"],
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
    input: parityInputByName["template-fields-completeness"],
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
    input: parityInputByName["typed-feature-with-ac"],
    expected: {
      score: 74,
      blocking: false,
      missing: ["scope", "outOfScope", "dependencies", "risk"],
      inferredTaskType: "feature",
      subscores: { completeness: 100, concreteness: 75, testability: 100, scopeClarity: 0, contextQuality: 43, structure: 65, ambiguityRisk: 100 },
    },
  },
  {
    // MEDIUM fix: parity guard. The c71de504 shape (rich templateData.goal +
    // templateData.context, NO literal description) ported into the
    // byte-for-byte backend-ground-truth loop, not just the dedicated
    // describe block further down — a future mirror drift on the MAX-semantics
    // equivalence path fails HERE, in the same loop as every other fixture.
    name: "rich-templatedata-no-desc-c71de504",
    input: parityInputByName["rich-templatedata-no-desc-c71de504"],
    expected: {
      score: 75,
      blocking: false,
      missing: ["outOfScope", "dependencies", "risk"],
      inferredTaskType: undefined,
      subscores: { completeness: 50, concreteness: 0, testability: 100, scopeClarity: 0, contextQuality: 100, structure: 0, ambiguityRisk: 100 },
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

// ── templateData.goal + context as a description equivalent (ported from the
// backend suite) ─────────────────────────────────────────────────────────────
// RICH_TEMPLATE_DATA_NO_DESC is declared once, above FIXTURES, and reused here.
describe("calculateConfidence — templateData.goal + context as description equivalent", () => {
  it("caps at 40 when description is empty AND templateData is empty (negative control)", () => {
    const result = calculateConfidence({
      title: "Some title",
      description: "",
      templateData: null,
      templateFields: null,
    });
    expect(result.score).toBeLessThanOrEqual(40);
    expect(result.findings.find((f) => f.code === "missing_or_thin_description")).toBeDefined();
    expect(result.missing).toContain("description");
  });

  it("does NOT cap at 40 / trigger missing_or_thin_description when templateData.goal + context are substantial (c71de504 repro)", () => {
    const result = calculateConfidence({
      title: "Fix confidence scorer templateData description-equivalence",
      description: "",
      templateData: RICH_TEMPLATE_DATA_NO_DESC,
      templateFields: null,
    });
    expect(result.findings.find((f) => f.code === "missing_or_thin_description")).toBeUndefined();
    expect(result.missing).not.toContain("description");
    // Clears the project default threshold (60) without any text duplicated
    // into `description` — the respec friction this task fixes.
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it("still caps at 40 / triggers missing_or_thin_description when templateData.goal + context are thin one-liners (below the quality threshold combined)", () => {
    const result = calculateConfidence({
      title: "Some title",
      description: "",
      templateData: { goal: "fix", context: "the bug" },
      templateFields: null,
    });
    expect(result.score).toBeLessThanOrEqual(40);
    expect(result.findings.find((f) => f.code === "missing_or_thin_description")).toBeDefined();
    expect(result.missing).toContain("description");
  });

  // ── HIGH fix: gate inversion (reviewer-found mutant) ──────────────────────
  // descEquivalentQuality must use Math.max(descQuality, goal+context quality),
  // never absence-only substitution. Absence-only meant deleting a thin
  // description could RAISE the score by falling back to a richer
  // goal+context equivalent — the exact inversion the reviewer's mutant
  // exercised. Every fixture below shares RICH_TEMPLATE_DATA_NO_DESC and pins
  // the SAME score (75) regardless of what (if anything) sits in description.
  // Ported from the backend suite; scores must match byte-for-byte.

  it("goal-only templateData (no context) contributes only goal's own text to the description equivalent (exact score; a mutant dropping goal from the join array goes red)", () => {
    const result = calculateConfidence({
      title: "Some title",
      description: "",
      templateData: { goal: RICH_TEMPLATE_DATA_NO_DESC.goal },
      templateFields: null,
    });
    expect(result.score).toBe(42);
  });

  it("context-only templateData (no goal) contributes only context's own text to the description equivalent (exact score; a mutant dropping context from the join array goes red)", () => {
    const result = calculateConfidence({
      title: "Some title",
      description: "",
      templateData: { context: RICH_TEMPLATE_DATA_NO_DESC.context },
      templateFields: null,
    });
    expect(result.score).toBe(45);
  });

  it("a present-but-thin description ('x') plus rich templateData scores the SAME as an absent description (MAX semantics, not absence-only)", () => {
    const result = calculateConfidence({
      title: "Fix confidence scorer templateData description-equivalence",
      description: "x",
      templateData: RICH_TEMPLATE_DATA_NO_DESC,
      templateFields: null,
    });
    expect(result.score).toBe(75);
    expect(result.findings.find((f) => f.code === "missing_or_thin_description")).toBeUndefined();
    expect(result.missing).not.toContain("description");
  });

  it("monotonicity guard: on identical rich templateData, an absent description never scores HIGHER than a short one added on top (no gate inversion)", () => {
    const absent = calculateConfidence({
      title: "Fix confidence scorer templateData description-equivalence",
      description: "",
      templateData: RICH_TEMPLATE_DATA_NO_DESC,
      templateFields: null,
    });
    const withShortDesc = calculateConfidence({
      title: "Fix confidence scorer templateData description-equivalence",
      description: "See the goal field.",
      templateData: RICH_TEMPLATE_DATA_NO_DESC,
      templateFields: null,
    });
    expect(withShortDesc.score).toBeGreaterThanOrEqual(absent.score);
  });

  it("a whitespace-only description behaves identically to an absent one (same score/missing/blocking/findings/subscores)", () => {
    const absent = calculateConfidence({
      title: "Fix confidence scorer templateData description-equivalence",
      description: "",
      templateData: RICH_TEMPLATE_DATA_NO_DESC,
      templateFields: null,
    });
    const whitespace = calculateConfidence({
      title: "Fix confidence scorer templateData description-equivalence",
      description: "   \n  ",
      templateData: RICH_TEMPLATE_DATA_NO_DESC,
      templateFields: null,
    });
    expect(whitespace).toEqual(absent);
  });
});

// ── Markdown spec sections (ported from the backend suite) ──────────────────
// The blocks below are a faithful port of backend/tests/unit/confidence.test.ts
// (describe "extractSpecSections" + "markdown spec sections (friction #99)"),
// asserting the mirror parses `##` headings — including the decorated house
// style — exactly like the server. The backend's console.info spy is dropped
// (the frontend scorer has no ops log side effect).

// SECTIONED_DESC now lives in
// frontend/src/lib/__fixtures__/confidence-fixtures.ts (task 79621590) — it
// was byte-identical to backend's own copy of the same fixture.

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

// ── Milestone 2: per-type required signals (task 6b88ec87, ported from the
// backend suite) ─────────────────────────────────────────────────────────────
// The required-signal matrix from the overlay's "Task-Type-Aware Scoring"
// section, keyed on the EXPLICIT templateData.taskType only. Faithful port of
// backend/tests/unit/confidence.test.ts's identically-named describe block;
// keep the fixtures in sync.
describe("calculateConfidence: required signals per taskType (M2)", () => {
  // The genuinely type-specific codes (no universal MISS_FINDINGS alias —
  // see confidence.ts's REQUIRED_SIGNALS_BY_TYPE header comment), for the
  // backward-compat forbidden-list test below. Sourced directly from the
  // implementation's own export (FAITHFUL MIRROR of the backend test) rather
  // than a hand-maintained duplicate list.
  const ALL_REQUIRED_SIGNAL_CODES = [...REQUIRED_SIGNAL_ONLY_CODES];

  describe("bugfix", () => {
    const ALL_SIX_DESC = [
      "Actual behavior: the endpoint returns 500 for empty bodies.",
      "Expected behavior: it should return 400 instead.",
      "Steps to reproduce: 1. POST /signup with an empty body. 2. Observe the 500.",
      "Error message: TypeError: Cannot read property 'email' of undefined.",
      "Affected environment: Node 20 on macOS Sonoma.",
    ].join(" ");
    const templateData = { acceptanceCriteria: "- returns 400 on empty body", taskType: "bugfix" as const };

    it("all six signals present -> no bugfix required-signal findings", () => {
      const result = calculateConfidence({ title: "ok", description: ALL_SIX_DESC, templateData, templateFields: null });
      for (const code of ["missing_actual_behavior", "missing_expected_behavior", "missing_reproduction_steps", "missing_error_message_or_symptom", "missing_affected_environment", "missing_acceptance_criteria"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });

    it("reproduction steps missing -> missing_reproduction_steps, blocking, no other bugfix code fires", () => {
      const description = [
        "Actual behavior: the endpoint returns 500 for empty bodies.",
        "Expected behavior: it should return 400 instead.",
        "Error message: TypeError: Cannot read property 'email' of undefined.",
        "Affected environment: Node 20 on macOS Sonoma.",
      ].join(" ");
      const result = calculateConfidence({ title: "ok", description, templateData, templateFields: null });
      const finding = result.findings.find((f) => f.code === "missing_reproduction_steps");
      expect(finding?.severity).toBe("blocking");
      for (const code of ["missing_actual_behavior", "missing_expected_behavior", "missing_error_message_or_symptom", "missing_affected_environment", "missing_acceptance_criteria"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });
  });

  describe("feature", () => {
    const DESC = "Add a new API endpoint that returns CSV. The UX shows a Download button; the API request/response contract is documented below.";

    it("all six signals present -> no feature required-signal findings", () => {
      const result = calculateConfidence({
        title: "ok",
        description: DESC,
        templateData: {
          goal: "Let users export their data as CSV",
          scope: "src/routes/export.ts",
          acceptanceCriteria: "- GET /export returns a CSV file",
          constraints: "Must not change the existing JSON export endpoint",
          taskType: "feature",
        },
        templateFields: null,
      });
      for (const code of ["missing_goal", "missing_scope", "missing_acceptance_criteria", "missing_constraints", "missing_ux_api_expectations"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });

    it("constraints missing -> missing_constraints, blocking, no other feature code fires", () => {
      const result = calculateConfidence({
        title: "ok",
        description: DESC,
        templateData: {
          goal: "Let users export their data as CSV",
          scope: "src/routes/export.ts",
          acceptanceCriteria: "- GET /export returns a CSV file",
          taskType: "feature",
        },
        templateFields: null,
      });
      const finding = result.findings.find((f) => f.code === "missing_constraints");
      expect(finding?.severity).toBe("blocking");
      for (const code of ["missing_goal", "missing_scope", "missing_acceptance_criteria", "missing_ux_api_expectations"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });

    it("dedup: scope missing escalates the EXISTING universal missing_scope finding to blocking instead of adding a second entry", () => {
      const result = calculateConfidence({
        title: "ok",
        description: DESC,
        templateData: {
          goal: "Let users export their data as CSV",
          acceptanceCriteria: "- GET /export returns a CSV file",
          constraints: "Must not change the existing JSON export endpoint",
          taskType: "feature",
        },
        templateFields: null,
      });
      const scopeFindings = result.findings.filter((f) => f.code === "missing_scope");
      expect(scopeFindings).toHaveLength(1);
      expect(scopeFindings[0]?.severity).toBe("blocking");
    });
  });

  describe("refactoring", () => {
    const templateData = {
      scope: "src/services/parser.ts",
      outOfScope: "Do not change the public parse() signature",
      risk: "Low: internal-only refactor",
      taskType: "refactoring" as const,
    };
    const ALL_SIX_DESC = [
      "Purpose: simplify the internal parsing logic for readability.",
      "Behavior preservation: the refactor is functionally equivalent; no behavior change for callers.",
      "Regression strategy: the existing test suite covers every branch, and CI must stay green.",
    ].join(" ");

    it("all six signals present -> no refactoring required-signal findings", () => {
      const result = calculateConfidence({ title: "ok", description: ALL_SIX_DESC, templateData, templateFields: null });
      for (const code of ["missing_purpose", "missing_scope", "missing_out_of_scope", "missing_behavior_preservation", "missing_regression_strategy", "missing_risk"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });

    it("purpose missing -> missing_purpose, blocking, no other refactoring code fires", () => {
      const description = [
        "Behavior preservation: the refactor is functionally equivalent; no behavior change for callers.",
        "Regression strategy: the existing test suite covers every branch, and CI must stay green.",
      ].join(" ");
      const result = calculateConfidence({ title: "ok", description, templateData, templateFields: null });
      const finding = result.findings.find((f) => f.code === "missing_purpose");
      expect(finding?.severity).toBe("blocking");
      for (const code of ["missing_scope", "missing_out_of_scope", "missing_behavior_preservation", "missing_regression_strategy", "missing_risk"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });
  });

  describe("security", () => {
    const templateData = {
      constraints: "No new endpoints; only modify existing auth middleware",
      acceptanceCriteria: "- Rate limiting blocks after 5 failed attempts",
      taskType: "security" as const,
    };
    const ALL_SIX_DESC = [
      "Security goal: harden the authentication flow against replay abuse.",
      "Affected asset: the user session cookie.",
      "Threat: an attacker could exploit a race condition.",
      "Review requirement: get sign-off from the tech lead before merging.",
      "Rollback: revert the feature flag if problems appear.",
    ].join(" ");

    it("all seven signals present -> no security required-signal findings", () => {
      const result = calculateConfidence({ title: "ok", description: ALL_SIX_DESC, templateData, templateFields: null });
      for (const code of ["missing_security_goal", "missing_affected_asset", "missing_threat_or_risk", "missing_constraints", "missing_review_requirement", "missing_acceptance_criteria", "missing_rollback"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });

    it("affected asset missing -> missing_affected_asset, blocking, no other security code fires", () => {
      const description = [
        "Security goal: harden the authentication flow against replay abuse.",
        "Threat: an attacker could exploit a race condition.",
        "Review requirement: get sign-off from the tech lead before merging.",
        "Rollback: revert the feature flag if problems appear.",
      ].join(" ");
      const result = calculateConfidence({ title: "ok", description, templateData, templateFields: null });
      const finding = result.findings.find((f) => f.code === "missing_affected_asset");
      expect(finding?.severity).toBe("blocking");
      for (const code of ["missing_security_goal", "missing_threat_or_risk", "missing_constraints", "missing_review_requirement", "missing_acceptance_criteria", "missing_rollback"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });
  });

  describe("migration", () => {
    const templateData = { acceptanceCriteria: "- migration completes without data loss and API responses are unchanged", taskType: "migration" as const };
    const ALL_SIX_DESC = [
      "Current state: data lives in the legacy MySQL table.",
      "Target state: data lives in the new Postgres table.",
      "Compatibility: the read API stays backward compatible during the migration.",
      "Rollback: revert to the legacy table if issues arise.",
      "Deployment impact: requires a maintenance window with brief downtime.",
      "Operational risk: on-call must monitor replication lag; blast radius is limited to the users service.",
    ].join(" ");

    it("all seven signals present -> no migration required-signal findings", () => {
      const result = calculateConfidence({ title: "ok", description: ALL_SIX_DESC, templateData, templateFields: null });
      for (const code of ["missing_current_state", "missing_target_state", "missing_compatibility", "missing_rollback", "missing_deployment_impact", "missing_acceptance_criteria", "missing_operational_risk"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });

    it("current state missing -> missing_current_state, blocking, no other migration code fires", () => {
      const description = [
        "Target state: data lives in the new Postgres table.",
        "Compatibility: the read API stays backward compatible during the migration.",
        "Rollback: revert to the legacy table if issues arise.",
        "Deployment impact: requires a maintenance window with brief downtime.",
        "Operational risk: on-call must monitor replication lag; blast radius is limited to the users service.",
      ].join(" ");
      const result = calculateConfidence({ title: "ok", description, templateData, templateFields: null });
      const finding = result.findings.find((f) => f.code === "missing_current_state");
      expect(finding?.severity).toBe("blocking");
      for (const code of ["missing_target_state", "missing_compatibility", "missing_rollback", "missing_deployment_impact", "missing_acceptance_criteria", "missing_operational_risk"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });

    // ── Finding 4 (review round 2): word-boundary fix pin ────────────────────
    // `\bcompat...\b` never matched "incompatible" (no word boundary between
    // "in" and "compat"); the `(in)?` group at confidence.ts's
    // missing_compatibility entry fixes that. Positive-only: this fixture
    // does not need every other migration signal stated, it only pins that
    // "incompatible" alone satisfies compatibility. A revert of `(in)?compat`
    // back to bare `compat` turns this red.
    it("'incompatible' alone satisfies missing_compatibility (word-boundary fix pin, finding 4)", () => {
      const result = calculateConfidence({
        title: "ok",
        description: "The new API response format is incompatible with clients built against the old one.",
        templateData: { taskType: "migration" },
        templateFields: null,
      });
      expect(result.findings.find((f) => f.code === "missing_compatibility")).toBeUndefined();
    });

    // ── Finding 6 (review round 2): residual vacuity fix pin ─────────────────
    // Bare `\bcurrently\b` used to match ANY sentence containing the word,
    // regardless of whether it described a state. "Nothing is currently
    // broken." trivially satisfied missing_current_state before the
    // stateful-verb tightening. A revert of that tightening turns this red.
    it("'Nothing is currently broken.' does not satisfy missing_current_state (residual-vacuity fix pin, finding 6)", () => {
      const result = calculateConfidence({
        title: "ok",
        description: "Nothing is currently broken.",
        templateData: { taskType: "migration" },
        templateFields: null,
      });
      expect(result.findings.find((f) => f.code === "missing_current_state")).toBeDefined();
    });
  });

  describe("docs", () => {
    const templateData = { scope: "docs/api-reference.md only", acceptanceCriteria: "- doc reviewed and merged with no broken links", taskType: "docs" as const };
    const ALL_SIX_DESC = [
      "Target audience: new backend engineers onboarding to the service.",
      "Source of truth: this doc reflects the canonical API contract in openapi.yaml.",
      "Format: written in Markdown following the existing docs style.",
      "Review owner: reviewed by the platform tech lead before merge.",
    ].join(" ");

    it("all six signals present -> no docs required-signal findings", () => {
      const result = calculateConfidence({ title: "ok", description: ALL_SIX_DESC, templateData, templateFields: null });
      for (const code of ["missing_target_audience", "missing_source_of_truth", "missing_scope", "missing_format", "missing_acceptance_criteria", "missing_review_owner"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });

    it("target audience missing -> missing_target_audience, blocking, no other docs code fires", () => {
      const description = [
        "Source of truth: this doc reflects the canonical API contract in openapi.yaml.",
        "Format: written in Markdown following the existing docs style.",
        "Review owner: reviewed by the platform tech lead before merge.",
      ].join(" ");
      const result = calculateConfidence({ title: "ok", description, templateData, templateFields: null });
      const finding = result.findings.find((f) => f.code === "missing_target_audience");
      expect(finding?.severity).toBe("blocking");
      for (const code of ["missing_source_of_truth", "missing_scope", "missing_format", "missing_acceptance_criteria", "missing_review_owner"]) {
        expect(result.findings.find((f) => f.code === code)).toBeUndefined();
      }
    });

    // ── Finding 6 (review round 2): residual vacuity fix pins ────────────────
    // Bare `\breaders?\b` used to match ANY sentence mentioning "readers" at
    // all, regardless of whether it named an audience. "The new schema is
    // incompatible with the old readers." trivially satisfied
    // missing_target_audience before the qualifying-clause tightening (it
    // also incidentally contains "incompatible", separate from the fix this
    // pins — this sentence tests target_audience only). A revert of that
    // tightening turns this red.
    it("'The new schema is incompatible with the old readers.' does not satisfy missing_target_audience (residual-vacuity fix pin, finding 6)", () => {
      const result = calculateConfidence({
        title: "ok",
        description: "The new schema is incompatible with the old readers.",
        templateData: { taskType: "docs" },
        templateFields: null,
      });
      expect(result.findings.find((f) => f.code === "missing_target_audience")).toBeDefined();
    });

    // Bare `\bowner:\b` used to match a non-answer line like "Owner: nobody
    // in particular." — the label was present but named no one. The negative
    // lookahead in missing_review_owner's `owner:` alternative rejects a
    // small set of known negations right after the colon. A revert of that
    // tightening turns this red.
    it("'Owner: nobody in particular.' does not satisfy missing_review_owner (residual-vacuity fix pin, finding 6)", () => {
      const result = calculateConfidence({
        title: "ok",
        description: "Owner: nobody in particular.",
        templateData: { taskType: "docs" },
        templateFields: null,
      });
      expect(result.findings.find((f) => f.code === "missing_review_owner")).toBeDefined();
    });

    // Positive control for the same tightening: a genuine "Owner: <name>"
    // line (the common real-world shorthand, no "review owner"/"reviewed by"
    // phrasing) must still satisfy the signal — the negative lookahead only
    // rejects the specific negation words, not every word.
    it("'Owner: Jane from the platform team.' satisfies missing_review_owner (negative-lookahead does not overcorrect)", () => {
      const result = calculateConfidence({
        title: "ok",
        description: "Owner: Jane from the platform team.",
        templateData: { taskType: "docs" },
        templateFields: null,
      });
      expect(result.findings.find((f) => f.code === "missing_review_owner")).toBeUndefined();
    });
  });

  it("backward compat: unset taskType never emits a required-signal finding, even over a description that would trip several if a taskType were set (pin)", () => {
    const description = "Actual behavior: the endpoint returns 500. Steps to reproduce: POST with an empty body.";
    const result = calculateConfidence({
      title: "ok",
      description,
      templateData: { acceptanceCriteria: "- returns 400" }, // no taskType
      templateFields: null,
    });
    expect(result.inferredTaskType).toBeUndefined();
    for (const code of ALL_REQUIRED_SIGNAL_CODES) {
      expect(result.findings.find((f) => f.code === code)).toBeUndefined();
    }
  });

  // ── Finding 1 (review round 1): runtime guard on the taskType lookup ──────
  // FAITHFUL MIRROR of the backend test of the same name. The frontend always
  // builds `templateData` from its own typed API responses, but the guard is
  // mirrored anyway so both copies stay behaviorally identical for any input.
  describe("runtime guard: taskType is not a compile-time guarantee (finding 1)", () => {
    const UNGUARDED_DESC = "some description with enough words to be non-trivial and concrete src/foo.ts";

    it("an out-of-enum taskType STRING yields exactly the untyped findings set, no throw", () => {
      const untyped = calculateConfidence({
        title: "ok",
        description: UNGUARDED_DESC,
        templateData: { acceptanceCriteria: "- x" },
        templateFields: null,
      });
      expect(() =>
        calculateConfidence({
          title: "ok",
          description: UNGUARDED_DESC,
          templateData: { acceptanceCriteria: "- x", taskType: "chore" } as unknown as TemplateData,
          templateFields: null,
        }),
      ).not.toThrow();
      const result = calculateConfidence({
        title: "ok",
        description: UNGUARDED_DESC,
        templateData: { acceptanceCriteria: "- x", taskType: "chore" } as unknown as TemplateData,
        templateFields: null,
      });
      expect(result.findings).toEqual(untyped.findings);
    });

    // Finding 1 (review round 2): the own-property lookup fix must also be
    // pinned against every inherited key REQUIRED_SIGNALS_BY_TYPE's plain
    // object literal exposes via the prototype chain — these five strings
    // are exactly what made `.filter` throw before the fix (a `typeof ===
    // "string"` guard alone does not catch them; only own-property
    // confirmation does). FAITHFUL MIRROR of the backend test.
    it.each([
      ["number", 1],
      ["boolean", false],
      ["object", {}],
      ["array", ["bugfix"]],
      ["prototype-chain key: constructor", "constructor"],
      ["prototype-chain key: __proto__", "__proto__"],
      ["prototype-chain key: toString", "toString"],
      ["prototype-chain key: hasOwnProperty", "hasOwnProperty"],
      ["prototype-chain key: valueOf", "valueOf"],
    ])("a non-conforming taskType (%s) yields exactly the untyped findings set, no throw", (_label, badTaskType) => {
      const untyped = calculateConfidence({
        title: "ok",
        description: UNGUARDED_DESC,
        templateData: { acceptanceCriteria: "- x" },
        templateFields: null,
      });
      expect(() =>
        calculateConfidence({
          title: "ok",
          description: UNGUARDED_DESC,
          templateData: { acceptanceCriteria: "- x", taskType: badTaskType } as unknown as TemplateData,
          templateFields: null,
        }),
      ).not.toThrow();
      const result = calculateConfidence({
        title: "ok",
        description: UNGUARDED_DESC,
        templateData: { acceptanceCriteria: "- x", taskType: badTaskType } as unknown as TemplateData,
        templateFields: null,
      });
      expect(result.findings).toEqual(untyped.findings);
    });
  });

  // ── Finding 2 (review round 1): dedup regression ───────────────────────────
  // FAITHFUL MIRROR of the backend test of the same name.
  describe("dedup regression: no two findings in one result share the same suggestion string (finding 2)", () => {
    it.each(["bugfix", "feature", "refactoring", "security", "migration", "docs"] as const)(
      "%s: a bare title-only task has no two findings with the same suggestion",
      (taskType) => {
        const result = calculateConfidence({
          title: "ok",
          description: "",
          templateData: { taskType },
          templateFields: null,
        });
        const suggestions = result.findings.map((f) => f.suggestion).filter((s): s is string => !!s);
        expect(new Set(suggestions).size).toBe(suggestions.length);
      },
    );
  });
});

// ── Finding 3 (review round 1): required-signal regex quality ───────────────
// FAITHFUL MIRROR of the backend describe block of the same name — see that
// file for the full rationale. Each type gets two honest, flowing-prose
// fixtures (no "Label:" colon-headers, no bullet keyword-stuffing): (a) a
// natural paragraph stating every required signal, which must produce ZERO
// required-signal findings, and (b) content-free junk filler, which MUST
// still trip every required signal for that type.
//
// R2 finding 4 (softened claim, mirrored): of the 8 words/phrases R1 actually
// dropped from these regexes, only ONE was pinned by a junk sentence going
// in — security's bare "risk". The other 7 reverted cleanly (no test went
// red): bugfix affected_environment's dropped "version", feature
// ux_api_expectations' dropped "request", refactoring purpose's dropped
// "reason for", security missing_security_goal's dropped bare "secure" and
// missing_affected_asset's dropped "resources", and migration's dropped
// "today" (current_state) and "release" (deployment_impact). Each junk
// fixture below now also carries its type's specific dropped word(s) as an
// EXTRA regression guard (mirrored from the backend test, which records
// which reverts were mutation-verified).
describe("calculateConfidence: required-signal regex quality (finding 3)", () => {
  const CASES: Record<
    "bugfix" | "feature" | "refactoring" | "security" | "migration" | "docs",
    {
      codes: string[];
      present: { description: string; templateData: TemplateData };
      junk: { description: string; templateData: TemplateData };
    }
  > = {
    bugfix: {
      codes: [
        "missing_actual_behavior", "missing_expected_behavior", "missing_reproduction_steps",
        "missing_error_message_or_symptom", "missing_affected_environment", "missing_acceptance_criteria",
      ],
      present: {
        description:
          "The actual behavior when the signup form submits an empty email is that the server throws an unhandled exception and the request hangs forever, while the expected behavior is a clean 400 response telling the user the email is required. Reproducing it is straightforward on the Chrome browser and Node 20 macOS Sonoma: open the signup page, leave the email box blank, and hit submit.",
        templateData: { acceptanceCriteria: "- POST /signup with an empty email returns 400", taskType: "bugfix" },
      },
      junk: {
        // Deliberately contains the bare word "version" — the regression
        // guard for the dropped bare-"version" alternative on
        // missing_affected_environment (only `\bnode\s+v?\d\b`, a version
        // NUMBER, is accepted; a bare word "version" naming no number or
        // platform must not satisfy it).
        description: "There is a problem with the signup flow. It should be fixed soon, whichever version this is. This is important for users.",
        templateData: { taskType: "bugfix" },
      },
    },
    feature: {
      codes: ["missing_goal", "missing_scope", "missing_acceptance_criteria", "missing_constraints", "missing_ux_api_expectations"],
      present: {
        description:
          "Users will see a new Export button in the UI that calls the reporting API endpoint and returns a CSV file; the response includes a Content-Disposition header naming the file.",
        templateData: {
          goal: "Let users export their data as CSV",
          scope: "src/routes/export.ts",
          acceptanceCriteria: "- GET /export returns a CSV file",
          constraints: "Must not change the existing JSON export endpoint",
          taskType: "feature",
        },
      },
      junk: {
        // Deliberately contains the bare word "request" — the regression
        // guard for the dropped bare-"request" alternative on
        // missing_ux_api_expectations (a bare "request" names no API/UX
        // concept and must not satisfy it).
        description: "This feature would be nice to have on request. It should work well for everyone. There is some risk here.",
        templateData: { taskType: "feature" },
      },
    },
    refactoring: {
      codes: ["missing_purpose", "missing_scope", "missing_out_of_scope", "missing_behavior_preservation", "missing_regression_strategy", "missing_risk"],
      present: {
        description:
          "The purpose of this change is to make the parser easier to maintain; it is functionally equivalent to the current implementation, so callers will see no behavior change. The existing test suite already covers every parsing branch, so regressions will be caught automatically.",
        templateData: {
          scope: "src/services/parser.ts",
          outOfScope: "Do not change the public parse() signature",
          risk: "Low: internal-only refactor",
          taskType: "refactoring",
        },
      },
      junk: {
        // Deliberately contains the phrase "reason for" — the regression
        // guard for the dropped bare-"reason" alternative on missing_purpose
        // (a "reason for X" clause that never says WHY the refactor is worth
        // doing must not satisfy it).
        description: "This code could be cleaner. There is a reason for touching it, but it would be good practice to improve it. There is some risk here.",
        templateData: { taskType: "refactoring" },
      },
    },
    security: {
      codes: [
        "missing_security_goal", "missing_affected_asset", "missing_threat_or_risk",
        "missing_constraints", "missing_review_requirement", "missing_acceptance_criteria", "missing_rollback",
      ],
      present: {
        description:
          "This change aims to harden the login flow against a credential-stuffing threat, addressing a vulnerability where an attacker could exploit repeated failed logins to guess passwords -- real threat mitigation for account takeover. The session token is the credential at risk. Get sign-off from the security lead before merging, and if anything goes wrong, roll back the feature flag.",
        templateData: {
          constraints: "No new endpoints; only modify the existing login middleware",
          acceptanceCriteria: "- Login blocks after 5 failed attempts within 60 seconds",
          taskType: "security",
        },
      },
      junk: {
        // Deliberately contains the bare words "risk" (regression guard for
        // the dropped `\brisks?\b` alternative on missing_threat_or_risk),
        // "secure" with no goal-ish object noun (regression guard for the
        // dropped bare `\bsecur(e|ity)\b` alternative on
        // missing_security_goal), and "resources" (regression guard for the
        // dropped bare-"resources" alternative on missing_affected_asset —
        // none of assets/endpoints/credentials/tokens/secrets is a
        // substring of it).
        description: "This change makes things secure using various resources. It is a good idea to fix this soon. There is some risk here.",
        templateData: { taskType: "security" },
      },
    },
    migration: {
      codes: [
        "missing_current_state", "missing_target_state", "missing_compatibility",
        "missing_rollback", "missing_deployment_impact", "missing_acceptance_criteria", "missing_operational_risk",
      ],
      present: {
        description:
          "The users table currently lives on the legacy MySQL instance; after the migration it will live on the new Postgres cluster instead. The read API stays backward compatible throughout the cutover, and if anything breaks we can roll back to the legacy table. The cutover requires a short maintenance window, so on-call should watch replication lag and be ready to page if the blast radius grows beyond the users service.",
        templateData: {
          acceptanceCriteria: "- users table reads/writes succeed against the new backend",
          taskType: "migration",
        },
      },
      junk: {
        // Deliberately contains the bare words "today" (regression guard for
        // the dropped bare-"today" alternative on missing_current_state —
        // "today" names no state, current or otherwise) and "release"
        // (regression guard for the dropped bare-"release" alternative on
        // missing_deployment_impact — only deploy(ment)/downtime/cutover are
        // accepted).
        description: "This migration should go smoothly today after the release. It is a good idea to do this soon. There is some risk here.",
        templateData: { taskType: "migration" },
      },
    },
    docs: {
      codes: ["missing_target_audience", "missing_source_of_truth", "missing_scope", "missing_format", "missing_acceptance_criteria", "missing_review_owner"],
      present: {
        description:
          "This doc is aimed at backend engineers who are new to the confidence scorer; readers should come away knowing how the required-signal matrix works. It reflects the canonical matrix defined in confidence.ts, so it stays the authoritative reference. It will be written in Markdown as a new docs section, and it needs to be reviewed by the platform tech lead before merging.",
        templateData: {
          scope: "docs/confidence-scorer.md only",
          acceptanceCriteria: "- doc reviewed and merged with no broken links",
          taskType: "docs",
        },
      },
      junk: {
        description: "This doc would be helpful. It should be written soon. There is some risk here.",
        templateData: { taskType: "docs" },
      },
    },
  };

  for (const [taskType, spec] of Object.entries(CASES)) {
    describe(taskType, () => {
      it("natural prose stating every signal produces zero required-signal findings for this type", () => {
        const result = calculateConfidence({
          title: "ok",
          description: spec.present.description,
          templateData: spec.present.templateData,
          templateFields: null,
        });
        for (const code of spec.codes) {
          expect(result.findings.find((f) => f.code === code)).toBeUndefined();
        }
      });

      it("content-free junk prose still trips every required signal for this type", () => {
        const result = calculateConfidence({
          title: "ok",
          description: spec.junk.description,
          templateData: spec.junk.templateData,
          templateFields: null,
        });
        for (const code of spec.codes) {
          expect(result.findings.find((f) => f.code === code)).toBeDefined();
        }
      });
    });
  }
});

// ── deriveNextActions (M4, task 67526c1c: ImprovementPanel) ─────────────────
// FAITHFUL MIRROR of deriveNextActions in
// backend/src/services/claim-policy-evaluator.ts; the first frontend
// consumer of REQUIRED_SIGNAL_ONLY_CODES (previously only kept for future
// parity, per its own header comment). GET /tasks/:id/instructions returns
// `findings[]` but no precomputed `nextActions[]`, so the ImprovementPanel
// derives it client-side with this function.
describe("deriveNextActions", () => {
  function finding(over: Partial<QualityFinding> & Pick<QualityFinding, "code" | "severity">): QualityFinding {
    return {
      dimension: "completeness",
      message: `${over.code} message`,
      suggestion: `${over.code} suggestion`,
      ...over,
    };
  }

  it("sorts blocking before warning before info", () => {
    const findings = [
      finding({ code: "c_info", severity: "info" }),
      finding({ code: "a_blocking", severity: "blocking" }),
      finding({ code: "b_warning", severity: "warning" }),
    ];
    expect(deriveNextActions(findings)).toEqual([
      "a_blocking suggestion",
      "b_warning suggestion",
      "c_info suggestion",
    ]);
  });

  it("within a severity tier, ranks a universal finding ahead of a type-specific-only one", () => {
    // missing_goal is universal (aliased); missing_reproduction_steps is
    // bugfix-only and lives in REQUIRED_SIGNAL_ONLY_CODES.
    expect(REQUIRED_SIGNAL_ONLY_CODES.has("missing_reproduction_steps")).toBe(true);
    expect(REQUIRED_SIGNAL_ONLY_CODES.has("missing_goal")).toBe(false);

    const findings = [
      finding({ code: "missing_reproduction_steps", severity: "blocking" }),
      finding({ code: "missing_goal", severity: "blocking" }),
    ];
    expect(deriveNextActions(findings)).toEqual([
      "missing_goal suggestion",
      "missing_reproduction_steps suggestion",
    ]);
  });

  it("deduplicates by suggestion text", () => {
    const findings = [
      finding({ code: "a", severity: "warning", suggestion: "same suggestion" }),
      finding({ code: "b", severity: "warning", suggestion: "same suggestion" }),
    ];
    expect(deriveNextActions(findings)).toEqual(["same suggestion"]);
  });

  it("skips findings with no suggestion", () => {
    const findings = [
      finding({ code: "a", severity: "warning", suggestion: undefined }),
      finding({ code: "b", severity: "warning" }),
    ];
    expect(deriveNextActions(findings)).toEqual(["b suggestion"]);
  });

  it("caps the result at 5", () => {
    const findings = Array.from({ length: 8 }, (_, i) =>
      finding({ code: `f${i}`, severity: "warning" }),
    );
    expect(deriveNextActions(findings)).toHaveLength(5);
  });

  it("returns an empty array for no findings", () => {
    expect(deriveNextActions([])).toEqual([]);
  });
});
