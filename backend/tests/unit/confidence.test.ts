/**
 * Unit tests for `backend/src/lib/confidence.ts`.
 *
 * scorer-v2 (T3) re-weights the additive score onto a FIXED, template-independent
 * denominator (FIELD_WEIGHTS sum 100) and introduces the evals keystone. The
 * tests cover:
 *  - `descriptionQuality()` heuristic bins (unchanged)
 *  - the fixed-denominator additive score (template-independence, probe flips)
 *  - the evals keystone (blocking, sub-60 cap, threshold-independent emission)
 *  - the agentPrompt keystone (warning-only, not blocking, not sub-60)
 *  - the remaining structural + subscore caps
 *  - all seven subscores reach 0 / partial / 100 with a fixture (unchanged)
 *  - findings emission per missing field with the expected severity
 *  - the T2 field schemas (unchanged) + the M2 taskType bridge
 *
 * Pure function under test, no Prisma or HTTP setup required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  descriptionQuality,
  calculateConfidence,
  extractSpecSections,
  templateDataSchema,
  templatePresetSchema,
  taskTemplateSchema,
  prefersSchema,
  FIELD_WEIGHTS,
  EVALS_KEYSTONE_CAP,
  TEMPLATE_DATA_FIELD_MAX_CHARS,
  REQUIRED_SIGNAL_ONLY_CODES,
  resolveEffectiveThreshold,
  taskTypeThresholdsSchema,
  GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD,
  SUGGESTED_TASK_TYPE_THRESHOLDS,
  RISK_MODIFIER_NAMES,
  detectRiskModifierTriggers,
  resolveTriggeredRiskModifiers,
  type TaskQualitySubscores,
  type TaskType,
} from "../../src/lib/confidence.js";
import {
  RICH_TEMPLATE_DATA_NO_DESC,
  SECTIONED_DESC,
} from "../../../frontend/src/lib/__fixtures__/confidence-fixtures.js";

const FULL_FIELDS = {
  goal: true,
  acceptanceCriteria: true,
  context: true,
  constraints: true,
};

// Legacy v1 fixture: goal / AC / context / constraints. Used by the unchanged
// subscore + M2 tests (computeSubscores still reads these fields).
const ALL_FILLED = {
  goal: "Add validation to user signup",
  acceptanceCriteria: "- Returns 400 on empty email\n- Returns 201 on valid",
  context: "Users currently hit a 500 when posting empty body",
  constraints: "No DB migration; keep existing schema",
};

// scorer-v2 fixture: all nine SCORED fields present (legacy context/constraints
// kept to prove they no longer move the score).
const ALL_V2 = {
  goal: "Validate the signup request body",
  acceptanceCriteria: "- Returns 400 on empty email\n- Returns 201 on a valid body",
  scope: "src/routes/auth.ts signup handler only",
  outOfScope: "do not touch the session middleware",
  dependencies: "none",
  risk: "low — single handler, no migration",
  agentPrompt: "1. Add a zod body schema. 2. Return 400 on parse failure. 3. Add a unit test.",
  context: "Posting an empty body 500s today",
  constraints: "No DB migration",
};

// RICH_TEMPLATE_DATA_NO_DESC now lives in
// frontend/src/lib/__fixtures__/confidence-fixtures.ts (task 79621590) — it
// was byte-identical to frontend's own copy of the same
// fixture, exactly the kind of duplicated literal that can silently drift.

// Concrete description with NO verification word (test/run/curl/check/verify/
// green/CI), so fixtures control the verification signal purely via the
// acceptanceCriteria field.
const CONCRETE_DESC = "Add `validateSignup()` in src/routes/auth.ts:42 returning 400 on an empty body";

// Concrete but no acceptance criteria and no verification signal → evals keystone.
const NO_VERIF_DESC = "Refactor the signup handler in src/routes/auth.ts to extract body validation";

// Concrete AND carries a prose verification signal (`curl`, "Verify"), still no AC.
const VERIF_DESC = "Verify via `curl /api/signup` that src/routes/auth.ts returns 400 on an empty body";

// High-quality, structured description (multi-line, bullets, anchors, a verify
// signal). Under the prose-first weights `description` is dominant, so a
// genuinely complete task needs a rich description like this to score near 100.
const RICH_DESC = [
  "Add a `requestId` middleware in src/middleware/request-id.ts that attaches a UUID to every response.",
  "- Wire it into app.ts before the router so all routes inherit it.",
  "- Verify with `curl -i /api/health` that the response carries an x-request-id header; expect 200.",
  "See the tracing notes at https://example.com/rfc/1234 for the header format.",
].join("\n");

describe("descriptionQuality", () => {
  it("returns 0 for empty input", () => {
    expect(descriptionQuality("")).toBe(0);
    expect(descriptionQuality("   ")).toBe(0);
  });

  it("rewards length up to ~300 chars then caps", () => {
    const sentence = "Validation endpoint POST signup email schema error 400 ";
    const short = descriptionQuality(sentence);
    const long = descriptionQuality(sentence.repeat(6));
    const longer = descriptionQuality(sentence.repeat(60));
    expect(long).toBeGreaterThan(short);
    expect(longer).toBeLessThanOrEqual(1);
  });

  it("rewards information density (non-stopword ratio)", () => {
    const stopword = descriptionQuality("the the the the the the the the the the the the");
    const dense = descriptionQuality("validation signup email POST endpoint 400 schema migration");
    expect(dense).toBeGreaterThan(stopword);
  });

  it("rewards structural markers (lists, multiple lines)", () => {
    const flat = descriptionQuality("one long sentence without any structure markers at all");
    const structured = descriptionQuality([
      "Goal: validate signup",
      "- Returns 400 on empty",
      "- Returns 201 on valid",
      "- Test command: npm test",
    ].join("\n"));
    expect(structured).toBeGreaterThan(flat);
  });

  it("rewards concreteness (file paths, code, URLs, numbers)", () => {
    const vague = descriptionQuality("fix this thing somewhere in the codebase");
    const concrete = descriptionQuality(
      "Fix `validateEmail()` in src/routes/auth.ts:42, failing test at https://ci/build/1234",
    );
    expect(concrete).toBeGreaterThan(vague);
  });
});

describe("calculateConfidence — fixed-denominator scoring (scorer-v2 T3)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => infoSpy.mockRestore());

  it("FIELD_WEIGHTS sum to exactly 100 (the fixed maxPossible)", () => {
    const sum = Object.values(FIELD_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it("a fully-specified task (rich description + all nine fields) scores near 100 with no caps", () => {
    const result = calculateConfidence({
      title: "Validate signup body",
      description: RICH_DESC,
      templateData: ALL_V2,
      templateFields: null,
    });
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.blocking).toBe(false);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("prose-first: a well-described + verifiable task passes (>=60) with NO structured templateData", () => {
    const result = calculateConfidence({
      title: "Add request-id middleware",
      description: RICH_DESC, // rich + a `curl`/verify signal, but no templateData
      templateData: null,
      templateFields: null,
    });
    expect(result.blocking).toBe(false); // verification signal → no evals keystone
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it("prose-first: a well-described but NON-verifiable task still blocks (evals keystone caps it)", () => {
    const result = calculateConfidence({
      title: "Replace the config loader",
      description: [
        "Replace the legacy config loader in src/config/loader.ts with a typed schema.",
        "- Move the defaults into src/config/defaults.ts.",
        "- Read the 12 documented keys from process.env via a zod object.",
        "- Keep the public getConfig() signature unchanged for the 40 call sites.",
      ].join("\n"), // high quality, NO verification word
      templateData: null,
      templateFields: null,
    });
    expect(result.blocking).toBe(true);
    expect(result.score).toBeLessThan(60);
  });

  it("score is template-INDEPENDENT: identical with null vs full templateFields", () => {
    const base = { title: "Validate signup body", description: CONCRETE_DESC, templateData: ALL_V2 } as const;
    const a = calculateConfidence({ ...base, templateFields: null });
    const b = calculateConfidence({ ...base, templateFields: FULL_FIELDS });
    expect(a.score).toBe(b.score);
  });

  it("the executability fields move the score (no longer scoring-neutral as in T2)", () => {
    const base = { title: "Add request-id middleware", description: CONCRETE_DESC, templateFields: null } as const;
    const lean = calculateConfidence({ ...base, templateData: { goal: "g", acceptanceCriteria: "- has a header" } });
    const rich = calculateConfidence({
      ...base,
      templateData: {
        goal: "g",
        acceptanceCriteria: "- has a header",
        scope: "src/middleware",
        outOfScope: "no router change",
        dependencies: "none",
        risk: "low",
        agentPrompt: "1. add the middleware 2. wire it up",
      },
    });
    expect(rich.score).toBeGreaterThan(lean.score);
  });
});

describe("calculateConfidence — probe regressions flip below 60 (scorer-v2 T3)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => infoSpy.mockRestore());

  it("full-template-no-AC falls below 60 (was 73)", () => {
    const result = calculateConfidence({
      title: "Refactor signup validation",
      description: NO_VERIF_DESC,
      // old "full template": goal + context + constraints, NO acceptance criteria,
      // none of the new executability fields
      templateData: { goal: "extract validation", context: "500 on empty body", constraints: "no migration" },
      templateFields: FULL_FIELDS,
    });
    expect(result.score).toBeLessThan(60);
    expect(result.blocking).toBe(true);
  });

  it("no-template-no-AC falls below 60 (was 74)", () => {
    const result = calculateConfidence({
      title: "Refactor signup validation",
      description: NO_VERIF_DESC,
      templateData: null,
      templateFields: null,
    });
    expect(result.score).toBeLessThan(60);
    expect(result.blocking).toBe(true);
  });
});

describe("calculateConfidence — evals keystone (scorer-v2 T3)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => infoSpy.mockRestore());

  it("evals-absent emits a BLOCKING keystone finding and sets result.blocking", () => {
    const result = calculateConfidence({
      title: "ok",
      description: NO_VERIF_DESC,
      templateData: { goal: "g", scope: "s", outOfScope: "o", dependencies: "none", risk: "low", agentPrompt: "do it" },
      templateFields: null,
    });
    const f = result.findings.find((x) => x.code === "missing_acceptance_criteria");
    expect(f?.severity).toBe("blocking");
    expect(f?.keystone).toBe(true);
    expect(result.blocking).toBe(true);
  });

  it("keystone beats field-count: richly-specified-but-no-evals is capped at the keystone ceiling (<60)", () => {
    // All eight non-evals fields present would otherwise reach the high-70s.
    const result = calculateConfidence({
      title: "Refactor signup validation",
      description: NO_VERIF_DESC,
      templateData: {
        goal: "g",
        scope: "src/routes/auth.ts",
        outOfScope: "session middleware",
        dependencies: "none",
        risk: "low",
        agentPrompt: "1. do x 2. do y",
      },
      templateFields: null,
    });
    expect(result.score).toBeLessThanOrEqual(EVALS_KEYSTONE_CAP);
    expect(result.score).toBeLessThan(60);
    expect(result.blocking).toBe(true);
  });

  it("is threshold-INDEPENDENT: calculateConfidence takes no threshold, so blocking + sub-60 hold regardless of project config", () => {
    const result = calculateConfidence({
      title: "ok",
      description: NO_VERIF_DESC,
      templateData: { goal: "g", scope: "s", outOfScope: "o", dependencies: "none", risk: "low", agentPrompt: "x" },
      templateFields: null,
    });
    expect(result.blocking).toBe(true);
    expect(result.score).toBeLessThan(60);
  });

  it("AC present → no keystone, not blocking", () => {
    const result = calculateConfidence({
      title: "ok",
      description: NO_VERIF_DESC,
      templateData: { goal: "g", acceptanceCriteria: "- returns 400 on empty body" },
      templateFields: null,
    });
    expect(result.blocking).toBe(false);
    expect(result.findings.find((x) => x.code === "missing_acceptance_criteria")).toBeUndefined();
  });

  it("prose verification signal → partial evals credit, WARNING (not keystone), not blocking", () => {
    const withSignal = calculateConfidence({
      title: "ok", description: VERIF_DESC, templateData: { goal: "g" }, templateFields: null,
    });
    const noSignal = calculateConfidence({
      title: "ok", description: NO_VERIF_DESC, templateData: { goal: "g" }, templateFields: null,
    });
    expect(withSignal.blocking).toBe(false);
    expect(noSignal.blocking).toBe(true);
    // a prose verification path earns partial evals credit over silence
    expect(withSignal.score).toBeGreaterThan(noSignal.score);
    const f = withSignal.findings.find((x) => x.code === "missing_acceptance_criteria");
    expect(f?.severity).toBe("warning");
    expect(f?.keystone).toBeUndefined();
  });
});

describe("calculateConfidence — agentPrompt keystone is WARNING-only (scorer-v2 T3)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => infoSpy.mockRestore());

  it("agentPrompt-absent: warning keystone finding, does NOT set blocking, does NOT cap below 60", () => {
    const result = calculateConfidence({
      title: "ok",
      description: CONCRETE_DESC,
      templateData: { ...ALL_V2, agentPrompt: "" }, // everything except agentPrompt
      templateFields: null,
    });
    const f = result.findings.find((x) => x.code === "missing_agent_prompt");
    expect(f?.severity).toBe("warning");
    expect(f?.keystone).toBe(true);
    expect(result.blocking).toBe(false);
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it("agentPrompt present → no missing_agent_prompt finding", () => {
    const result = calculateConfidence({
      title: "ok", description: CONCRETE_DESC, templateData: ALL_V2, templateFields: null,
    });
    expect(result.findings.find((x) => x.code === "missing_agent_prompt")).toBeUndefined();
  });
});

describe("calculateConfidence — structural + subscore caps", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => infoSpy.mockRestore());

  it("caps at 30 when title is empty", () => {
    const result = calculateConfidence({
      title: "",
      description: CONCRETE_DESC,
      templateData: ALL_V2,
      templateFields: null,
    });
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.findings.find((f) => f.code === "missing_title")).toBeDefined();
  });

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

  it("emits ambiguous_scope when >=3 vague terms and no concrete anchors (AC present, so keystone does not mask it)", () => {
    const result = calculateConfidence({
      title: "Some title",
      description: "We should fix this, improve that, and optimize the system somehow quickly",
      templateData: { goal: "g", acceptanceCriteria: "- the build is green" },
      templateFields: null,
    });
    expect(result.score).toBeLessThanOrEqual(75);
    const finding = result.findings.find((f) => f.code === "ambiguous_scope");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
  });

  it("strictest cap wins (empty title beats the evals keystone → 30)", () => {
    const result = calculateConfidence({
      title: "",
      description: NO_VERIF_DESC, // no AC, no verification → keystone (55) also fires
      templateData: null,
      templateFields: null,
    });
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.findings.find((f) => f.code === "missing_title")).toBeDefined();
    expect(result.findings.find((f) => f.code === "missing_acceptance_criteria")).toBeDefined();
  });

  it("emits low_testability / low_scope_clarity / low_concreteness findings when those subscores are low", () => {
    const result = calculateConfidence({
      title: "Rewrite onboarding copy",
      description: "Rewrite the onboarding welcome text to be friendlier and shorter for brand new people",
      templateData: { goal: "friendlier onboarding" },
      templateFields: null,
    });
    expect(result.subscores.testability).toBe(0);
    expect(result.subscores.scopeClarity).toBe(0);
    expect(result.subscores.concreteness).toBe(0);
    expect(result.findings.find((f) => f.code === "low_testability")).toBeDefined();
    expect(result.findings.find((f) => f.code === "low_scope_clarity")).toBeDefined();
    expect(result.findings.find((f) => f.code === "low_concreteness")).toBeDefined();
  });

  it("does NOT apply caps to a task strong on every dimension", () => {
    const result = calculateConfidence({
      title: "Add request-id middleware",
      description: RICH_DESC,
      templateData: ALL_V2,
      templateFields: null,
    });
    for (const code of ["low_testability", "low_scope_clarity", "low_concreteness", "missing_acceptance_criteria"]) {
      expect(result.findings.find((f) => f.code === code), `unexpected ${code}`).toBeUndefined();
    }
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("logs one info-level line when a cap fires", () => {
    calculateConfidence({
      title: "",
      description: CONCRETE_DESC,
      templateData: ALL_V2,
      templateFields: null,
    });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("confidence.score_capped");
  });

  it("does NOT log when no cap fires", () => {
    calculateConfidence({
      title: "Add request-id middleware",
      description: CONCRETE_DESC,
      templateData: ALL_V2,
      templateFields: null,
    });
    expect(infoSpy).not.toHaveBeenCalled();
  });
});

describe("calculateConfidence — subscores", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  function subs(overrides: Partial<{
    title: string;
    description: string;
    templateData: typeof ALL_FILLED;
    templateFields: typeof FULL_FIELDS;
  }> = {}): TaskQualitySubscores {
    return calculateConfidence({
      title: overrides.title ?? "ok",
      description: overrides.description ?? "ok ok ok",
      templateData: overrides.templateData ?? ALL_FILLED,
      templateFields: overrides.templateFields ?? FULL_FIELDS,
    }).subscores;
  }

  it("completeness: 100 when all active fields present, < 100 when any missing", () => {
    expect(subs().completeness).toBe(100);
    expect(subs({ templateData: { ...ALL_FILLED, goal: "" } }).completeness).toBeLessThan(100);
  });

  it("concreteness: 0 with no anchors, > 0 with file path / URL / inline code", () => {
    expect(subs({ description: "just words and more words here" }).concreteness).toBe(0);
    expect(subs({ description: "see src/foo.ts and `bar()`" }).concreteness).toBeGreaterThan(0);
    expect(subs({ description: "file.ts + /etc/path + `code` + https://x.com + 1234" }).concreteness).toBe(100);
  });

  it("testability: 100 when AC present, 60 with test-language signal, 0 without either", () => {
    expect(subs().testability).toBe(100);
    expect(subs({
      description: "should verify with test",
      templateData: { ...ALL_FILLED, acceptanceCriteria: "" },
    }).testability).toBe(60);
    expect(subs({
      description: "no signals at all",
      templateData: { ...ALL_FILLED, acceptanceCriteria: "" },
    }).testability).toBe(0);
  });

  it("scopeClarity: 100 with constraints, 60 with scope markers, 0 without", () => {
    expect(subs().scopeClarity).toBe(100);
    expect(subs({
      description: "in scope: A. out of scope: B.",
      templateData: { ...ALL_FILLED, constraints: "" },
    }).scopeClarity).toBe(60);
    expect(subs({
      description: "just words",
      templateData: { ...ALL_FILLED, constraints: "" },
    }).scopeClarity).toBe(0);
  });

  it("contextQuality: 100 with context, partial with long description only, 0 otherwise", () => {
    expect(subs().contextQuality).toBe(100);
    const partial = subs({
      description: "a ".repeat(200),
      templateData: { ...ALL_FILLED, context: "" },
    }).contextQuality;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThanOrEqual(70);
    expect(subs({
      description: "",
      templateData: { ...ALL_FILLED, context: "" },
    }).contextQuality).toBe(0);
  });

  it("structure: 0 for empty desc, > 0 with multi-line lists and headings", () => {
    expect(subs({ description: "" }).structure).toBe(0);
    const structured = subs({
      description: "# H\n- a\n- b\n- c\n1. one\n2. two\nmore",
    }).structure;
    expect(structured).toBeGreaterThan(0);
  });

  it("ambiguityRisk: 100 with no vague terms, drops 10 per hit, floors at 0", () => {
    expect(subs({ description: "concrete and specific" }).ambiguityRisk).toBe(100);
    expect(subs({ description: "fix improve optimize" }).ambiguityRisk).toBe(70);
    expect(subs({
      description: "fix improve optimize clean up somehow quickly simple modernize fix improve optimize clean up",
    }).ambiguityRisk).toBe(0);
  });
});

describe("calculateConfidence — inferredTaskType (M2 bridge)", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("returns inferredTaskType when templateData.taskType is set", () => {
    const result = calculateConfidence({
      title: "Fix crash on signup",
      description: CONCRETE_DESC,
      templateData: { ...ALL_V2, taskType: "bugfix" },
      templateFields: null,
    });
    expect(result.inferredTaskType).toBe("bugfix");
  });

  it("returns undefined when templateData has no taskType", () => {
    const result = calculateConfidence({
      title: "Some task",
      description: CONCRETE_DESC,
      templateData: ALL_V2,
      templateFields: null,
    });
    expect(result.inferredTaskType).toBeUndefined();
  });

  it("does not affect score or subscores (scoring-neutral bridge); findings CAN differ once a taskType is set (M2 required signals)", () => {
    const withType = calculateConfidence({
      title: "ok",
      description: CONCRETE_DESC,
      templateData: { ...ALL_V2, taskType: "security" },
      templateFields: null,
    });
    const withoutType = calculateConfidence({
      title: "ok",
      description: CONCRETE_DESC,
      templateData: ALL_V2,
      templateFields: null,
    });
    expect(withType.score).toBe(withoutType.score);
    expect(withType.subscores).toEqual(withoutType.subscores);
    // Pre-M2, this also asserted `findings` equality. Once a taskType is set,
    // the M2 required-signal checker (below) can add its own `blocking`
    // findings on top of the universal ones: CONCRETE_DESC/ALL_V2 satisfy
    // every universal field but none of "security"'s required-signal
    // keywords, so the typed task now reports MORE findings than the
    // untyped one. See the dedicated "required signals per taskType" suite
    // for the full per-type coverage.
    expect(withoutType.findings).toEqual([]);
    // Exact code set (not just length > 0), measured against the built
    // scorer (npm run build --workspace=backend), task 6b88ec87 review
    // round 1 finding 6: ALL_V2 fills constraints (so security's own
    // `missing_constraints` signal is satisfied) and acceptanceCriteria (so
    // the aliased `missing_acceptance_criteria`/verification signal is
    // satisfied too); the remaining 5 security signals have no matching
    // keyword anywhere in CONCRETE_DESC/ALL_V2, so all 5 fire, in the order
    // REQUIRED_SIGNALS_BY_TYPE.security declares them.
    expect(withType.findings.map((f) => f.code)).toEqual([
      "missing_security_goal",
      "missing_affected_asset",
      "missing_threat_or_risk",
      "missing_review_requirement",
      "missing_rollback",
    ]);
    expect(withType.findings.every((f) => f.severity === "blocking")).toBe(true);
  });
});

// ── Milestone 2: per-task-type confidence thresholds (task b8629b99) ───────
describe("resolveEffectiveThreshold — layered threshold hierarchy (M2)", () => {
  it("SUGGESTED_TASK_TYPE_THRESHOLDS matches the spec's documented defaults exactly (doc-only; never auto-applied)", () => {
    expect(SUGGESTED_TASK_TYPE_THRESHOLDS).toEqual({
      bugfix: 75,
      feature: 80,
      refactoring: 80,
      security: 90,
      migration: 85,
      docs: 60,
    });
  });

  it("taskType layer wins when present: security=90 overrides a lower project threshold", () => {
    const result = resolveEffectiveThreshold("security", { security: 90 }, 60);
    expect(result).toEqual({ effectiveThreshold: 90, thresholdSource: "taskType" });
  });

  // Mutation guard: flipping the precedence (project beats taskType) would
  // make this assert 60/"project" instead — pins the ORDER, not just that a
  // number comes out.
  it("taskType layer wins even when its value is LOWER than the project threshold (precedence is order, not magnitude)", () => {
    const result = resolveEffectiveThreshold("docs", { docs: 40 }, 80);
    expect(result).toEqual({ effectiveThreshold: 40, thresholdSource: "taskType" });
  });

  it("falls to the project layer when taskType is undefined (no explicit type to look up)", () => {
    const result = resolveEffectiveThreshold(undefined, { security: 90 }, 60);
    expect(result).toEqual({ effectiveThreshold: 60, thresholdSource: "project" });
  });

  it("falls to the project layer when taskType is set but has no matching entry in taskTypeThresholds", () => {
    const result = resolveEffectiveThreshold("bugfix", { security: 90 }, 60);
    expect(result).toEqual({ effectiveThreshold: 60, thresholdSource: "project" });
  });

  it("falls to the project layer when taskTypeThresholds is null/undefined/empty", () => {
    expect(resolveEffectiveThreshold("security", null, 60)).toEqual({ effectiveThreshold: 60, thresholdSource: "project" });
    expect(resolveEffectiveThreshold("security", undefined, 60)).toEqual({ effectiveThreshold: 60, thresholdSource: "project" });
    expect(resolveEffectiveThreshold("security", {}, 60)).toEqual({ effectiveThreshold: 60, thresholdSource: "project" });
  });

  // BC pin (task b8629b99 acceptance): a project that has never touched
  // taskTypeThresholds behaves EXACTLY as it did before this feature existed —
  // confidenceThreshold alone decides the outcome, regardless of taskType.
  it("BC: a project without taskTypeThresholds resolves to its flat confidenceThreshold, taskType set or not", () => {
    expect(resolveEffectiveThreshold("security", undefined, 60)).toEqual({ effectiveThreshold: 60, thresholdSource: "project" });
    expect(resolveEffectiveThreshold(undefined, undefined, 60)).toEqual({ effectiveThreshold: 60, thresholdSource: "project" });
  });

  it("falls all the way to GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD (60) when the project threshold is also absent", () => {
    expect(resolveEffectiveThreshold(undefined, undefined, undefined)).toEqual({
      effectiveThreshold: GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD,
      thresholdSource: "global",
    });
    expect(resolveEffectiveThreshold(undefined, undefined, null)).toEqual({
      effectiveThreshold: 60,
      thresholdSource: "global",
    });
  });

  it("a taskType match with an invalid stored value (non-number/NaN/out-of-range) degrades to the project layer, not a throw", () => {
    expect(resolveEffectiveThreshold("security", { security: "90" as unknown as number }, 60)).toEqual({
      effectiveThreshold: 60,
      thresholdSource: "project",
    });
    expect(resolveEffectiveThreshold("security", { security: Number.NaN }, 60)).toEqual({
      effectiveThreshold: 60,
      thresholdSource: "project",
    });
    expect(resolveEffectiveThreshold("security", { security: 150 }, 60)).toEqual({
      effectiveThreshold: 60,
      thresholdSource: "project",
    });
    expect(resolveEffectiveThreshold("security", { security: -1 }, 60)).toEqual({
      effectiveThreshold: 60,
      thresholdSource: "project",
    });
    expect(resolveEffectiveThreshold("security", { security: Infinity }, 60)).toEqual({
      effectiveThreshold: 60,
      thresholdSource: "project",
    });
  });

  // Own-property-safety (same guard family as buildRequiredSignalFindings /
  // REQUIRED_SIGNALS_BY_TYPE, task 6b88ec87 review round 2 finding 1):
  // taskTypeThresholds is an unvalidated Json read, so a prototype-chain key
  // must never resolve through bracket access.
  it.each([
    ["constructor", "constructor"],
    ["__proto__", "__proto__"],
    ["toString", "toString"],
    ["hasOwnProperty", "hasOwnProperty"],
    ["valueOf", "valueOf"],
  ])("a prototype-chain taskType (%s) never resolves, no throw, falls to project layer", (_label, badTaskType) => {
    expect(() =>
      resolveEffectiveThreshold(badTaskType as unknown as TaskType, { security: 90 }, 60),
    ).not.toThrow();
    expect(resolveEffectiveThreshold(badTaskType as unknown as TaskType, { security: 90 }, 60)).toEqual({
      effectiveThreshold: 60,
      thresholdSource: "project",
    });
  });

  it("a non-string taskType (array/number/object) never resolves, no throw, falls to project layer", () => {
    for (const bad of [["security"], 1, {}, false]) {
      expect(() => resolveEffectiveThreshold(bad as unknown as TaskType, { security: 90 }, 60)).not.toThrow();
      expect(resolveEffectiveThreshold(bad as unknown as TaskType, { security: 90 }, 60)).toEqual({
        effectiveThreshold: 60,
        thresholdSource: "project",
      });
    }
  });

  it("a non-object taskTypeThresholds (string/number/array) never resolves, no throw, falls to project layer", () => {
    for (const bad of ["not-an-object", 42, ["security", 90]]) {
      expect(() => resolveEffectiveThreshold("security", bad, 60)).not.toThrow();
      expect(resolveEffectiveThreshold("security", bad, 60)).toEqual({ effectiveThreshold: 60, thresholdSource: "project" });
    }
  });

  // Mutation guard (review round-2 finding 3): the five prototype-chain
  // cases above ("constructor", "__proto__", ...) are inert against a
  // `hasOwnProperty` -> `key in obj` regression, because every one of those
  // names resolves through Object.prototype to a FUNCTION, which the
  // `typeof raw === "number"` re-validation rejects anyway, so the guard could
  // be gone entirely and these cases would still pass, for the wrong reason.
  // This case uses a genuine taskType key ("security") whose INHERITED value
  // is itself a valid number (5, in [0, 100]), so only the own-property
  // guard, not the number re-validation, can make it fall to the project
  // layer instead of resolving through the prototype chain.
  it("an inherited (non-own) taskType value is never used, even when it is itself a valid number", () => {
    const taskTypeThresholds = Object.create({ security: 5 }) as unknown;
    expect(resolveEffectiveThreshold("security", taskTypeThresholds, 60)).toEqual({
      effectiveThreshold: 60,
      thresholdSource: "project",
    });
  });
});

// ── M3: risk modifiers (task 8e88cfc0) ──────────────────────────────────────
// Overlay §"Policy Layer": riskModifiers raises the effective threshold by N
// points per triggered modifier, stacking additively. Detection is a FIXED
// heuristic — regex over `description`, label match for productionImpact —
// never an LLM (ADR-0011 Non-Goals).

describe("detectRiskModifierTriggers — heuristic detectors (M3)", () => {
  it("touchesAuth matches every keyword in its set (case-insensitive, whole word)", () => {
    for (const word of ["auth", "login", "signup", "password", "token", "session", "jwt", "oauth", "AUTH", "Login"]) {
      expect(
        detectRiskModifierTriggers({ description: `The task touches ${word} handling.` }),
      ).toContain("touchesAuth");
    }
  });

  it("touchesDatabase matches every keyword in its set", () => {
    for (const word of ["migration", "schema", "prisma", "sql", "db", "database", "SCHEMA"]) {
      expect(
        detectRiskModifierTriggers({ description: `Run a ${word} change.` }),
      ).toContain("touchesDatabase");
    }
  });

  it("touchesPersonalData matches every keyword in its set", () => {
    for (const word of ["pii", "gdpr", "email", "address", "name", "user-data", "user data", "personal", "PII"]) {
      expect(
        detectRiskModifierTriggers({ description: `Handle ${word} in the export.` }),
      ).toContain("touchesPersonalData");
    }
  });

  it("productionImpact matches either a production/prod label or the word 'production' in description", () => {
    expect(detectRiskModifierTriggers({ description: "", labels: ["production"] })).toContain("productionImpact");
    expect(detectRiskModifierTriggers({ description: "", labels: ["prod"] })).toContain("productionImpact");
    // Label match is case-insensitive and trims whitespace.
    expect(detectRiskModifierTriggers({ description: "", labels: [" PROD "] })).toContain("productionImpact");
    expect(
      detectRiskModifierTriggers({ description: "This change has production impact.", labels: [] }),
    ).toContain("productionImpact");
    // Neither channel fires -> not triggered.
    expect(
      detectRiskModifierTriggers({ description: "Nothing risky here.", labels: ["frontend"] }),
    ).not.toContain("productionImpact");
  });

  it("each detector emits exactly its own modifier name — no cross-trigger bleed", () => {
    expect(detectRiskModifierTriggers({ description: "Add login support." })).toEqual(["touchesAuth"]);
    expect(detectRiskModifierTriggers({ description: "Write a migration." })).toEqual(["touchesDatabase"]);
    expect(detectRiskModifierTriggers({ description: "Export user email." })).toEqual(["touchesPersonalData"]);
    expect(detectRiskModifierTriggers({ description: "", labels: ["production"] })).toEqual(["productionImpact"]);
  });

  it("multiple modifiers stack: a description hitting several keyword sets triggers all of them, in RISK_MODIFIER_NAMES order", () => {
    const triggered = detectRiskModifierTriggers({
      description: "Add a login migration that stores user email, with production impact.",
      labels: [],
    });
    expect(triggered).toEqual(["touchesAuth", "touchesDatabase", "touchesPersonalData", "productionImpact"]);
  });

  it("a description matching no keyword triggers nothing", () => {
    expect(detectRiskModifierTriggers({ description: "Refactor the internal request parser for clarity." })).toEqual(
      [],
    );
  });

  it("null description and absent labels never throw and trigger nothing", () => {
    expect(() => detectRiskModifierTriggers({ description: null })).not.toThrow();
    expect(detectRiskModifierTriggers({ description: null })).toEqual([]);
  });

  // Word-boundary pin: a substring match (no LLM judgement, purely
  // mechanical) must not false-positive on a longer word that happens to
  // contain a keyword. A mutant dropping the `\b` word boundaries from
  // RISK_MODIFIER_TEXT_PATTERNS would make this red.
  it("word-boundary: a longer word containing a keyword as a substring does not trigger", () => {
    expect(detectRiskModifierTriggers({ description: "This is an authentic experience." })).not.toContain(
      "touchesAuth",
    );
    expect(detectRiskModifierTriggers({ description: "Use PostgreSQL for storage." })).not.toContain(
      "touchesDatabase",
    );
  });
});

describe("resolveTriggeredRiskModifiers — opt-in project config intersection (M3)", () => {
  it("a project with riskModifiers unset (null) never triggers anything, even when the text/labels fire", () => {
    expect(
      resolveTriggeredRiskModifiers({ description: "Add login support.", labels: ["production"] }, null),
    ).toEqual({ triggeredRiskModifiers: [], riskModifierPoints: 0 });
  });

  it("a project with riskModifiers undefined never triggers anything", () => {
    expect(resolveTriggeredRiskModifiers({ description: "Add login support." }, undefined)).toEqual({
      triggeredRiskModifiers: [],
      riskModifierPoints: 0,
    });
  });

  it("a triggered name absent from the project's config contributes nothing, even though the text fired", () => {
    // touchesAuth fires in text, but the project only opted into touchesDatabase.
    expect(
      resolveTriggeredRiskModifiers({ description: "Add login support." }, { touchesDatabase: 5 }),
    ).toEqual({ triggeredRiskModifiers: [], riskModifierPoints: 0 });
  });

  it("a single configured, triggered modifier contributes exactly its configured points", () => {
    expect(
      resolveTriggeredRiskModifiers({ description: "Add login support." }, { touchesAuth: 10 }),
    ).toEqual({ triggeredRiskModifiers: ["touchesAuth"], riskModifierPoints: 10 });
  });

  // The literal overlay example (task spec, §"Policy Layer"): all four
  // configured and all four triggered stack ADDITIVELY (10 + 5 + 10 + 10 = 35).
  it("multiple triggered AND configured modifiers stack additively", () => {
    const result = resolveTriggeredRiskModifiers(
      { description: "Add a login migration that stores user email, with production impact.", labels: [] },
      { touchesAuth: 10, touchesDatabase: 5, touchesPersonalData: 10, productionImpact: 10 },
    );
    expect(result.triggeredRiskModifiers).toEqual([
      "touchesAuth",
      "touchesDatabase",
      "touchesPersonalData",
      "productionImpact",
    ]);
    expect(result.riskModifierPoints).toBe(35);
  });

  it("an unrecognised key in the project's config is inert (only RISK_MODIFIER_NAMES are consulted)", () => {
    expect(
      resolveTriggeredRiskModifiers(
        { description: "Add login support." },
        { touchesAuth: 10, notARealModifier: 999 },
      ),
    ).toEqual({ triggeredRiskModifiers: ["touchesAuth"], riskModifierPoints: 10 });
  });

  it.each([
    ["a string", "10"],
    ["NaN", Number.NaN],
    ["negative", -1],
    ["Infinity", Infinity],
  ])("an invalid point value (%s) is skipped: the name is NOT reported as triggered and contributes 0", (_label, bad) => {
    expect(() =>
      resolveTriggeredRiskModifiers({ description: "Add login support." }, { touchesAuth: bad }),
    ).not.toThrow();
    expect(resolveTriggeredRiskModifiers({ description: "Add login support." }, { touchesAuth: bad })).toEqual({
      triggeredRiskModifiers: [],
      riskModifierPoints: 0,
    });
  });

  it("a non-object riskModifiers (string/number/array) never throws and triggers nothing", () => {
    for (const bad of ["not-an-object", 42, ["touchesAuth", 10]]) {
      expect(() => resolveTriggeredRiskModifiers({ description: "Add login support." }, bad)).not.toThrow();
      expect(resolveTriggeredRiskModifiers({ description: "Add login support." }, bad)).toEqual({
        triggeredRiskModifiers: [],
        riskModifierPoints: 0,
      });
    }
  });

  it("RISK_MODIFIER_NAMES names exactly the four overlay modifiers, in the overlay's own order", () => {
    expect(RISK_MODIFIER_NAMES).toEqual(["touchesAuth", "touchesDatabase", "touchesPersonalData", "productionImpact"]);
  });
});

describe("taskTypeThresholdsSchema — PATCH /projects/:id validation (M2)", () => {
  it("accepts a partial map of valid taskType keys with in-range integers", () => {
    const result = taskTypeThresholdsSchema.safeParse({ security: 90, docs: 60 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ security: 90, docs: 60 });
  });

  it("accepts an empty object (no overrides yet)", () => {
    expect(taskTypeThresholdsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts undefined (field omitted) and null (explicit clear)", () => {
    expect(taskTypeThresholdsSchema.safeParse(undefined).success).toBe(true);
    expect(taskTypeThresholdsSchema.safeParse(null).success).toBe(true);
  });

  it("rejects an unknown taskType key rather than silently dropping it", () => {
    const result = taskTypeThresholdsSchema.safeParse({ security: 90, chore: 50 });
    expect(result.success).toBe(false);
  });

  it.each([-1, 101, 1.5])("rejects an out-of-range or non-integer value (%s)", (bad) => {
    const result = taskTypeThresholdsSchema.safeParse({ security: bad });
    expect(result.success).toBe(false);
  });
});

// ── Milestone 2: per-type required signals (task 6b88ec87) ──────────────────
// The required-signal matrix from the overlay's "Task-Type-Aware Scoring"
// section, keyed on the EXPLICIT templateData.taskType only. Every fixture
// below is hand-built so each of the six required signals for its type is
// independently toggleable in the description text (or, for signals that
// reuse an existing spec field, in templateData) without any other signal's
// keywords leaking in; the "one signal missing" tests below rely on that
// isolation to pin the exact code that fires.
describe("calculateConfidence: required signals per taskType (M2)", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  // The genuinely type-specific codes (no universal MISS_FINDINGS alias —
  // see confidence.ts's REQUIRED_SIGNALS_BY_TYPE header comment), for the
  // backward-compat forbidden-list test below. Sourced directly from the
  // implementation's own export rather than a hand-maintained duplicate list,
  // so a future rename can't silently desync this test from reality. (The
  // 5 codes that DO alias a universal finding — missing_goal, missing_scope,
  // missing_out_of_scope, missing_risk, missing_acceptance_criteria — are
  // deliberately excluded: they are legitimate universal codes that CAN fire
  // without any taskType set, so they don't belong in a "forbidden without
  // taskType" list.)
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
    // "in" and "compat"); the `(in)?` group at backend/src/lib/confidence.ts's
    // missing_compatibility entry fixes that. Positive-only: this fixture does
    // not need every other migration signal stated, it only pins that
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
  // `templateData` reaches calculateConfidence via an unvalidated
  // `as TemplateData | null` cast on every READ path (confidence-gate.ts:81,
  // routes/tasks.ts x5, scripts/shadow-report.ts:68) — templateDataSchema
  // only validates on WRITE. A stored `taskType` outside the enum (or not a
  // string at all) must degrade to "no taskType" behavior, never throw.
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
          // Simulates the unvalidated Prisma Json cast: a value that was
          // never taskTypeSchema-checked (e.g. a v1 preset's stale "chore",
          // or hand-edited JSON) reaching the scorer as-is.
          templateData: { acceptanceCriteria: "- x", taskType: "chore" } as any,
          templateFields: null,
        }),
      ).not.toThrow();
      const result = calculateConfidence({
        title: "ok",
        description: UNGUARDED_DESC,
        templateData: { acceptanceCriteria: "- x", taskType: "chore" } as any,
        templateFields: null,
      });
      expect(result.findings).toEqual(untyped.findings);
    });

    // Finding 1 (review round 2): the own-property lookup fix must also be
    // pinned against every inherited key REQUIRED_SIGNALS_BY_TYPE's plain
    // object literal exposes via the prototype chain — these five strings
    // are exactly what made `.filter` throw before the fix (a `typeof ===
    // "string"` guard alone does not catch them; only own-property
    // confirmation does).
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
          templateData: { acceptanceCriteria: "- x", taskType: badTaskType } as any,
          templateFields: null,
        }),
      ).not.toThrow();
      const result = calculateConfidence({
        title: "ok",
        description: UNGUARDED_DESC,
        templateData: { acceptanceCriteria: "- x", taskType: badTaskType } as any,
        templateFields: null,
      });
      expect(result.findings).toEqual(untyped.findings);
    });
  });

  // ── Finding 2 (review round 1): dedup regression ───────────────────────────
  // A required-signal predicate that ALIASES a universal MISS_FINDINGS code
  // (missing_goal, missing_scope, missing_out_of_scope, missing_risk,
  // missing_acceptance_criteria) must ESCALATE the existing universal finding
  // in place, never add a second, byte-identical-suggestion entry. Exercised
  // here with maximally bare-bones typed tasks (only a title) — every
  // required signal for the type is missing simultaneously, the strongest
  // stress case for the merge-by-code logic.
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
// The keyword regexes in REQUIRED_SIGNALS_BY_TYPE were tightened to drop a
// handful of single-common-word alternatives that made a signal trivially
// "present" over content-free prose (e.g. `\brisks?\b` alone, or a bare
// `\bsecur(e|ity)\b` with no object). Each type gets two honest fixtures,
// both written as flowing prose (no "Label:" colon-headers, no bullet
// keyword-stuffing):
//  (a) present  — a natural paragraph that states every required signal for
//      the type in ordinary sentences; must produce ZERO required-signal
//      findings for that type.
//  (b) junk     — content-free filler sentences ("This would be nice to
//      have.", "There is some risk here.") that state NOTHING concrete;
//      every required signal for the type MUST still fire.
//
// R2 finding 4 (softened claim): of the 8 words/phrases R1 actually dropped
// from these regexes, only ONE was pinned by a junk sentence going in —
// security's bare "risk" (guarding `\bthreats?\b|...` against a reverted
// `\brisks?\b` alternative on missing_threat_or_risk). The other 7 reverted
// cleanly (no test went red): bugfix affected_environment's dropped
// "version", feature ux_api_expectations' dropped "request", refactoring
// purpose's dropped "reason for", security missing_security_goal's dropped
// bare "secure" and missing_affected_asset's dropped "resources", and
// migration's dropped "today" (current_state) and "release"
// (deployment_impact). Each junk fixture below now also carries its type's
// specific dropped word(s) as an EXTRA regression guard, verified by
// reverting each regex and confirming the corresponding junk case goes red
// (task 6b88ec87 review round 2 handoff records which).
describe("calculateConfidence: required-signal regex quality (finding 3)", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  const CASES: Record<
    "bugfix" | "feature" | "refactoring" | "security" | "migration" | "docs",
    {
      codes: string[];
      present: { description: string; templateData: Record<string, unknown> };
      junk: { description: string; templateData: Record<string, unknown> };
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

describe("templateDataSchema — taskType", () => {
  it("accepts known taskType values", () => {
    for (const t of ["bugfix", "feature", "refactoring", "security", "migration", "docs"] as const) {
      expect(templateDataSchema.safeParse({ taskType: t }).success).toBe(true);
    }
  });

  it("rejects unknown taskType values", () => {
    expect(templateDataSchema.safeParse({ taskType: "random" }).success).toBe(false);
  });

  it("accepts payloads without taskType (BC)", () => {
    expect(templateDataSchema.safeParse({ goal: "g" }).success).toBe(true);
    expect(templateDataSchema.safeParse({}).success).toBe(true);
  });
});

describe("templateData/taskTemplate — scorer-v2 fields (T2)", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("templateDataSchema accepts the new executability fields + prefers", () => {
    const parsed = templateDataSchema.safeParse({
      goal: "g",
      acceptanceCriteria: "- a",
      scope: "src/foo.ts",
      outOfScope: "do not touch bar",
      dependencies: "none",
      risk: "low",
      agentPrompt: "Step 1: ...",
      prefers: { testBeforeImplementation: true, smallDiffs: true },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.scope).toBe("src/foo.ts");
      expect(parsed.data.agentPrompt).toBe("Step 1: ...");
      expect(parsed.data.prefers?.testBeforeImplementation).toBe(true);
    }
  });

  it("prefersSchema accepts all five booleans and an empty object", () => {
    expect(prefersSchema.safeParse({
      testBeforeImplementation: true,
      verticalSlices: true,
      smallDiffs: true,
      explicitStopConditions: true,
      noSpeculativeRefactoring: true,
    }).success).toBe(true);
    expect(prefersSchema.safeParse({}).success).toBe(true);
  });

  it("taskTemplateSchema.fields accepts the new booleans and defaults the rest to false", () => {
    const parsed = taskTemplateSchema.safeParse({ fields: { acceptanceCriteria: true, scope: true, agentPrompt: true } });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.fields.scope).toBe(true);
      expect(parsed.data.fields.agentPrompt).toBe(true);
      expect(parsed.data.fields.outOfScope).toBe(false);
      expect(parsed.data.fields.dependencies).toBe(false);
    }
  });

  it("backward-compat: old-shape templateData and empty payloads still parse", () => {
    expect(templateDataSchema.safeParse({ goal: "g", acceptanceCriteria: "a", context: "c", constraints: "k" }).success).toBe(true);
    expect(templateDataSchema.safeParse({}).success).toBe(true);
  });
});

// ── templateData string field length caps (hardening, 769df3c4) ────────────
//
// Before this change every templateDataSchema string field was unbounded —
// only the respec `description` sibling field carried a max(50_000). One
// shared constant now caps all nine templateData string fields, so this
// covers the schema boundary itself; the route-level 400s on create/PATCH/
// respec are covered in tasks-v2-routes.test.ts (all three write paths
// share this exact schema, so a schema-level pass there is a route-level
// pass here too).
describe("templateDataSchema — per-field length cap (hardening)", () => {
  const FIELDS = [
    "goal",
    "acceptanceCriteria",
    "context",
    "constraints",
    "scope",
    "outOfScope",
    "dependencies",
    "risk",
    "agentPrompt",
  ] as const;

  it("TEMPLATE_DATA_FIELD_MAX_CHARS matches the respec description cap (50_000)", () => {
    expect(TEMPLATE_DATA_FIELD_MAX_CHARS).toBe(50_000);
  });

  it.each(FIELDS)("accepts %s at exactly the cap", (field) => {
    const value = "a".repeat(TEMPLATE_DATA_FIELD_MAX_CHARS);
    const parsed = templateDataSchema.safeParse({ [field]: value });
    expect(parsed.success).toBe(true);
  });

  it.each(FIELDS)("rejects %s one character over the cap with a clear message", (field) => {
    const value = "a".repeat(TEMPLATE_DATA_FIELD_MAX_CHARS + 1);
    const parsed = templateDataSchema.safeParse({ [field]: value });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path.join(".") === field);
      expect(issue).toBeDefined();
      expect(issue?.message.length).toBeGreaterThan(0);
    }
  });
});

// ── templatePresetSchema shares the same per-field cap (hardening) ─────────
//
// A project's taskTemplate can carry up to 20 presets (taskTemplateSchema
// above); before this, a project admin could store an unbounded string in
// any of these same nine fields on every one of those 20 presets. It reuses
// the exact same TEMPLATE_DATA_FIELD_MAX_CHARS constant/helper as
// templateDataSchema, not a second number.
describe("templatePresetSchema — per-field length cap (hardening)", () => {
  const FIELDS = [
    "goal",
    "acceptanceCriteria",
    "context",
    "constraints",
    "scope",
    "outOfScope",
    "dependencies",
    "risk",
    "agentPrompt",
  ] as const;

  it.each(FIELDS)("accepts %s at exactly the cap", (field) => {
    const value = "a".repeat(TEMPLATE_DATA_FIELD_MAX_CHARS);
    const parsed = templatePresetSchema.safeParse({ name: "Preset", [field]: value });
    expect(parsed.success).toBe(true);
  });

  it.each(FIELDS)("rejects %s one character over the cap", (field) => {
    const value = "a".repeat(TEMPLATE_DATA_FIELD_MAX_CHARS + 1);
    const parsed = templatePresetSchema.safeParse({ name: "Preset", [field]: value });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path.join(".") === field);
      expect(issue).toBeDefined();
    }
  });
});

describe("calculateConfidence — findings", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("emits a finding for every missing core field with the right severity", () => {
    const result = calculateConfidence({
      title: "",
      description: "",
      templateData: null,
      templateFields: null,
    });
    const bySeverity: Record<string, string> = {};
    for (const f of result.findings) bySeverity[f.code] = f.severity;
    expect(bySeverity["missing_title"]).toBe("blocking");
    expect(bySeverity["missing_or_thin_description"]).toBe("blocking");
    expect(bySeverity["missing_goal"]).toBe("warning");
    expect(bySeverity["missing_acceptance_criteria"]).toBe("blocking"); // keystone (no AC, no verification)
    expect(bySeverity["missing_scope"]).toBe("warning");
    expect(bySeverity["missing_out_of_scope"]).toBe("info");
    expect(bySeverity["missing_dependencies"]).toBe("info");
    expect(bySeverity["missing_risk"]).toBe("info");
    expect(bySeverity["missing_agent_prompt"]).toBe("warning");
  });

  it("dependencies = 'none' is a positive signal (not a miss)", () => {
    const withNone = calculateConfidence({
      title: "ok", description: CONCRETE_DESC, templateData: { ...ALL_V2, dependencies: "none" }, templateFields: null,
    });
    const withoutDeps = calculateConfidence({
      title: "ok", description: CONCRETE_DESC, templateData: { ...ALL_V2, dependencies: "" }, templateFields: null,
    });
    expect(withNone.missing).not.toContain("dependencies");
    expect(withNone.findings.find((f) => f.code === "missing_dependencies")).toBeUndefined();
    expect(withoutDeps.missing).toContain("dependencies");
    expect(withNone.score).toBeGreaterThan(withoutDeps.score);
  });

  it("emits a vague_language warning when ambiguity drops below threshold", () => {
    const result = calculateConfidence({
      title: "ok",
      description: "should fix improve optimize this somehow with src/file.ts anchor",
      templateData: ALL_V2,
      templateFields: null,
    });
    expect(result.findings.find((f) => f.code === "vague_language" && f.severity === "warning")).toBeDefined();
  });

  it("emits a no_concrete_anchors warning when concreteness=0 and description exists", () => {
    const result = calculateConfidence({
      title: "ok",
      description: "just plain words without anchors of any kind",
      templateData: ALL_V2,
      templateFields: null,
    });
    expect(result.findings.find((f) => f.code === "no_concrete_anchors" && f.severity === "warning")).toBeDefined();
  });

  it("enriches an existing blocking suggestion with the cap ceiling on code collision", () => {
    const result = calculateConfidence({
      title: "",
      description: CONCRETE_DESC,
      templateData: ALL_V2,
      templateFields: null,
    });
    const titleFinding = result.findings.find((f) => f.code === "missing_title");
    expect(titleFinding).toBeDefined();
    expect(titleFinding?.suggestion).toContain("30");
  });
});

// ── Markdown spec sections in the description (friction-log 57–99) ──────────
// task_create v2 authors the whole spec as markdown in `description`; the
// scorer must honour `## Goal` / `## Acceptance Criteria` / ... headings the
// same way it honours structured templateData fields.

// SECTIONED_DESC now lives in
// frontend/src/lib/__fixtures__/confidence-fixtures.ts (task 79621590) — it
// was byte-identical to frontend's own copy of the same fixture.

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
      "## Scope (harness, mechanical)\n- backend/src/lib/confidence.ts\n## Acceptance criteria (mutation-testable)\n- decorated headings are recognized",
    );
    expect(s.scope).toBe("- backend/src/lib/confidence.ts");
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
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

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
    // Earns the section weights on top of title+description instead of
    // clamping to the historical 66-68 false-positive band.
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
    // Bodies avoid every VERIFICATION_SIGNAL word (test/run/curl/check/verify/
    // green/CI), so acPresent can only come from the section itself.
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

  it("structured templateData still satisfies fields when the description has no sections", () => {
    const result = calculateConfidence({
      title: "ok",
      description: CONCRETE_DESC,
      templateData: ALL_V2,
      templateFields: null,
    });
    expect(result.missing).toEqual([]);
  });

  it("decorated section headings stop the false missing_scope / missing_acceptance_criteria on the live corpus", () => {
    // The parenthetical-suffix heading style of the review-created tasks
    // (2026-07-02 session: tasks 348a4d42, c21b0def, 3a2543f3).
    const description = [
      "## Goal",
      "",
      "Recognize decorated headings in the scorer.",
      "",
      "## Scope (harness, mechanical)",
      "",
      "- backend/src/lib/confidence.ts normalizeHeading",
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
});
