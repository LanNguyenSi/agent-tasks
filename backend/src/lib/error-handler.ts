import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError, errorCodeForName } from "./errors.js";
import { logger } from "./logger.js";

const HTTP_ERROR_CODES: Readonly<Record<number, string>> = {
  400: "validation_error",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
};

/** SQLSTATE 22021: Postgres refuses a NUL byte in a text value. */
const INVALID_BYTE_SEQUENCE = "22021";

/**
 * Postgres rejected a value the client sent because the text cannot be stored
 * (a NUL byte in a path id, query string or body string). Prisma reports it as
 * an `UnknownRequestError` whose only carrier of the SQLSTATE is the message
 * text, or as `P2010` with `meta.code` for raw queries. It is the client's
 * input, not a server fault.
 */
function isInvalidTextInput(err: Error): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code === "P2010" && err.meta?.code === INVALID_BYTE_SEQUENCE;
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return err.message.includes(`code: "${INVALID_BYTE_SEQUENCE}"`);
  }
  return false;
}

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

  // Hono throws HTTPException for requests it cannot read itself (the JSON
  // validator on an unparsable body). Client errors (4xx) keep their status
  // and answer in the repo's `{ error, message }` shape; a response the thrower
  // supplied (`res`) is returned as given. A 5xx is a server fault and falls
  // through to the generic branch below.
  if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
    if (err.res) return err.getResponse();
    return c.json(
      { error: HTTP_ERROR_CODES[err.status] ?? "bad_request", message: err.message || "Bad request" },
      err.status as ContentfulStatusCode,
    );
  }

  if (isInvalidTextInput(err)) {
    return c.json(
      {
        error: "validation_error",
        message: "Request contains a character that cannot be stored (NUL byte)",
      },
      400,
    );
  }

  logger.error({ err, errMessage: err.message }, "unhandled error");
  return c.json(
    { error: "internal_error", message: "An unexpected error occurred" },
    500,
  );
}
