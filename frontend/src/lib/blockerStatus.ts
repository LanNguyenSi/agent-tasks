// Mirror of backend RESOLVED_BLOCKER_STATUSES from backend/src/routes/tasks.ts
// A blocker is considered resolved (non-blocking) if its status is in this list
export const RESOLVED_BLOCKER_STATUSES = ["done", "abandoned"] as const;

export function isResolvedBlocker(status: string): boolean {
  return (RESOLVED_BLOCKER_STATUSES as readonly string[]).includes(status);
}
