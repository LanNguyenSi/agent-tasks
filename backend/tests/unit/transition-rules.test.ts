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
    it("returns empty results when rules list is empty", async () => {
      await expect(evaluateTransitionRules([], emptyCtx)).resolves.toEqual({
        failed: [],
        unknown: [],
        errors: {},
      });
      await expect(evaluateTransitionRules(undefined, emptyCtx)).resolves.toEqual({
        failed: [],
        unknown: [],
        errors: {},
      });
    });

    it("collects failed rules but not passing ones", async () => {
      const result = await evaluateTransitionRules(
        ["branchPresent", "prPresent"],
        { branchName: "feat/x", prUrl: null, prNumber: null },
      );
      expect(result.failed).toEqual(["prPresent"]);
      expect(result.unknown).toEqual([]);
    });

    it("reports unknown rules separately and does not fail on them", async () => {
      const result = await evaluateTransitionRules(
        ["branchPresent", "docsTouched", "nonsense"],
        { branchName: "feat/x", prUrl: null, prNumber: null },
      );
      expect(result.failed).toEqual([]);
      expect(result.unknown).toEqual(["docsTouched", "nonsense"]);
    });

    it("passes cleanly when everything is satisfied", async () => {
      const result = await evaluateTransitionRules(
        ["branchPresent", "prPresent"],
        { branchName: "feat/x", prUrl: "https://github.com/x/y/pull/1", prNumber: 1 },
      );
      expect(result.failed).toEqual([]);
      expect(result.unknown).toEqual([]);
    });

    it("ciGreen fails closed when prNumber is missing", async () => {
      const result = await evaluateTransitionRules(["ciGreen"], {
        branchName: "feat/x",
        prUrl: null,
        prNumber: null,
        projectGithubRepo: "owner/repo",
        githubToken: "tok",
      });
      expect(result.failed).toEqual(["ciGreen"]);
    });

    it("ciGreen fails closed when githubToken is missing", async () => {
      const result = await evaluateTransitionRules(["ciGreen"], {
        branchName: "feat/x",
        prUrl: "x",
        prNumber: 1,
        projectGithubRepo: "owner/repo",
        githubToken: null,
      });
      expect(result.failed).toEqual(["ciGreen"]);
    });

    it("failed array preserves the order of the input rules list", async () => {
      // Async evaluation must not reorder results — the user-visible 422
      // message string depends on iteration order.
      const result = await evaluateTransitionRules(
        ["prPresent", "branchPresent"],
        { branchName: null, prUrl: null, prNumber: null },
      );
      expect(result.failed).toEqual(["prPresent", "branchPresent"]);
    });

    it("non-GithubChecksError errors collapse to a generic message", async () => {
      // Any unexpected throw should not leak internal error text to the
      // client. Only GithubChecksError gets its status surfaced.
      const { RULE_EVALUATORS } = await import("../../src/services/transition-rules.js");
      const original = RULE_EVALUATORS.ciGreen;
      (RULE_EVALUATORS as { ciGreen: typeof original }).ciGreen = async () => {
        throw new Error("secret token ghs_abc123");
      };
      try {
        const result = await evaluateTransitionRules(["ciGreen"], {
          branchName: "x",
          prUrl: "x",
          prNumber: 1,
          projectGithubRepo: "o/r",
          githubToken: "tok",
        });
        expect(result.failed).toEqual(["ciGreen"]);
        expect(result.errors.ciGreen).toBe("Rule evaluation error");
        expect(result.errors.ciGreen).not.toContain("ghs_abc123");
      } finally {
        (RULE_EVALUATORS as { ciGreen: typeof original }).ciGreen = original;
      }
    });

    it("ciGreen fails closed when projectGithubRepo is missing", async () => {
      const result = await evaluateTransitionRules(["ciGreen"], {
        branchName: "feat/x",
        prUrl: "x",
        prNumber: 1,
        projectGithubRepo: null,
        githubToken: "tok",
      });
      expect(result.failed).toEqual(["ciGreen"]);
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
