import { describe, expect, it } from "vitest";
import { evaluateWebhookPolicy } from "../../src/services/webhook-policy.js";

describe("evaluateWebhookPolicy", () => {
  describe("review_approved", () => {
    it("does not transition task status", () => {
      const result = evaluateWebhookPolicy({
        event: "review_approved",
        taskStatus: "review",
        reviewer: "alice",
      });
      expect(result.transition).toBeUndefined();
      expect(result.timelineMessage).toContain("approved by alice");
    });
  });

  describe("review_changes_requested", () => {
    it("transitions review → in_progress", () => {
      const result = evaluateWebhookPolicy({
        event: "review_changes_requested",
        taskStatus: "review",
        reviewer: "bob",
      });
      expect(result.transition).toEqual({ from: "review", to: "in_progress" });
      expect(result.timelineMessage).toContain("Changes requested by bob");
    });

    it("does not transition if task is not in review", () => {
      const result = evaluateWebhookPolicy({
        event: "review_changes_requested",
        taskStatus: "in_progress",
        reviewer: "bob",
      });
      expect(result.transition).toBeUndefined();
    });
  });

  describe("review_commented", () => {
    it("does not transition, adds timeline message", () => {
      const result = evaluateWebhookPolicy({
        event: "review_commented",
        taskStatus: "review",
        reviewer: "carol",
      });
      expect(result.transition).toBeUndefined();
      expect(result.timelineMessage).toContain("Review comment by carol");
    });
  });

  describe("review_dismissed", () => {
    it("does not transition", () => {
      const result = evaluateWebhookPolicy({
        event: "review_dismissed",
        taskStatus: "review",
        reviewer: "dave",
      });
      expect(result.transition).toBeUndefined();
      expect(result.timelineMessage).toContain("dismissed for dave");
    });
  });

  describe("pr_merged", () => {
    it("transitions any non-done status to done", () => {
      for (const status of ["open", "in_progress", "review"]) {
        const result = evaluateWebhookPolicy({
          event: "pr_merged",
          taskStatus: status,
          prNumber: 42,
        });
        expect(result.transition).toEqual({ from: status, to: "done" });
      }
    });

    it("does not transition if already done (idempotent)", () => {
      const result = evaluateWebhookPolicy({
        event: "pr_merged",
        taskStatus: "done",
        prNumber: 42,
      });
      expect(result.transition).toBeUndefined();
    });
  });

  describe("pr_closed", () => {
    it("does not transition task status", () => {
      const result = evaluateWebhookPolicy({
        event: "pr_closed",
        taskStatus: "review",
        prNumber: 42,
      });
      expect(result.transition).toBeUndefined();
      expect(result.timelineMessage).toContain("closed without merge");
    });
  });

  describe("pr_opened", () => {
    it("does not transition, adds timeline message", () => {
      const result = evaluateWebhookPolicy({
        event: "pr_opened",
        taskStatus: "in_progress",
        prNumber: 7,
      });
      expect(result.transition).toBeUndefined();
      expect(result.timelineMessage).toContain("PR #7 opened");
    });
  });

  describe("pr_synchronized", () => {
    it("does not transition, adds timeline message", () => {
      const result = evaluateWebhookPolicy({
        event: "pr_synchronized",
        taskStatus: "review",
        prNumber: 7,
      });
      expect(result.transition).toBeUndefined();
      expect(result.timelineMessage).toContain("new commits");
    });
  });
});
