// A blocker is considered resolved (non-blocking) if its status is in this list.
// The list is literal here: the backend judges a blocker by the terminal
// states of its own workflow (findUnresolvedBlockers in
// backend/src/routes/tasks.ts), and the frontend follows once its status
// helpers read the workflow as well.
export const RESOLVED_BLOCKER_STATUSES = ["done", "abandoned"] as const;

export function isResolvedBlocker(status: string): boolean {
  return (RESOLVED_BLOCKER_STATUSES as readonly string[]).includes(status);
}
