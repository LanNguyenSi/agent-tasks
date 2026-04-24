import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ConflictError } from "../lib/errors.js";

export type IdempotentOutcome<T> =
  | { kind: "ok"; status: number; body: T; replayed: false }
  | { kind: "replay"; status: number; body: T; replayed: true };

export interface IdempotencyArgs {
  projectId: string;
  verb: string;
  idempotencyKey: string | undefined;
  // Full request payload. The helper strips `idempotencyKey` before hashing
  // so a caller that retries with or without the key still matches.
  payload: unknown;
}

// Wrap a side-effect-producing handler so a retry with the same
// (projectId, verb, idempotencyKey) returns the stored response instead of
// re-executing. Unkeyed calls pass through untouched — the feature is
// opt-in per request.
//
// Persistence policy: only 2xx responses are stored. Non-success outcomes
// (GitHub 422, 502, our own 4xx) are naturally retriable — a client that
// hit a transient failure and retries with the same key should get a fresh
// attempt, not a replay of the failure. Matches Stripe's idempotency-key
// semantics.
//
// Collision policy: same key + different payload throws ConflictError (409)
// rather than silently replaying the prior response. Silent replay would
// mask caller bugs.
//
// Concurrency: the row is written *after* execute() resolves. Two truly
// concurrent requests with the same key can therefore both execute once
// before the unique-constraint race resolves. This covers
// retry-after-timeout (the common case) but not hot concurrent duplicates.
// Upgrade path when needed: insert a pending row first, execute, update.
export async function withIdempotency<T>(
  args: IdempotencyArgs,
  execute: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentOutcome<T>> {
  if (!args.idempotencyKey) {
    const result = await execute();
    return { kind: "ok", ...result, replayed: false };
  }

  const payloadHash = hashPayload(args.payload);

  const existing = await prisma.toolInvocation.findUnique({
    where: {
      projectId_verb_idempotencyKey: {
        projectId: args.projectId,
        verb: args.verb,
        idempotencyKey: args.idempotencyKey,
      },
    },
  });

  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new ConflictError(
        `idempotencyKey "${args.idempotencyKey}" was already used for ` +
          `verb "${args.verb}" with a different payload`,
      );
    }
    // Inject a replay marker into the body when it's a plain object. The
    // REST callers can rely on the `X-Idempotent-Replay` header, but MCP
    // clients (HTTP bridge + stdio) go through callSelf/request helpers
    // that strip response headers and only return the parsed JSON. Without
    // this body-level signal those callers cannot distinguish a fresh
    // execution from a replay.
    return {
      kind: "replay",
      status: existing.statusCode,
      body: injectReplayMarker(existing.responseBody) as T,
      replayed: true,
    };
  }

  const result = await execute();

  if (result.status >= 200 && result.status < 300) {
    try {
      await prisma.toolInvocation.create({
        data: {
          projectId: args.projectId,
          verb: args.verb,
          idempotencyKey: args.idempotencyKey,
          payloadHash,
          responseBody: result.body as Prisma.InputJsonValue,
          statusCode: result.status,
        },
      });
    } catch (e) {
      // Race-loser: another request with the same key persisted first.
      // execute() already ran, so accept the local result and move on.
      if (
        !(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      ) {
        throw e;
      }
    }
  }

  return { kind: "ok", ...result, replayed: false };
}

function injectReplayMarker(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), _idempotent_replay: true };
  }
  return body;
}

function hashPayload(payload: unknown): string {
  const stripped = stripIdempotencyKey(payload);
  return createHash("sha256").update(stableStringify(stripped)).digest("hex");
}

function stripIdempotencyKey(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { idempotencyKey: _drop, ...rest } = value as Record<string, unknown>;
  return rest;
}

// JSON.stringify with keys sorted at every object level, so payloads that
// differ only in key order hash equally. Arrays keep their order — that's
// semantic, not cosmetic.
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
