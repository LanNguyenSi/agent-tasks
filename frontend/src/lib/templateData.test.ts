import { describe, expect, it } from "vitest";
import { buildSavedTemplateData, type TemplateDataEdits } from "./templateData";
import type { TemplateData } from "./confidence";

/** The edits object a TaskDetail Save produces, seeded from `existing` exactly
 *  as initEditState does (every key, including ones with no rendered editor's
 *  value, comes from the stored templateData). */
function seedEdits(existing: TemplateData | null, overrides: Partial<TemplateDataEdits> = {}): TemplateDataEdits {
  return {
    goal: existing?.goal ?? "",
    acceptanceCriteria: existing?.acceptanceCriteria ?? "",
    context: existing?.context ?? "",
    constraints: existing?.constraints ?? "",
    scope: existing?.scope ?? "",
    outOfScope: existing?.outOfScope ?? "",
    dependencies: existing?.dependencies ?? "",
    risk: existing?.risk ?? "",
    agentPrompt: existing?.agentPrompt ?? "",
    taskType: existing?.taskType ?? "",
    ...overrides,
  };
}

describe("buildSavedTemplateData — Save data-loss fix", () => {
  it("a producer-set agentPrompt survives a human Save round-trip", () => {
    // A producer (e.g. the spec-slicer via MCP) populated executability fields
    // the human editor seeds but does not change.
    const existing: TemplateData = {
      goal: "Existing goal",
      agentPrompt: "1. Read the file. 2. Make the edit. 3. Run the tests.",
      scope: "src/foo.ts",
      taskType: "feature",
    };

    // The human only edits the title elsewhere; templateData editors are seeded
    // from `existing` and left untouched.
    const saved = buildSavedTemplateData(existing, seedEdits(existing));

    expect(saved?.agentPrompt).toBe("1. Read the file. 2. Make the edit. 3. Run the tests.");
    expect(saved?.scope).toBe("src/foo.ts");
    expect(saved?.taskType).toBe("feature");
    expect(saved?.goal).toBe("Existing goal");
  });

  it("carries through fields that have no editor at all (prefers)", () => {
    const existing: TemplateData = {
      acceptanceCriteria: "- it works",
      prefers: { smallDiffs: true, testBeforeImplementation: true },
    };

    const saved = buildSavedTemplateData(existing, seedEdits(existing));

    expect(saved?.prefers).toEqual({ smallDiffs: true, testBeforeImplementation: true });
    expect(saved?.acceptanceCriteria).toBe("- it works");
  });

  it("blanking a field deletes the key (full-replace clearing still works)", () => {
    const existing: TemplateData = { goal: "old goal", scope: "old scope" };

    // Human clears the goal textarea, keeps scope.
    const saved = buildSavedTemplateData(existing, seedEdits(existing, { goal: "" }));

    expect(saved?.goal).toBeUndefined();
    expect("goal" in (saved ?? {})).toBe(false);
    expect(saved?.scope).toBe("old scope");
  });

  it("trims editor values and ignores whitespace-only as empty", () => {
    const saved = buildSavedTemplateData(null, seedEdits(null, { goal: "  trimmed  ", risk: "   " }));
    expect(saved?.goal).toBe("trimmed");
    expect("risk" in (saved ?? {})).toBe(false);
  });

  it("returns null when nothing is set (preserves the prior no-templateData semantics)", () => {
    expect(buildSavedTemplateData(null, seedEdits(null))).toBeNull();
    expect(buildSavedTemplateData({}, seedEdits({}))).toBeNull();
  });

  it("a newly-typed field is added without disturbing existing ones", () => {
    const existing: TemplateData = { goal: "g", prefers: { smallDiffs: true } };
    const saved = buildSavedTemplateData(existing, seedEdits(existing, { risk: "Medium", taskType: "bugfix" }));
    expect(saved?.risk).toBe("Medium");
    expect(saved?.taskType).toBe("bugfix");
    expect(saved?.goal).toBe("g");
    expect(saved?.prefers).toEqual({ smallDiffs: true });
  });
});
