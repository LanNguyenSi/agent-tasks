import { describe, expect, it } from "vitest";
import {
  RULE_CATALOG,
  RULE_EVALUATORS,
  RULE_MESSAGES,
} from "../../src/services/transition-rules.js";

describe("RULE_CATALOG", () => {
  it("has an entry for every evaluator", () => {
    const catalogIds = new Set(RULE_CATALOG.map((r) => r.id));
    const evaluatorIds = new Set(Object.keys(RULE_EVALUATORS));
    expect(catalogIds).toEqual(evaluatorIds);
  });

  it("each entry has non-empty label/description/failureMessage", () => {
    for (const entry of RULE_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.failureMessage.length).toBeGreaterThan(0);
    }
  });

  it("failureMessage matches RULE_MESSAGES exactly", () => {
    for (const entry of RULE_CATALOG) {
      expect(entry.failureMessage).toBe(RULE_MESSAGES[entry.id]);
    }
  });

  it("ids are sorted / stable (not strictly required but nice for clients)", () => {
    // The catalog order is the render order in the UI — assert it explicitly
    // so reordering requires a conscious change.
    expect(RULE_CATALOG.map((r) => r.id)).toEqual(["branchPresent", "prPresent", "ciGreen"]);
  });
});
