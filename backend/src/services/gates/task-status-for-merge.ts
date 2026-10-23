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
import {
  defaultWorkflowDefinition,
  isKnownState,
  isReviewState,
  isTerminalState,
  reviewStates,
  terminalStates,
  type WorkflowDefinitionShape,
} from "../default-workflow.js";

export type TaskStatusForMergeResult =
  | { ok: true }
  | { ok: false; reason: "bad_status"; currentStatus: string };

/**
 * `definition` is the task's effective workflow (task-pinned, else project
 * default, else built-in); omitted, the built-in four-state workflow applies.
 * A status passes when it is a review-like or a terminal state of that
 * definition, which for the built-in workflow is exactly {review, done}.
 */
export function checkTaskStatusForMerge(
  task: { status: string },
  definition: WorkflowDefinitionShape = defaultWorkflowDefinition(),
): TaskStatusForMergeResult {
  if (isReviewState(definition, task.status) || isTerminalState(definition, task.status)) {
    return { ok: true };
  }
  return { ok: false, reason: "bad_status", currentStatus: task.status };
}

/** `'a'`, `'a' or 'b'`, `'a', 'b' or 'c'`. */
function orList(names: string[]): string {
  const quoted = names.map((n) => `'${n}'`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

/**
 * Human-readable rejection message. Kept in sync with the pre-existing
 * inline message in routes/github.ts so clients that match on prose don't
 * break when the gate is extracted. The state names come from `definition`
 * (the task's effective workflow; the built-in one when omitted): for the
 * built-in workflow the texts are exactly the `review` / `done` ones.
 */
export function taskStatusForMergeRejectionMessage(
  currentStatus: string,
  definition: WorkflowDefinitionShape = defaultWorkflowDefinition(),
): string {
  const review = reviewStates(definition);
  const terminal = terminalStates(definition);
  if (isKnownState(definition, currentStatus) && review.length > 0 && terminal.length > 0) {
    return `Cannot merge: task is in '${currentStatus}', expected '${review[0]}'. Transition the task to '${review[0]}' first (POST /tasks/:id/transition) — or, if you need to bypass the review flow entirely, force-transition to '${terminal[0]}' as an admin and then re-run this merge.`;
  }
  return `Cannot merge: task is in '${currentStatus}', expected ${orList([...review, ...terminal])}.`;
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
        "Every project requires a mergeable task status before merging the backing PR: pull_requests_merge and task_merge accept a review state or terminal state of the task's workflow (review / done in the default workflow). Tasks in other states must transition first.",
    };
  },
};
