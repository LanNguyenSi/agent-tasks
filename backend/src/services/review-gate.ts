/**
 * Distinct-reviewer gate.
 *
 * Pure function so both the `/transition` handler and the PATCH `/tasks/:id`
 * human path can call the same rule — previously the logic lived inline in
 * `/transition` and the PATCH human path silently bypassed it, so a human
 * clicking Mark Done in the UI could self-approve their own task even when
 * the project required a distinct reviewer. The test suite imports this
 * module directly, so drift between the handler and the test helper is
 * structurally impossible.
 *
 * Treats humans and agents identically: the reasoning is that governance
 * should not hinge on which credential type someone authenticated with.
 * A misbehaving agent prompt and a careless admin both need the same
 * structural backstop. The admin escape hatch lives one level up
 * (`force: true` + admin check in the route handler), not in this gate.
 */
import type { Actor } from "../types/auth.js";

export type DistinctReviewerRejection =
  | "self_review"
  | "no_review_lock"
  | "review_lock_held_by_claimant";

export interface GateTask {
  claimedByUserId: string | null;
  claimedByAgentId: string | null;
  reviewClaimedByUserId: string | null;
  reviewClaimedByAgentId: string | null;
}

export interface GateProject {
  requireDistinctReviewer: boolean;
}

export interface GateResult {
  allowed: boolean;
  reason?: DistinctReviewerRejection;
}

/**
 * Check whether the given actor is allowed to transition a task from
 * `review` to `done` on behalf of the given project. Returns `allowed: true`
 * when the project has the feature off (backwards-compatible), and
 * `allowed: false` with a structured reason otherwise. Callers handle the
 * `force: true` escape hatch — this function is flag-only.
 */
export function checkDistinctReviewerGate(
  task: GateTask,
  actor: Actor,
  project: GateProject,
): GateResult {
  if (!project.requireDistinctReviewer) {
    return { allowed: true };
  }

  const claimantIsActor =
    (actor.type === "human" && task.claimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.claimedByAgentId === actor.tokenId);
  if (claimantIsActor) {
    return { allowed: false, reason: "self_review" };
  }

  const reviewerIsSet =
    task.reviewClaimedByUserId !== null || task.reviewClaimedByAgentId !== null;
  if (!reviewerIsSet) {
    return { allowed: false, reason: "no_review_lock" };
  }

  const reviewerIsClaimant =
    (task.reviewClaimedByUserId !== null &&
      task.reviewClaimedByUserId === task.claimedByUserId) ||
    (task.reviewClaimedByAgentId !== null &&
      task.reviewClaimedByAgentId === task.claimedByAgentId);
  if (reviewerIsClaimant) {
    return { allowed: false, reason: "review_lock_held_by_claimant" };
  }

  return { allowed: true };
}

export function distinctReviewerRejectionMessage(): string {
  return "This project requires a distinct reviewer. The task's claimant cannot approve their own work. Use POST /tasks/:id/review/claim from a different account or agent, then POST /tasks/:id/review to approve.";
}
