/**
 * Tests the REAL `renameAgentToken` api helper (no module mock), mirroring
 * api.attachments.test.ts / api.adminRelease.test.ts: request shape (URL,
 * method, body, credentials), and that the `{ token }` envelope the backend
 * returns is unwrapped to the bare `AgentToken` (see src/lib/api.ts —
 * `renameAgentToken` returns `data.token`, not `data`). Also pins that a
 * backend rejection surfaces as an `ApiRequestError` with the backend's
 * code/message/status, matching every other wrapper in api.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { renameAgentToken, ApiRequestError, type AgentToken } from "../../src/lib/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeToken(over: Partial<AgentToken> = {}): AgentToken {
  return {
    id: "tok-1",
    name: "renamed-token",
    scopes: ["tasks:read"],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

describe("renameAgentToken", () => {
  it("PATCHes /api/agent-tokens/:id with the new name, credentials included, JSON content-type", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: makeToken() }),
      } as Response;
    }) as unknown as typeof fetch;

    await renameAgentToken("tok-1", "renamed-token");

    expect(seenUrl).toMatch(/\/api\/agent-tokens\/tok-1$/);
    expect(seenInit?.method).toBe("PATCH");
    expect(seenInit?.credentials).toBe("include");
    expect((seenInit?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(seenInit?.body as string)).toEqual({ name: "renamed-token" });
  });

  it("unwraps the { token } envelope — resolves to the bare AgentToken, not the envelope", async () => {
    const token = makeToken({ id: "tok-2", name: "new-name" });
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token }),
    })) as unknown as typeof fetch;

    const result = await renameAgentToken("tok-2", "new-name");

    expect(result).toEqual(token);
    // Not the envelope: no `.token` key on the resolved value itself.
    expect((result as unknown as Record<string, unknown>).token).toBeUndefined();
  });

  it("surfaces a 403 as an ApiRequestError with the backend's code and message", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        error: "forbidden",
        message: "Only team admins can rename agent tokens",
      }),
    })) as unknown as typeof fetch;

    await expect(renameAgentToken("tok-1", "nope")).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
      message: "Only team admins can rename agent tokens",
    });
    await expect(renameAgentToken("tok-1", "nope")).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });

  it("surfaces a 404 (unknown token id) as an ApiRequestError", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "not_found", message: "Not found" }),
    })) as unknown as typeof fetch;

    await expect(renameAgentToken("unknown-id", "x")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });
});
