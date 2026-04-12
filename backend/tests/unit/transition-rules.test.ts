import { describe, expect, it } from "vitest";
import {
  evaluateTransitionRules,
  isKnownRule,
  RULE_EVALUATORS,
  RULE_MESSAGES,
} from "../../src/services/transition-rules.js";

const emptyCtx = { branchName: null, prUrl: null, prNumber: null };

describe("transition rules", () => {
  describe("branchPresent", () => {
    it("fails when branchName is null", () => {
      expect(RULE_EVALUATORS.branchPresent(emptyCtx)).toBe(false);
    });

    it("fails when branchName is whitespace", () => {
      expect(RULE_EVALUATORS.branchPresent({ ...emptyCtx, branchName: "   " })).toBe(false);
    });

    it("passes when branchName is set", () => {
      expect(RULE_EVALUATORS.branchPresent({ ...emptyCtx, branchName: "feat/x" })).toBe(true);
    });
  });

  describe("prPresent", () => {
    it("fails when both prUrl and prNumber are null", () => {
      expect(RULE_EVALUATORS.prPresent(emptyCtx)).toBe(false);
    });

    it("fails when only prUrl is set (no number)", () => {
      expect(
        RULE_EVALUATORS.prPresent({ ...emptyCtx, prUrl: "https://github.com/x/y/pull/1" }),
      ).toBe(false);
    });

    it("fails when only prNumber is set (no URL)", () => {
      expect(RULE_EVALUATORS.prPresent({ ...emptyCtx, prNumber: 1 })).toBe(false);
    });

    it("passes when both are set", () => {
      expect(
        RULE_EVALUATORS.prPresent({
          branchName: "feat/x",
          prUrl: "https://github.com/x/y/pull/1",
          prNumber: 1,
        }),
      ).toBe(true);
    });
  });

  describe("isKnownRule", () => {
    it("recognises built-ins", () => {
      expect(isKnownRule("branchPresent")).toBe(true);
      expect(isKnownRule("prPresent")).toBe(true);
    });

    it("rejects unknown names", () => {
      expect(isKnownRule("docsTouched")).toBe(false);
      expect(isKnownRule("")).toBe(false);
    });
  });

  describe("evaluateTransitionRules", () => {
    it("returns empty results when rules list is empty", () => {
      expect(evaluateTransitionRules([], emptyCtx)).toEqual({ failed: [], unknown: [] });
      expect(evaluateTransitionRules(undefined, emptyCtx)).toEqual({ failed: [], unknown: [] });
    });

    it("collects failed rules but not passing ones", () => {
      const result = evaluateTransitionRules(
        ["branchPresent", "prPresent"],
        { branchName: "feat/x", prUrl: null, prNumber: null },
      );
      expect(result.failed).toEqual(["prPresent"]);
      expect(result.unknown).toEqual([]);
    });

    it("reports unknown rules separately and does not fail on them", () => {
      const result = evaluateTransitionRules(
        ["branchPresent", "docsTouched", "nonsense"],
        { branchName: "feat/x", prUrl: null, prNumber: null },
      );
      expect(result.failed).toEqual([]);
      expect(result.unknown).toEqual(["docsTouched", "nonsense"]);
    });

    it("passes cleanly when everything is satisfied", () => {
      const result = evaluateTransitionRules(
        ["branchPresent", "prPresent"],
        { branchName: "feat/x", prUrl: "https://github.com/x/y/pull/1", prNumber: 1 },
      );
      expect(result.failed).toEqual([]);
      expect(result.unknown).toEqual([]);
    });
  });

  describe("RULE_MESSAGES", () => {
    it("has a message for every known rule", () => {
      for (const rule of Object.keys(RULE_EVALUATORS)) {
        expect(RULE_MESSAGES[rule as keyof typeof RULE_MESSAGES]).toBeTruthy();
      }
    });
  });
});
