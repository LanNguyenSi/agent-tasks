import { describe, it, expect } from "vitest";
import { humanizeField } from "../../src/lib/humanizeField";

describe("humanizeField", () => {
  it.each([
    ["acceptanceCriteria", "Acceptance Criteria"],
    ["goal", "Goal"],
    ["suggestedTests", "Suggested Tests"],
    ["", ""],
  ])("%s -> %s", (key, label) => {
    expect(humanizeField(key)).toBe(label);
  });
});
