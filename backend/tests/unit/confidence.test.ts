/**
 * Unit tests for `backend/src/lib/confidence.ts`.
 *
 * Closes the zero-coverage gap flagged by ADR-0011 Milestone 1. Covers:
 *  - `descriptionQuality()` heuristic bins
 *  - `calculateConfidence()` headline score + missing[] under each
 *    templateFields combination
 *  - All six score caps from §"Important: Add Score Caps"
 *  - All seven subscores reach 0 / partial / 100 with a fixture
 *  - Findings emission: each cap and each rule miss yields the expected
 *    finding code with the expected severity
 *
 * Pure function under test, no Prisma or HTTP setup required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  descriptionQuality,
  calculateConfidence,
  templateDataSchema,
  taskTemplateSchema,
  prefersSchema,
  type TaskQualitySubscores,
} from "../../src/lib/confidence.js";

const FULL_FIELDS = {
  goal: true,
  acceptanceCriteria: true,
  context: true,
  constraints: true,
};

const ALL_FILLED = {
  goal: "Add validation to user signup",
  acceptanceCriteria: "- Returns 400 on empty email\n- Returns 201 on valid",
  context: "Users currently hit a 500 when posting empty body",
  constraints: "No DB migration; keep existing schema",
};

describe("descriptionQuality", () => {
  it("returns 0 for empty input", () => {
    expect(descriptionQuality("")).toBe(0);
    expect(descriptionQuality("   ")).toBe(0);
  });

  it("rewards length up to ~300 chars then caps", () => {
    // Holding density roughly constant by appending the same varied content.
    const sentence = "Validation endpoint POST signup email schema error 400 ";
    const short = descriptionQuality(sentence);
    const long = descriptionQuality(sentence.repeat(6));   // ~300+ chars
    const longer = descriptionQuality(sentence.repeat(60)); // way past cap
    expect(long).toBeGreaterThan(short);
    // Length component caps; doubling beyond ~300 chars must not blow past 1.0
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

describe("calculateConfidence — rule activation", () => {
  it("counts only universally-required rules when no templateFields are set", () => {
    const result = calculateConfidence({
      title: "Do the thing",
      description: "A short description that meets the 0.4 quality bar with `code` and src/file.ts anchor",
      templateData: null,
      templateFields: null,
    });
    // title + description rules only (20 + 15 = 35 points)
    expect(result.missing).toEqual([]);
    expect(result.score).toBeGreaterThan(0);
  });

  it("activates a rule only when its templateField flag is true", () => {
    const result = calculateConfidence({
      title: "Do the thing",
      description: "A short description that meets the 0.4 quality bar with `code` and src/file.ts anchor",
      templateData: { goal: "ok" },
      templateFields: { goal: true, acceptanceCriteria: false, context: false, constraints: false },
    });
    expect(result.missing).not.toContain("acceptanceCriteria");
    expect(result.missing).not.toContain("context");
  });

  it("emits `missing` for inactive template fields that are present (skipped, not graded)", () => {
    const result = calculateConfidence({
      title: "Do the thing",
      description: "A short description that meets the 0.4 quality bar with `code` and src/file.ts anchor",
      templateData: { acceptanceCriteria: "- something" },
      templateFields: { goal: false, acceptanceCriteria: false, context: false, constraints: false },
    });
    expect(result.missing).not.toContain("acceptanceCriteria");
  });

  it("marks every required field as missing when nothing is provided (empty title)", () => {
    const result = calculateConfidence({
      title: "",
      description: "",
      templateData: null,
      templateFields: FULL_FIELDS,
    });
    expect(result.missing).toEqual(expect.arrayContaining([
      "title",
      "description",
      "goal",
      "acceptanceCriteria",
      "context",
      "constraints",
    ]));
  });
});

describe("calculateConfidence — score caps (ADR-0011)", () => {
  // The console.info log is fine but noisy. Re-spy per test so the
  // afterEach restore doesn't leave subsequent tests with a detached spy.
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => infoSpy.mockRestore());

  it("caps at 30 when title is empty", () => {
    const result = calculateConfidence({
      title: "",
      description: "Decent description with `code` and a src/file.ts anchor that meets quality",
      templateData: ALL_FILLED,
      templateFields: FULL_FIELDS,
    });
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.findings.find((f) => f.code === "missing_title")).toBeDefined();
  });

  it("caps at 40 when description is empty", () => {
    const result = calculateConfidence({
      title: "Some title",
      description: "",
      templateData: ALL_FILLED,
      templateFields: FULL_FIELDS,
    });
    expect(result.score).toBeLessThanOrEqual(40);
    expect(result.findings.find((f) => f.code === "missing_or_thin_description")).toBeDefined();
  });

  it("caps at 70 when goal is missing (and goal is active)", () => {
    const result = calculateConfidence({
      title: "Some title",
      description: "Decent description with `code` and a src/file.ts anchor that meets quality",
      templateData: { ...ALL_FILLED, goal: "" },
      templateFields: FULL_FIELDS,
    });
    expect(result.score).toBeLessThanOrEqual(70);
    expect(result.findings.find((f) => f.code === "missing_goal")).toBeDefined();
  });

  it("caps at 80 when acceptanceCriteria is missing (and AC is active)", () => {
    const result = calculateConfidence({
      title: "Some title",
      description: "Decent description with `code` and a src/file.ts anchor that meets quality",
      templateData: { ...ALL_FILLED, acceptanceCriteria: "" },
      templateFields: FULL_FIELDS,
    });
    expect(result.score).toBeLessThanOrEqual(80);
    expect(result.findings.find((f) => f.code === "missing_acceptance_criteria")).toBeDefined();
  });

  it("caps at 85 when no verification path (no AC, no constraints, no signal regex)", () => {
    const result = calculateConfidence({
      title: "Some title",
      // A scope marker ("only"/"keep") and a should-style verb hold scopeClarity
      // and testability at 60 so the binding cap stays missing_verification (85),
      // not the stricter subscore caps. "should" is a testability signal but NOT
      // one of the missing_verification regex words (test/run/curl/check/verify/
      // green/CI), so the 85 cap still fires.
      description: "Decent description with `code` and a src/file.ts anchor; only the handler should change, keep the rest",
      templateData: { goal: "ok", acceptanceCriteria: "", context: "ok", constraints: "" },
      templateFields: { goal: true, acceptanceCriteria: false, context: true, constraints: false },
    });
    expect(result.score).toBeLessThanOrEqual(85);
    // Pin 85 as the BINDING cap: the stricter subscore caps must not fire here.
    expect(result.findings.find((f) => f.code === "low_testability")).toBeUndefined();
    expect(result.findings.find((f) => f.code === "low_scope_clarity")).toBeUndefined();
    const finding = result.findings.find((f) => f.code === "missing_verification");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
  });

  it("does NOT cap at 85 when description contains a verification signal", () => {
    const result = calculateConfidence({
      title: "Some title",
      description: "Decent description; verify with `curl /api/health` against ci/build/1234",
      templateData: { goal: "ok", acceptanceCriteria: "", context: "ok", constraints: "" },
      templateFields: { goal: true, acceptanceCriteria: false, context: true, constraints: false },
    });
    expect(result.findings.find((f) => f.code === "missing_verification")).toBeUndefined();
  });

  it("caps at 75 when ambiguity hits >= 3 and no concrete anchors", () => {
    const result = calculateConfidence({
      title: "Some title",
      description: "We should fix this, improve that, and optimize the system somehow quickly",
      templateData: ALL_FILLED,
      templateFields: FULL_FIELDS,
    });
    expect(result.score).toBeLessThanOrEqual(75);
    const finding = result.findings.find((f) => f.code === "ambiguous_scope");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
  });

  it("strictest cap wins when multiple apply (no title + no AC → 30, not 80)", () => {
    const result = calculateConfidence({
      title: "",
      description: "Decent description with `code` and a src/file.ts anchor that meets quality",
      templateData: { ...ALL_FILLED, acceptanceCriteria: "" },
      templateFields: FULL_FIELDS,
    });
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.findings.find((f) => f.code === "missing_title")).toBeDefined();
    expect(result.findings.find((f) => f.code === "missing_acceptance_criteria")).toBeDefined();
  });

  it("logs one info-level line when a cap fires", () => {
    calculateConfidence({
      title: "",
      description: "Decent description with `code` and a src/file.ts anchor that meets quality",
      templateData: ALL_FILLED,
      templateFields: FULL_FIELDS,
    });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("confidence.score_capped");
  });

  it("does NOT log when no cap fires", () => {
    calculateConfidence({
      title: "Add request-id middleware",
      description: "Decent description with `code` and a src/file.ts anchor that meets quality",
      templateData: ALL_FILLED,
      templateFields: FULL_FIELDS,
    });
    expect(infoSpy).not.toHaveBeenCalled();
  });
});

describe("calculateConfidence — subscore-driven caps (scorer-v2 T1)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => infoSpy.mockRestore());

  it("caps at 70 (low_testability) when there is no AC and no test/verify language", () => {
    const result = calculateConfidence({
      title: "Add request-id middleware",
      description: "Add `requestId` middleware in src/middleware/request-id.ts and wire it into app.ts",
      // AC not graded as a rule here, but the testability subscore still reads it
      templateData: { goal: "trace requests", context: "debugging is hard", constraints: "no new deps" },
      templateFields: { goal: true, acceptanceCriteria: false, context: true, constraints: true },
    });
    expect(result.subscores.testability).toBe(0);
    expect(result.score).toBeLessThanOrEqual(70);
    const finding = result.findings.find((f) => f.code === "low_testability");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(finding?.dimension).toBe("testability");
  });

  it("caps at 75 (low_scope_clarity) when there are no constraints and no scope markers", () => {
    const result = calculateConfidence({
      title: "Add caching layer",
      description: "Add an LRU cache in src/cache.ts for the slow lookups",
      templateData: { goal: "speed up lookups", acceptanceCriteria: "- p99 latency < 50ms", context: "slow queries" },
      templateFields: { goal: true, acceptanceCriteria: true, context: true, constraints: false },
    });
    expect(result.subscores.testability).toBe(100); // AC present → not a testability cap
    expect(result.subscores.scopeClarity).toBe(0);
    expect(result.score).toBeLessThanOrEqual(75);
    expect(result.findings.find((f) => f.code === "low_scope_clarity")?.dimension).toBe("scopeClarity");
  });

  it("caps at 80 (low_concreteness) when the description has no concrete anchors", () => {
    const result = calculateConfidence({
      title: "Rewrite onboarding copy",
      description: "Rewrite the onboarding welcome text to be friendlier and shorter for brand new people",
      templateData: { goal: "friendlier onboarding", acceptanceCriteria: "- copy approved by design", context: "users confused", constraints: "do not change layout" },
      templateFields: FULL_FIELDS,
    });
    expect(result.subscores.concreteness).toBe(0);
    expect(result.score).toBeLessThanOrEqual(80);
    expect(result.findings.find((f) => f.code === "low_concreteness")?.dimension).toBe("concreteness");
  });

  it("does NOT apply any subscore cap to a task strong on all three dimensions", () => {
    const result = calculateConfidence({
      title: "Add request-id middleware",
      description: "Add `requestId` in src/middleware/request-id.ts; verify via `curl` that the response carries the header; expect 200",
      templateData: ALL_FILLED,
      templateFields: FULL_FIELDS,
    });
    for (const code of ["low_testability", "low_scope_clarity", "low_concreteness"]) {
      expect(result.findings.find((f) => f.code === code), `unexpected ${code}`).toBeUndefined();
    }
    expect(result.score).toBeGreaterThan(80);
  });

  it("AC2: an otherwise-strong but unverifiable task scores measurably lower than the verifiable one", () => {
    const common = {
      title: "Add caching layer",
      description: "Add an LRU cache in src/cache.ts for the slow lookups",
      templateFields: { goal: true, acceptanceCriteria: false, context: true, constraints: true },
    } as const;
    const verifiable = calculateConfidence({
      ...common,
      templateData: { goal: "speed up lookups", acceptanceCriteria: "- p99 latency < 50ms", context: "slow queries", constraints: "no new deps" },
    });
    const unverifiable = calculateConfidence({
      ...common,
      templateData: { goal: "speed up lookups", acceptanceCriteria: "", context: "slow queries", constraints: "no new deps" },
    });
    expect(unverifiable.score).toBeLessThan(verifiable.score);
    expect(unverifiable.score).toBeLessThanOrEqual(70);
  });

  it("AC3: subscore caps stay at/above the default threshold (60), so they do not newly block at the default", () => {
    // A task missing only the verification path is capped by low_testability,
    // but the cap ceiling (70) is above the default confidenceThreshold (60),
    // so it still passes the default gate — the warn-mode property.
    const result = calculateConfidence({
      title: "Add request-id middleware",
      description: "Add `requestId` middleware in src/middleware/request-id.ts and wire it into app.ts",
      templateData: { goal: "trace requests", context: "debugging is hard", constraints: "no new deps" },
      templateFields: { goal: true, acceptanceCriteria: false, context: true, constraints: true },
    });
    expect(result.findings.find((f) => f.code === "low_testability")).toBeDefined();
    expect(result.score).toBeGreaterThanOrEqual(60);
  });
});

describe("calculateConfidence — subscores", () => {
  // Score caps still apply during these tests; silence the log.
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
      description: "a ".repeat(200), // long, no context field
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
      description: "Decent description with `code` and src/file.ts anchor that meets quality",
      templateData: { ...ALL_FILLED, taskType: "bugfix" },
      templateFields: FULL_FIELDS,
    });
    expect(result.inferredTaskType).toBe("bugfix");
  });

  it("returns undefined when templateData has no taskType", () => {
    const result = calculateConfidence({
      title: "Some task",
      description: "Decent description with `code` and src/file.ts anchor that meets quality",
      templateData: ALL_FILLED,
      templateFields: FULL_FIELDS,
    });
    expect(result.inferredTaskType).toBeUndefined();
  });

  it("does not affect score or findings (scoring-neutral bridge)", () => {
    const withType = calculateConfidence({
      title: "ok",
      description: "ok ok ok",
      templateData: { ...ALL_FILLED, taskType: "security" },
      templateFields: FULL_FIELDS,
    });
    const withoutType = calculateConfidence({
      title: "ok",
      description: "ok ok ok",
      templateData: ALL_FILLED,
      templateFields: FULL_FIELDS,
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
      expect(parsed.data.fields.outOfScope).toBe(false); // defaulted
      expect(parsed.data.fields.dependencies).toBe(false);
    }
  });

  it("backward-compat: old-shape templateData and empty payloads still parse", () => {
    expect(templateDataSchema.safeParse({ goal: "g", acceptanceCriteria: "a", context: "c", constraints: "k" }).success).toBe(true);
    expect(templateDataSchema.safeParse({}).success).toBe(true);
  });

  it("scoring-neutral: the new fields do not change score, findings, or subscores (T2 stores, does not weight)", () => {
    const base = {
      title: "Add request-id middleware",
      description: "Add `requestId` in src/middleware/request-id.ts; verify via `curl` returns the header; expect 200",
      templateFields: FULL_FIELDS,
    } as const;
    const without = calculateConfidence({ ...base, templateData: ALL_FILLED });
    const withNew = calculateConfidence({
      ...base,
      templateData: {
        ...ALL_FILLED,
        scope: "src/middleware",
        outOfScope: "no router change",
        dependencies: "none",
        risk: "low",
        agentPrompt: "Step 1: add the middleware",
        prefers: { smallDiffs: true },
      },
    });
    expect(withNew.score).toBe(without.score);
    expect(withNew.findings).toEqual(without.findings);
    expect(withNew.subscores).toEqual(without.subscores);
  });
});

describe("calculateConfidence — findings", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("emits a blocking finding for each rule miss", () => {
    const result = calculateConfidence({
      title: "",
      description: "",
      templateData: null,
      templateFields: FULL_FIELDS,
    });
    // The 6 rule-driven codes that map to MISS_FINDINGS. Cap-only codes
    // (e.g. `missing_verification`) are appended as `warning` findings and
    // are not part of this rule-driven set.
    const RULE_DRIVEN_CODES = [
      "missing_title",
      "missing_or_thin_description",
      "missing_goal",
      "missing_acceptance_criteria",
      "missing_context",
      "missing_constraints",
    ];
    for (const code of RULE_DRIVEN_CODES) {
      const finding = result.findings.find((f) => f.code === code);
      expect(finding, `expected blocking finding ${code}`).toBeDefined();
      expect(finding?.severity).toBe("blocking");
    }
  });

  it("emits a vague_language warning when ambiguity drops below threshold", () => {
    const result = calculateConfidence({
      title: "ok",
      description: "should fix improve optimize this somehow with src/file.ts anchor",
      templateData: ALL_FILLED,
      templateFields: FULL_FIELDS,
    });
    expect(result.findings.find((f) => f.code === "vague_language" && f.severity === "warning")).toBeDefined();
  });

  it("emits a no_concrete_anchors warning when concreteness=0 and description exists", () => {
    const result = calculateConfidence({
      title: "ok",
      description: "just plain words without anchors of any kind",
      templateData: ALL_FILLED,
      templateFields: FULL_FIELDS,
    });
    expect(result.findings.find((f) => f.code === "no_concrete_anchors" && f.severity === "warning")).toBeDefined();
  });

  it("enriches an existing blocking suggestion with the cap ceiling on code collision", () => {
    const result = calculateConfidence({
      title: "",
      description: "Decent description with `code` and a src/file.ts anchor that meets quality",
      templateData: ALL_FILLED,
      templateFields: FULL_FIELDS,
    });
    const titleFinding = result.findings.find((f) => f.code === "missing_title");
    expect(titleFinding).toBeDefined();
    expect(titleFinding?.suggestion).toContain("30");
  });
});
