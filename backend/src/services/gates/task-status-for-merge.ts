/**
 * Task-status precondition for PR merge.
 *
 * The `POST /api/github/pull-requests/:n/merge` endpoint (and its MCP
 * wrapper `pull_requests_merge`) is the canonical write path for driving
 * a task to `done` via a real GitHub merge. The endpoint refuses tasks in
 * `open` or `in_progress` — the caller is expected to run task_finish
 * (which transitions to `review` in the typical flow) first. A task in
 * `done` is allowed for idempotent retries against an already-merged PR.
 *
 * This gate is intentionally project-agnostic: every project enforces it,
 * regardless of governance mode. Extracted into a named gate so it
 * appears in `effectiveGates` next to the governance-conditional ones
 * instead of being invisible until a caller trips a 403.
 */
import type { Gate } from "./types.js";
import { GateCode } from "./types.js";

export type TaskStatusForMergeResult =
  | { ok: true }
  | { ok: false; reason: "bad_status"; currentStatus: string };

export function checkTaskStatusForMerge(task: {
  status: string;
}): TaskStatusForMergeResult {
  if (task.status === "review" || task.status === "done") {
    return { ok: true };
  }
  return { ok: false, reason: "bad_status", currentStatus: task.status };
}

/**
 * Human-readable rejection message. Kept in sync with the pre-existing
 * inline message in routes/github.ts so clients that match on prose don't
 * break when the gate is extracted.
 */
export function taskStatusForMergeRejectionMessage(currentStatus: string): string {
  if (currentStatus === "open" || currentStatus === "in_progress") {
    return `Cannot merge: task is in '${currentStatus}', expected 'review'. Transition the task to 'review' first (POST /tasks/:id/transition) — or, if you need to bypass the review flow entirely, force-transition to 'done' as an admin and then re-run this merge.`;
  }
  return `Cannot merge: task is in '${currentStatus}', expected 'review' or 'done'.`;
}

export const taskStatusForMergeGate: Gate = {
  code: GateCode.TaskStatusForMerge,
  name: "Task status allows PR merge",
  appliesTo: ["pull_requests_merge", "task_merge"],
  describe() {
    // Always active — no governance knob disables it.
    return {
      active: true,
      because:
        "Every project requires task.status ∈ {review, done} before merging the backing PR; open / in_progress tasks must transition first.",
    };
  },
};
