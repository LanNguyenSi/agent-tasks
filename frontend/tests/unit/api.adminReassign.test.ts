/**
 * Tests the REAL `getEligibleActors` and `adminReassignClaim` api helpers (no
 * module mock): request shape (URL, method, body, credentials) and that a
 * server refusal surfaces as an ApiRequestError carrying the status and the
 * server's message.
 */
import { describe, it, expect, afterEach } from "vitest";
import { adminReassignClaim, getEligibleActors, ApiRequestError } from "../../src/lib/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown) {
  const seen: { url: string; init?: RequestInit } = { url: "" };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return { ok: status < 400, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return seen;
}

describe("getEligibleActors", () => {
  it("GETs /api/projects/:id/eligible-actors with credentials and returns the body", async () => {
    const body = { humans: [{ userId: "u-1", name: "Lan", source: "team", role: "ADMIN" }], agents: [{ tokenId: "a-1", name: "bot" }] };
    const seen = stubFetch(200, body);

    await expect(getEligibleActors("p-1")).resolves.toEqual(body);

    expect(seen.url).toMatch(/\/api\/projects\/p-1\/eligible-actors$/);
    expect(seen.init?.credentials).toBe("include");
    expect(seen.init?.method).toBeUndefined();
  });

  it("rejects a 403 with the server's message", async () => {
    stubFetch(403, { error: "forbidden", message: "Only project admins can list eligible claim holders" });
    await expect(getEligibleActors("p-1")).rejects.toMatchObject({ status: 403, message: "Only project admins can list eligible claim holders" });
  });
});

describe("adminReassignClaim", () => {
  it("POSTs /api/tasks/:id/admin-reassign with credentials and the claim and target in the JSON body", async () => {
    const result = { task: { id: "t-1" }, reassigned: { claim: "review", priorHolder: { type: "human", id: "u-2" }, newHolder: { type: "agent", id: "a-1" } } };
    const seen = stubFetch(200, result);

    await expect(adminReassignClaim("t-1", { claim: "review", target: { type: "agent", id: "a-1" } })).resolves.toEqual(result);

    expect(seen.url).toMatch(/\/api\/tasks\/t-1\/admin-reassign$/);
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.credentials).toBe("include");
    expect(JSON.parse(seen.init?.body as string)).toEqual({ claim: "review", target: { type: "agent", id: "a-1" } });
  });

  it("rejects a 409 as an ApiRequestError with the status and the server's message", async () => {
    stubFetch(409, { error: "already_claimed", message: "The target agent already holds an active claim on another task." });
    const err = await adminReassignClaim("t-1", { claim: "work", target: { type: "agent", id: "a-1" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 409, code: "already_claimed", message: "The target agent already holds an active claim on another task." });
  });
});
