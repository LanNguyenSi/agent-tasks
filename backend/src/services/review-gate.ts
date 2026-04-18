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

// ── Self-merge gate ────────────────────────────────────────────────────────
//
// Prevents the agent (or human) who claimed the work from being the one who
// merges the PR, when the project opts into `requireDistinctReviewer`. This
// is a narrower check than `checkDistinctReviewerGate` above: that one fires
// on the review→done transition (which may involve zero GitHub interaction),
// while this one fires specifically on PR-merge paths — either the dedicated
// `POST /api/tasks/:id/merge` verb or the `autoMerge: true` branch of
// `task_finish`.
//
// Why separate: an approver may well be the work-claimant in projects that
// allow self-approval (requireDistinctReviewer=false), but self-merge can
// still be a policy violation if an org wants one auditor-of-record on the
// GitHub side. For now we tie both to the same project flag — separate
// function mainly exists so we can evolve the policy independently without
// churning existing review-gate call sites.

export type SelfMergeRejection = "self_merge_blocked";

export interface SelfMergeGateProject {
  requireDistinctReviewer: boolean;
  soloMode: boolean;
}

export interface SelfMergeGateTask {
  claimedByUserId: string | null;
  claimedByAgentId: string | null;
}

export interface SelfMergeGateResult {
  allowed: boolean;
  reason?: SelfMergeRejection;
}

export function checkSelfMergeGate(
  task: SelfMergeGateTask,
  actor: Actor,
  project: SelfMergeGateProject,
): SelfMergeGateResult {
  // soloMode is the explicit escape hatch for single-agent workflows that
  // have no second reviewer by design. If a project opts in, self-merge is
  // allowed regardless of the distinct-reviewer flag.
  if (project.soloMode) return { allowed: true };

  // Projects that don't require a distinct reviewer don't care about
  // self-merge either. Backwards-compatible with the existing permissive
  // default.
  if (!project.requireDistinctReviewer) return { allowed: true };

  const actorIsClaimant =
    (actor.type === "human" && task.claimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.claimedByAgentId === actor.tokenId);
  if (actorIsClaimant) {
    return { allowed: false, reason: "self_merge_blocked" };
  }
  return { allowed: true };
}

export function selfMergeRejectionMessage(): string {
  return "The agent (or user) that claimed this task cannot merge its own PR while requireDistinctReviewer is enabled. Hand the review claim to a different account or agent and call POST /tasks/:id/merge from there. Projects with soloMode=true are exempt by design.";
}
