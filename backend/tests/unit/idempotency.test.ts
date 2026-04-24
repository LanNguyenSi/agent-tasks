/**
 * Unit tests for the `withIdempotency` service.
 *
 * The helper itself is small, but it has three branches that matter:
 * 1. No key → pass-through (never touches DB).
 * 2. Key + no prior row → execute + persist (only if 2xx).
 * 3. Key + prior row → replay on hash match, ConflictError on hash mismatch.
 *
 * Error statuses (≥300) intentionally bypass persistence so a caller that
 * retries after a transient GitHub failure still gets a fresh attempt.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const prismaMocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    toolInvocation: {
      findUnique: prismaMocks.findUnique,
      create: prismaMocks.create,
    },
  },
}));

import { withIdempotency } from "../../src/services/idempotency.js";
import { ConflictError } from "../../src/lib/errors.js";

const PROJECT = "proj-1";
const VERB = "pull_requests_create";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.findUnique.mockResolvedValue(null);
  prismaMocks.create.mockResolvedValue(undefined);
});

describe("withIdempotency", () => {
  it("passes through when idempotencyKey is undefined", async () => {
    const execute = vi.fn().mockResolvedValue({ status: 201, body: { ok: 1 } });

    const result = await withIdempotency(
      {
        projectId: PROJECT,
        verb: VERB,
        idempotencyKey: undefined,
        payload: { a: 1 },
      },
      execute,
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toEqual({
      kind: "ok",
      status: 201,
      body: { ok: 1 },
      replayed: false,
    });
    expect(prismaMocks.findUnique).not.toHaveBeenCalled();
    expect(prismaMocks.create).not.toHaveBeenCalled();
  });

  it("executes + persists on first call with a key", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ status: 201, body: { pr: 42 } });

    const result = await withIdempotency(
      {
        projectId: PROJECT,
        verb: VERB,
        idempotencyKey: "key-1",
        payload: { head: "feat/x" },
      },
      execute,
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(result.replayed).toBe(false);
    expect(result.status).toBe(201);
    expect(prismaMocks.create).toHaveBeenCalledOnce();
    const persisted = prismaMocks.create.mock.calls[0][0].data;
    expect(persisted.projectId).toBe(PROJECT);
    expect(persisted.verb).toBe(VERB);
    expect(persisted.idempotencyKey).toBe("key-1");
    expect(persisted.statusCode).toBe(201);
    expect(persisted.responseBody).toEqual({ pr: 42 });
    expect(persisted.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replays stored response on second call with same key + same payload", async () => {
    const storedBody = { pr: 42, note: "first" };
    const execute = vi.fn();

    // Compute the hash the first call would have written, then return a
    // matching row on the lookup.
    const payload = { head: "feat/x", base: "main" };
    const firstPayloadHash = await computeHash(payload);
    prismaMocks.findUnique.mockResolvedValue({
      id: "ti-1",
      projectId: PROJECT,
      verb: VERB,
      idempotencyKey: "key-1",
      payloadHash: firstPayloadHash,
      responseBody: storedBody,
      statusCode: 201,
      createdAt: new Date(),
    });

    const result = await withIdempotency(
      {
        projectId: PROJECT,
        verb: VERB,
        idempotencyKey: "key-1",
        payload,
      },
      execute,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.replayed).toBe(true);
    expect(result.status).toBe(201);
    expect(result.body).toEqual(storedBody);
    expect(prismaMocks.create).not.toHaveBeenCalled();
  });

  it("throws ConflictError when same key is reused with a different payload", async () => {
    const execute = vi.fn();
    prismaMocks.findUnique.mockResolvedValue({
      payloadHash: "a".repeat(64), // deliberately not matching anything we'd hash
      responseBody: {},
      statusCode: 201,
    });

    await expect(
      withIdempotency(
        {
          projectId: PROJECT,
          verb: VERB,
          idempotencyKey: "key-1",
          payload: { head: "feat/y" },
        },
        execute,
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(execute).not.toHaveBeenCalled();
  });

  it("does NOT persist non-2xx responses so callers can retry transient failures", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ status: 502, body: { error: "bad_gateway" } });

    const result = await withIdempotency(
      {
        projectId: PROJECT,
        verb: VERB,
        idempotencyKey: "key-transient",
        payload: { head: "feat/x" },
      },
      execute,
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(result.status).toBe(502);
    expect(prismaMocks.create).not.toHaveBeenCalled();
  });

  it("ignores idempotencyKey when hashing — same payload with/without key hashes equally", async () => {
    const execute1 = vi
      .fn()
      .mockResolvedValue({ status: 201, body: { ok: 1 } });
    const execute2 = vi
      .fn()
      .mockResolvedValue({ status: 201, body: { ok: 2 } });

    await withIdempotency(
      {
        projectId: PROJECT,
        verb: VERB,
        idempotencyKey: "k1",
        payload: { head: "feat/x", idempotencyKey: "k1" },
      },
      execute1,
    );

    const hashWithKey = prismaMocks.create.mock.calls[0][0].data.payloadHash;

    prismaMocks.create.mockClear();

    await withIdempotency(
      {
        projectId: PROJECT,
        verb: VERB,
        idempotencyKey: "k2",
        payload: { head: "feat/x" },
      },
      execute2,
    );

    const hashWithoutKey = prismaMocks.create.mock.calls[0][0].data.payloadHash;

    expect(hashWithKey).toBe(hashWithoutKey);
  });

  it("treats the race-loser P2002 on insert as success (side-effect already happened)", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ status: 201, body: { pr: 42 } });
    prismaMocks.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const result = await withIdempotency(
      {
        projectId: PROJECT,
        verb: VERB,
        idempotencyKey: "racey",
        payload: {},
      },
      execute,
    );

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ pr: 42 });
  });

  it("rethrows non-P2002 create errors", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ status: 201, body: { pr: 42 } });
    prismaMocks.create.mockRejectedValue(new Error("db down"));

    await expect(
      withIdempotency(
        {
          projectId: PROJECT,
          verb: VERB,
          idempotencyKey: "ok",
          payload: {},
        },
        execute,
      ),
    ).rejects.toThrow("db down");
  });
});

// Re-implement the helper's hash function to verify cross-call stability.
// If the two diverge, this test will flag the drift.
async function computeHash(payload: unknown): Promise<string> {
  const { createHash } = await import("node:crypto");
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

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
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
