import { describe, expect, it } from "vitest";
import { calculateConfidence, descriptionQuality, FIELD_WEIGHTS } from "./confidence";

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
      missing: ["goal", "acceptanceCriteria", "scope", "outOfScope", "dependencies", "risk", "agentPrompt"],
      inferredTaskType: undefined,
      subscores: { completeness: 100, concreteness: 100, testability: 0, scopeClarity: 0, contextQuality: 67, structure: 65, ambiguityRisk: 100 },
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
      score: 62,
      blocking: false,
      missing: ["goal", "acceptanceCriteria", "scope", "outOfScope", "dependencies", "risk", "agentPrompt"],
      inferredTaskType: undefined,
      subscores: { completeness: 100, concreteness: 75, testability: 60, scopeClarity: 0, contextQuality: 70, structure: 65, ambiguityRisk: 100 },
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
      subscores: { completeness: 100, concreteness: 100, testability: 100, scopeClarity: 100, contextQuality: 54, structure: 65, ambiguityRisk: 100 },
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
      score: 51,
      blocking: true,
      missing: ["goal", "acceptanceCriteria", "scope", "outOfScope", "dependencies", "risk", "agentPrompt"],
      inferredTaskType: undefined,
      subscores: { completeness: 33, concreteness: 75, testability: 0, scopeClarity: 0, contextQuality: 54, structure: 65, ambiguityRisk: 100 },
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
      score: 68,
      blocking: false,
      missing: ["goal", "scope", "outOfScope", "dependencies", "risk"],
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
 *  - rich-prose-with-verification: the keystone DOWNGRADE — missing_acceptance_criteria
 *    drops from blocking-keystone to a plain warning with a different message when
 *    the description carries a verification signal.
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
    { code: "missing_goal", severity: "warning", dimension: "completeness", message: "Goal is missing.", suggestion: "Add a one-line Goal stating the intended outcome." },
    { code: "missing_acceptance_criteria", severity: "warning", dimension: "testability", message: "No structured acceptance criteria; the description's verification signal is the only evals path.", suggestion: "Add 2-5 bullets describing observable completion conditions (the task's evals)." },
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

  it("the AC keystone is blocking without a verification signal but downgrades to a warning with one", () => {
    const noVerify = calculateConfidence(byName["rich-prose-no-verification"]);
    const acNoVerify = noVerify.findings.find((f) => f.code === "missing_acceptance_criteria");
    expect(acNoVerify?.severity).toBe("blocking");
    expect(acNoVerify?.keystone).toBe(true);

    const withVerify = calculateConfidence(byName["rich-prose-with-verification"]);
    const acWithVerify = withVerify.findings.find((f) => f.code === "missing_acceptance_criteria");
    expect(acWithVerify?.severity).toBe("warning");
    expect(acWithVerify?.keystone).toBeUndefined();
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
