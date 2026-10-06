import type { Context } from "hono";

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export function errorResponse(c: Context, status: 400 | 401 | 403 | 404 | 409 | 422 | 500, code: string, message: string, details?: unknown): Response {
  const body: ApiError = { error: code, message };
  if (details !== undefined) (body as unknown as Record<string, unknown>).details = details;
  return c.json(body, status);
}

export function notFound(c: Context): Response {
  return errorResponse(c, 404, "not_found", "Resource not found");
}

export function forbidden(c: Context, message = "Insufficient permissions"): Response {
  return errorResponse(c, 403, "forbidden", message);
}

export function conflict(c: Context, message: string): Response {
  return errorResponse(c, 409, "conflict", message);
}

/** The 409 body a claim or status writer answers while a merge holds the task. */
export function mergeInProgressBody(retryAfterSeconds?: number): {
  error: "merge_in_progress";
  message: string;
  retryAfterSeconds?: number;
} {
  return {
    error: "merge_in_progress",
    message:
      "A pull request merge is in progress for this task, so its claims and status cannot change right now. " +
      "Retry once the merge has finished; the reservation lapses on its own if the merge never completes.",
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

/**
 * 409 `merge_in_progress`: the writer's conditional write matched no row
 * because a merge reservation is live (see services/task-merge-reservation.ts).
 */
export function mergeInProgress(c: Context, retryAfterSeconds?: number): Response {
  if (retryAfterSeconds !== undefined) c.header("Retry-After", String(retryAfterSeconds));
  return c.json(mergeInProgressBody(retryAfterSeconds), 409);
}

// Confidence may carry the extended ADR-0011 fields (subscores, findings,
// nextActions). The shape stays additive — existing clients that read
// `score` / `missing` / `threshold` keep working unchanged.
export function lowConfidence(
  c: Context,
  confidence: { score: number; missing: string[]; threshold: number } & Record<string, unknown>,
): Response {
  return errorResponse(c, 422, "low_confidence", "Task does not meet confidence threshold for agent claiming", confidence);
}
