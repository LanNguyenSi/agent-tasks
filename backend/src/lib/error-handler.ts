import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { AppError, errorCodeForName } from "./errors.js";

/**
 * Global Hono `onError` handler. Kept in `lib/` so tests can mount it on
 * a minimal Hono fixture without pulling in `createApp()` (which loads
 * the full runtime config).
 */
export function appErrorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    return c.json(
      { error: errorCodeForName(err.name), message: err.message },
      err.statusCode as ContentfulStatusCode,
    );
  }

  if (err instanceof ZodError) {
    return c.json(
      {
        error: "validation_error",
        message: "Validation failed",
        details: err.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }

  console.error(`[${c.req.method}] ${c.req.path} — unhandled error:`, err);
  return c.json(
    { error: "internal_error", message: "An unexpected error occurred" },
    500,
  );
}
