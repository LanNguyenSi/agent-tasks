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
/** SQLSTATE 22P05: Postgres refuses a NUL byte nested inside a Json/jsonb value. */
const UNTRANSLATABLE_CHARACTER = "22P05";
/** Prisma's own code for a value it cannot put into the JSON of its query. */
const INVALID_ARGUMENT = "InvalidArg";
/**
 * The two fragments Prisma emits for an unpaired UTF-16 surrogate (a JSON
 * string such as "\ud800"): its serializer escapes the lone surrogate and its
 * own parser then refuses the fragment. Prisma never sends the query, so no
 * SQLSTATE is involved; a valid pair (an emoji) is accepted and errors with
 * neither fragment.
 */
const LONE_SURROGATE_FRAGMENTS = ["unexpected end of hex escape", "lone leading surrogate in hex escape"] as const;

/** Each recognised form of client text that cannot be stored. */
const UNSTORABLE_TEXT = {
  nul: {
    log: "refused text with a NUL byte (Postgres 22021)",
    message: "Request contains a character that cannot be stored (NUL byte)",
  },
  "nul-in-json": {
    log: "refused JSON text with a NUL byte (Postgres 22P05)",
    message: "Request contains a character that cannot be stored (NUL byte in a JSON value)",
  },
  surrogate: {
    log: "refused text with an unpaired surrogate (Prisma InvalidArg)",
    message: "Request contains a character that cannot be stored (unpaired surrogate character)",
  },
} as const;

type UnstorableText = keyof typeof UNSTORABLE_TEXT;

/**
 * A Postgres SQLSTATE arrives either as `P2010` with `meta.code` (raw queries)
 * or inside the message text of an `UnknownRequestError` (model queries), which
 * is the only carrier for it.
 */
function hasSqlstate(err: Error, sqlstate: string): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code === "P2010" && err.meta?.code === sqlstate;
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return err.message.includes(`code: "${sqlstate}"`);
  }
  return false;
}

/** Prisma itself refused an unpaired surrogate before the query was sent. */
function isUnpairedSurrogate(err: Error): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === INVALID_ARGUMENT &&
    LONE_SURROGATE_FRAGMENTS.some((fragment) => err.message.includes(fragment))
  );
}

/**
 * Which form of client-sent text was refused, or null for every other error.
 * Postgres rejected the NUL cases (a path id, query string, body string or a
 * string nested in a Json value); Prisma rejected the surrogate case. All of
 * them are the client's input, not a server fault.
 */
function unstorableTextInput(err: Error): UnstorableText | null {
  if (hasSqlstate(err, INVALID_BYTE_SEQUENCE)) return "nul";
  if (hasSqlstate(err, UNTRANSLATABLE_CHARACTER)) return "nul-in-json";
  if (isUnpairedSurrogate(err)) return "surrogate";
  return null;
}

/**
 * The 400 `{ error, message }` refusal for a recognised form, or null when the
 * error is not one. Exported for the grounding routers, whose own `onError`
 * would otherwise answer 503 for it. The refused value is never echoed or
 * logged: the warn line carries method and path only, which is what is needed
 * to trace a string that came from server-side data rather than the request.
 */
export function unstorableTextResponse(err: Error, c: Context): Response | null {
  const form = unstorableTextInput(err);
  if (!form) return null;
  logger.warn({ method: c.req.method, path: c.req.path }, UNSTORABLE_TEXT[form].log);
  return c.json({ error: "validation_error", message: UNSTORABLE_TEXT[form].message }, 400);
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

  const unstorable = unstorableTextResponse(err, c);
  if (unstorable) return unstorable;

  logger.error({ err, errMessage: err.message }, "unhandled error");
  return c.json(
    { error: "internal_error", message: "An unexpected error occurred" },
    500,
  );
}
