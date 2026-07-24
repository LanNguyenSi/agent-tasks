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
  type TaskQualitySubscores,
} from "../../src/lib/confidence.js";

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

  it("caps at 40 when description is empty", () => {
    const result = calculateConfidence({
      title: "Some title",
      description: "",
      templateData: ALL_V2,
      templateFields: null,
    });
    expect(result.score).toBeLessThanOrEqual(40);
    expect(result.findings.find((f) => f.code === "missing_or_thin_description")).toBeDefined();
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

  it("does not affect score or findings (scoring-neutral bridge)", () => {
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
    expect(withType.findings).toEqual(withoutType.findings);
    expect(withType.subscores).toEqual(withoutType.subscores);
  });
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

// Exactly what a fully specced v2 create looks like: all seven scored sections
// as `##` headings with real bodies, templateData null.
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
