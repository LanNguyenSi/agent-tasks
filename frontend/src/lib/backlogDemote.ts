// Shared copy and guard for the "Move to backlog" (demote) action: the
// /tasks table row action (app/tasks/_components/columns.tsx) and the
// task-detail header (components/task-detail/TaskHeader.tsx) both read it, so
// the label and the claim hint cannot drift apart.
//
// Mirrors the server contract (PATCH /tasks/:id { status: "backlog" } in
// backend/src/routes/tasks.ts): only an OPEN task with no work claim and no
// review claim can be demoted. The server enforces this atomically; the UI
// check only decides whether to offer the action enabled or disabled with a
// reason, so a stale list can still get a 409 back, which surfaces through
// the caller's normal error path.
import type { Task } from "./api";

export const DEMOTE_LABEL = "Move to backlog";

export const DEMOTE_CLAIMED_HINT = "Release the claim before moving this task back to backlog";

/** True when anyone holds a work or review claim on the task. */
export function hasAnyClaim(
  task: Pick<
    Task,
    "claimedByUserId" | "claimedByAgentId" | "reviewClaimedByUserId" | "reviewClaimedByAgentId"
  >,
): boolean {
  return Boolean(
    task.claimedByUserId ||
      task.claimedByAgentId ||
      task.reviewClaimedByUserId ||
      task.reviewClaimedByAgentId,
  );
}

/** Why the demote action is disabled for this task, or null when it is available. */
export function demoteBlockedHint(
  task: Pick<
    Task,
    "claimedByUserId" | "claimedByAgentId" | "reviewClaimedByUserId" | "reviewClaimedByAgentId"
  >,
): string | null {
  return hasAnyClaim(task) ? DEMOTE_CLAIMED_HINT : null;
}
