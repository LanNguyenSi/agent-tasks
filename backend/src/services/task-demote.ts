/**
 * Shared wording of the open -> backlog demote refusals. The REST handler in
 * routes/tasks.ts and the grounding direct-route adapter answer the same
 * refusals with the same text, so the text lives in one place.
 */
export const DEMOTE_STATE_CONFLICT_MESSAGE =
  "Task must be open with no work or review claim to move it back to backlog";

export function demoteSourceStatusMessage(previousStatus: string): string {
  return `Transition from '${previousStatus}' to 'backlog' is not allowed; only an open task can be moved back to backlog`;
}
