import type { Context } from "hono";

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export function errorResponse(c: Context, status: 400 | 401 | 403 | 404 | 409 | 422 | 500, code: string, message: string, details?: unknown): Response {
  const body: ApiError = { error: code, message };
  if (details !== undefined) (body as Record<string, unknown>).details = details;
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
