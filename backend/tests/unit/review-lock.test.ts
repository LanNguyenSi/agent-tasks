/**
 * Tests for single-reviewer lock behavior and the distinct-reviewer gate.
 *
 * These test the review-signal and review-lock contracts:
 * - Only one reviewer at a time
 * - Concurrent review attempts rejected
 * - Self-review blocked
 * - Review lock cleared after approve/request_changes
 * - Review lock can be released manually
 * - Distinct-reviewer gate on review→done (opt-in, per project)
 *
 * The distinct-reviewer gate is imported directly from
 * `backend/src/services/review-gate.ts` so the test cannot drift from
 * the production rule — any change to the gate is observed by the suite.
 */
import { describe, expect, it } from "vitest";
import { checkDistinctReviewerGate } from "../../src/services/review-gate.js";
import type { Actor as BackendActor } from "../../src/types/auth.js";

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

/**
 * Thin adapter over the production gate to let the existing describe
 * blocks in this file keep their current signature (legacy local `Actor`
 * type from the top of the file, `force` flag that the production gate
 * does NOT model). The adapter applies the `force` bypass and normalises
 * the actor shape — the core rule is read from the shared service.
 */
function canTransitionReviewToDone(
  task: TaskReviewState,
  actor: Actor,
  project: { requireDistinctReviewer: boolean },
  force: boolean,
): { allowed: boolean; reason?: string } {
  if (force) return { allowed: true };
  const productionActor: BackendActor = actor.type === "human"
    ? { type: "human", userId: actor.userId! }
    : { type: "agent", tokenId: actor.tokenId!, teamId: "team-test", scopes: [] };
  return checkDistinctReviewerGate(task, productionActor, project);
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

/**
 * Mirror of the merge-endpoint status + gate decision tree in
 * `backend/src/routes/github.ts`. Same discipline as
 * `canTransitionReviewToDone` above: the real handler imports the shared
 * `checkDistinctReviewerGate` service, and this helper does too, so the
 * only thing that could drift is the surrounding status branching. A
 * future refactor should extract both into
 * `backend/src/services/review-gate.ts` — kept as a local mirror here
 * to match the existing pattern in this file.
 */
type MergeDecision =
  | { outcome: "allow" }
  | { outcome: "reject_status"; reason: string }
  | { outcome: "reject_gate"; reason: string };

function mergeDecision(
  task: TaskReviewState,
  actor: Actor,
  project: { requireDistinctReviewer: boolean },
): MergeDecision {
  if (task.status === "open" || task.status === "in_progress") {
    return {
      outcome: "reject_status",
      reason: `Cannot merge: task is in '${task.status}', expected 'review'.`,
    };
  }
  if (task.status !== "review" && task.status !== "done") {
    return {
      outcome: "reject_status",
      reason: `Cannot merge: task is in '${task.status}', expected 'review' or 'done'.`,
    };
  }
  // `done` is the idempotent re-entry path; the gate was evaluated the
  // first time the task reached done and re-checking would reject
  // admin-force-transitioned tasks that never held a review lock.
  if (task.status === "done") return { outcome: "allow" };

  const productionActor: BackendActor = actor.type === "human"
    ? { type: "human", userId: actor.userId! }
    : { type: "agent", tokenId: actor.tokenId!, teamId: "team-test", scopes: [] };
  const gate = checkDistinctReviewerGate(task, productionActor, project);
  if (!gate.allowed) {
    return { outcome: "reject_gate", reason: gate.reason ?? "unknown" };
  }
  return { outcome: "allow" };
}

describe("distinct-reviewer gate on review→done transition", () => {
  const claimantAgent: Actor = { type: "agent", tokenId: "agent-worker" };
  const otherAgent: Actor = { type: "agent", tokenId: "agent-reviewer" };
  const claimantHuman: Actor = { type: "human", userId: "user-worker" };
  const otherHuman: Actor = { type: "human", userId: "user-reviewer" };

  describe("flag disabled (backwards compatible)", () => {
    it("allows the claimant to self-transition when flag is off", () => {
      // This is the TODAY behaviour — preserved so existing projects
      // keep working when the migration lands and the field defaults to
      // false on all rows.
      const result = canTransitionReviewToDone(
        baseTask,
        claimantAgent,
        { requireDistinctReviewer: false },
        false,
      );
      expect(result.allowed).toBe(true);
    });

    it("ignores all other gate conditions when flag is off", () => {
      const result = canTransitionReviewToDone(
        { ...baseTask, reviewClaimedByAgentId: "agent-worker" },
        claimantAgent,
        { requireDistinctReviewer: false },
        false,
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("flag enabled", () => {
    it("rejects the claimant transitioning their own task", () => {
      const result = canTransitionReviewToDone(
        baseTask,
        claimantAgent,
        { requireDistinctReviewer: true },
        false,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("self_review");
    });

    it("rejects a distinct actor when no review lock is set", () => {
      // Even a different agent cannot short-circuit the review flow by
      // hitting /transition directly — they must go through /review/claim
      // first. This forces an audit trail.
      const result = canTransitionReviewToDone(
        baseTask,
        otherAgent,
        { requireDistinctReviewer: true },
        false,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("no_review_lock");
    });

    it("rejects when the review lock is held by the claimant (belt-and-suspenders)", () => {
      // /review/claim already blocks self-claim, so this state should
      // not arise normally. Guard against schema-level edits / admin UI
      // / race conditions that could leave the lock held by the same
      // actor who owns the task.
      const result = canTransitionReviewToDone(
        { ...baseTask, reviewClaimedByAgentId: "agent-worker" },
        otherAgent,
        { requireDistinctReviewer: true },
        false,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("review_lock_held_by_claimant");
    });

    it("allows a distinct reviewer who holds the lock to approve", () => {
      // The happy path: agent A claimed the task, agent B claimed the
      // review lock, agent B now transitions to done.
      const result = canTransitionReviewToDone(
        { ...baseTask, reviewClaimedByAgentId: "agent-reviewer" },
        otherAgent,
        { requireDistinctReviewer: true },
        false,
      );
      expect(result.allowed).toBe(true);
    });

    it("allows a human reviewer approving an agent's task", () => {
      const humanReviewed: TaskReviewState = {
        ...baseTask,
        reviewClaimedByUserId: "user-reviewer",
        reviewClaimedByAgentId: null,
      };
      const result = canTransitionReviewToDone(
        humanReviewed,
        otherHuman,
        { requireDistinctReviewer: true },
        false,
      );
      expect(result.allowed).toBe(true);
    });

    it("rejects a human claimant transitioning their own task", () => {
      const humanClaimed: TaskReviewState = {
        ...baseTask,
        claimedByAgentId: null,
        claimedByUserId: "user-worker",
      };
      const result = canTransitionReviewToDone(
        humanClaimed,
        claimantHuman,
        { requireDistinctReviewer: true },
        false,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("self_review");
    });
  });

  describe("force bypass", () => {
    it("admin force=true bypasses the gate even when flag is on", () => {
      // The escape hatch for operational recovery. The existing admin
      // check in routes/tasks.ts still gates who can pass force=true,
      // so this is NOT a general self-review allow — only admins reach
      // this code path with force=true.
      const result = canTransitionReviewToDone(
        baseTask,
        claimantAgent,
        { requireDistinctReviewer: true },
        true,
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("merge endpoint gates (review→done via GitHub merge path)", () => {
    // Rejects any task that's not past the review step. Closes the gap
    // where POST /api/github/pull-requests/:prNumber/merge would fast-
    // track an `open` or `in_progress` task straight to `done`.
    const reviewerAgent: Actor = { type: "agent", tokenId: "agent-reviewer" };
    const claimantAgent: Actor = { type: "agent", tokenId: "agent-worker" };

    it("rejects a task in 'open' with a helpful status message", () => {
      const result = mergeDecision(
        { ...baseTask, status: "open" },
        reviewerAgent,
        { requireDistinctReviewer: false },
      );
      expect(result.outcome).toBe("reject_status");
      if (result.outcome === "reject_status") {
        expect(result.reason).toContain("'open'");
        expect(result.reason).toContain("expected 'review'");
      }
    });

    it("rejects a task in 'in_progress'", () => {
      const result = mergeDecision(
        { ...baseTask, status: "in_progress" },
        reviewerAgent,
        { requireDistinctReviewer: false },
      );
      expect(result.outcome).toBe("reject_status");
      if (result.outcome === "reject_status") {
        expect(result.reason).toContain("'in_progress'");
      }
    });

    it("allows a task in 'review' when the flag is off (backwards compatible)", () => {
      const result = mergeDecision(
        { ...baseTask, status: "review" },
        reviewerAgent,
        { requireDistinctReviewer: false },
      );
      expect(result.outcome).toBe("allow");
    });

    it("allows a distinct reviewer to merge when the flag is on and the lock is held", () => {
      const lockedTask: TaskReviewState = {
        ...baseTask,
        status: "review",
        reviewClaimedByAgentId: "agent-reviewer",
      };
      const result = mergeDecision(
        lockedTask,
        reviewerAgent,
        { requireDistinctReviewer: true },
      );
      expect(result.outcome).toBe("allow");
    });

    it("rejects the claimant trying to merge their own task when the flag is on", () => {
      const result = mergeDecision(
        { ...baseTask, status: "review" },
        claimantAgent,
        { requireDistinctReviewer: true },
      );
      expect(result.outcome).toBe("reject_gate");
      if (result.outcome === "reject_gate") {
        expect(result.reason).toBe("self_review");
      }
    });

    it("rejects a review→merge when the flag is on but no review lock is set", () => {
      // A distinct agent calling merge without first taking the review
      // lock. Forces the lock-then-merge workflow so every merge under
      // the flag has a recorded reviewer identity.
      const result = mergeDecision(
        { ...baseTask, status: "review" },
        reviewerAgent,
        { requireDistinctReviewer: true },
      );
      expect(result.outcome).toBe("reject_gate");
      if (result.outcome === "reject_gate") {
        expect(result.reason).toBe("no_review_lock");
      }
    });

    it("allows a task already in 'done' as the idempotent re-entry path (no gate re-check)", () => {
      // Task was previously moved to `done` (either normally or via
      // admin force-transition). Calling merge again against an
      // already-merged PR or a not-yet-merged PR should proceed to the
      // GitHub call — the gate was evaluated at the original review→done
      // and re-checking would spuriously reject admin-forced tasks that
      // never held a review lock.
      const result = mergeDecision(
        { ...baseTask, status: "done" },
        claimantAgent,
        { requireDistinctReviewer: true },
      );
      expect(result.outcome).toBe("allow");
    });

    it("still allows 'done' idempotency with the flag off", () => {
      const result = mergeDecision(
        { ...baseTask, status: "done" },
        reviewerAgent,
        { requireDistinctReviewer: false },
      );
      expect(result.outcome).toBe("allow");
    });
  });

  describe("production gate (imported from review-gate.ts)", () => {
    // Call the production gate directly, not through the adapter above,
    // so regressions in the imported module fail the suite immediately
    // rather than being hidden by the adapter's legacy Actor shape.
    it("returns the same shape the route handler reads", () => {
      const humanActor: BackendActor = { type: "human", userId: "user-worker" };
      const result = checkDistinctReviewerGate(
        { ...baseTask, claimedByAgentId: null, claimedByUserId: "user-worker" },
        humanActor,
        { requireDistinctReviewer: true },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("self_review");
    });

    it("treats humans and agents identically on the gate (governance decision)", () => {
      // Open question #1 from the task description: humans are bound by
      // the gate too. Document it as a test so flipping this behaviour
      // later requires editing a test + a code change, not just code.
      const humanClaimant: BackendActor = { type: "human", userId: "user-worker" };
      const agentClaimant: BackendActor = {
        type: "agent",
        tokenId: "agent-worker",
        teamId: "team-x",
        scopes: [],
      };

      const humanResult = checkDistinctReviewerGate(
        { ...baseTask, claimedByAgentId: null, claimedByUserId: "user-worker" },
        humanClaimant,
        { requireDistinctReviewer: true },
      );
      const agentResult = checkDistinctReviewerGate(
        baseTask,
        agentClaimant,
        { requireDistinctReviewer: true },
      );

      expect(humanResult.allowed).toBe(false);
      expect(agentResult.allowed).toBe(false);
      expect(humanResult.reason).toBe(agentResult.reason);
    });

    it("soloMode bypasses the gate even when requireDistinctReviewer is true", () => {
      // soloMode = single-actor workflow. There is no second actor to
      // protect; blocking self-review just strands the task in `review`
      // forever. Mirror checkSelfMergeGate's soloMode escape hatch.
      const agentClaimant: BackendActor = {
        type: "agent",
        tokenId: "agent-worker",
        teamId: "team-x",
        scopes: [],
      };
      const result = checkDistinctReviewerGate(
        baseTask, // claimedByAgentId === "agent-worker"
        agentClaimant,
        { requireDistinctReviewer: true, soloMode: true },
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });
});
