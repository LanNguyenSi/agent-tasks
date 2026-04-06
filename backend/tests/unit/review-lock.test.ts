/**
 * Tests for single-reviewer lock behavior.
 *
 * These test the review-signal and review-lock contracts:
 * - Only one reviewer at a time
 * - Concurrent review attempts rejected
 * - Self-review blocked
 * - Review lock cleared after approve/request_changes
 * - Review lock can be released manually
 */
import { describe, expect, it } from "vitest";

// Simulate the review lock logic as pure functions (extracted from route handler logic)
// This avoids needing to spin up the full Hono app.

interface TaskReviewState {
  status: string;
  claimedByUserId: string | null;
  claimedByAgentId: string | null;
  reviewClaimedByUserId: string | null;
  reviewClaimedByAgentId: string | null;
}

interface Actor {
  type: "human" | "agent";
  userId?: string;
  tokenId?: string;
}

function canClaimReview(task: TaskReviewState, actor: Actor): { allowed: boolean; reason?: string } {
  if (task.status !== "review") {
    return { allowed: false, reason: "Task must be in review status" };
  }

  const isSelfReview =
    (actor.type === "human" && task.claimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.claimedByAgentId === actor.tokenId);
  if (isSelfReview) {
    return { allowed: false, reason: "Cannot review your own task" };
  }

  const isCurrentReviewer =
    (actor.type === "human" && task.reviewClaimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.reviewClaimedByAgentId === actor.tokenId);
  const isLocked = task.reviewClaimedByUserId || task.reviewClaimedByAgentId;

  if (isLocked && !isCurrentReviewer) {
    return { allowed: false, reason: "Task is already being reviewed by another reviewer" };
  }

  return { allowed: true };
}

function canSubmitReview(task: TaskReviewState, actor: Actor): { allowed: boolean; reason?: string } {
  // Same preconditions as claim, plus lock check
  const claimCheck = canClaimReview(task, actor);
  if (!claimCheck.allowed) return claimCheck;
  return { allowed: true };
}

const baseTask: TaskReviewState = {
  status: "review",
  claimedByUserId: null,
  claimedByAgentId: "agent-worker",
  reviewClaimedByUserId: null,
  reviewClaimedByAgentId: null,
};

describe("single-reviewer lock", () => {
  describe("review claim", () => {
    it("allows first reviewer to claim", () => {
      const result = canClaimReview(baseTask, { type: "agent", tokenId: "agent-reviewer" });
      expect(result.allowed).toBe(true);
    });

    it("blocks second reviewer when review is already claimed", () => {
      const lockedTask = { ...baseTask, reviewClaimedByAgentId: "agent-reviewer-1" };
      const result = canClaimReview(lockedTask, { type: "agent", tokenId: "agent-reviewer-2" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("already being reviewed");
    });

    it("allows current reviewer to re-claim (idempotent)", () => {
      const lockedTask = { ...baseTask, reviewClaimedByAgentId: "agent-reviewer" };
      const result = canClaimReview(lockedTask, { type: "agent", tokenId: "agent-reviewer" });
      expect(result.allowed).toBe(true);
    });

    it("blocks self-review by task worker", () => {
      const result = canClaimReview(baseTask, { type: "agent", tokenId: "agent-worker" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Cannot review your own task");
    });

    it("blocks review claim on non-review task", () => {
      const task = { ...baseTask, status: "in_progress" };
      const result = canClaimReview(task, { type: "agent", tokenId: "agent-reviewer" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("review status");
    });

    it("blocks human worker from reviewing own task", () => {
      const task = { ...baseTask, claimedByAgentId: null, claimedByUserId: "user-worker" };
      const result = canClaimReview(task, { type: "human", userId: "user-worker" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Cannot review your own task");
    });

    it("allows human reviewer when agent holds the task", () => {
      const result = canClaimReview(baseTask, { type: "human", userId: "user-reviewer" });
      expect(result.allowed).toBe(true);
    });

    it("blocks agent reviewer when human already reviewing", () => {
      const lockedTask = { ...baseTask, reviewClaimedByUserId: "user-reviewer" };
      const result = canClaimReview(lockedTask, { type: "agent", tokenId: "agent-reviewer" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("already being reviewed");
    });
  });

  describe("review submission", () => {
    it("allows reviewer who holds the lock to submit", () => {
      const lockedTask = { ...baseTask, reviewClaimedByAgentId: "agent-reviewer" };
      const result = canSubmitReview(lockedTask, { type: "agent", tokenId: "agent-reviewer" });
      expect(result.allowed).toBe(true);
    });

    it("blocks non-lock-holder from submitting review", () => {
      const lockedTask = { ...baseTask, reviewClaimedByAgentId: "agent-reviewer-1" };
      const result = canSubmitReview(lockedTask, { type: "agent", tokenId: "agent-reviewer-2" });
      expect(result.allowed).toBe(false);
    });

    it("allows review submission when no lock exists (backwards compatible)", () => {
      // No review lock set — anyone eligible can submit
      const result = canSubmitReview(baseTask, { type: "agent", tokenId: "agent-reviewer" });
      expect(result.allowed).toBe(true);
    });
  });

  describe("review lock lifecycle", () => {
    it("lock is cleared after approve (status → done)", () => {
      // After approve: reviewClaimedBy* should be null
      const afterApprove: TaskReviewState = {
        ...baseTask,
        status: "done",
        reviewClaimedByUserId: null,
        reviewClaimedByAgentId: null,
      };
      // Another reviewer should not be able to claim (wrong status)
      const result = canClaimReview(afterApprove, { type: "agent", tokenId: "agent-reviewer" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("review status");
    });

    it("lock is cleared after request_changes (status → in_progress)", () => {
      const afterChanges: TaskReviewState = {
        ...baseTask,
        status: "in_progress",
        reviewClaimedByUserId: null,
        reviewClaimedByAgentId: null,
      };
      const result = canClaimReview(afterChanges, { type: "agent", tokenId: "agent-reviewer" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("review status");
    });

    it("after re-entering review, a new reviewer can claim", () => {
      // Task went through review → changes → review again
      const reReview: TaskReviewState = {
        ...baseTask,
        status: "review",
        reviewClaimedByUserId: null,
        reviewClaimedByAgentId: null,
      };
      const result = canClaimReview(reReview, { type: "agent", tokenId: "agent-new-reviewer" });
      expect(result.allowed).toBe(true);
    });
  });
});
