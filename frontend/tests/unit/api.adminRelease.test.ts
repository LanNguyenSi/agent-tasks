/**
 * Tests the REAL `adminReleaseClaim` api helper (no module mock), mirroring
 * api.attachments.test.ts: request shape (URL, method, body, credentials)
 * and response typing. Also covers that `transitionTask`'s 422
 * `precondition_failed` body surfaces `failed[]` / `canForce` on the
 * thrown `ApiRequestError` — the mechanism TaskHeader's admin
 * status-override flow depends on.
 */
import { describe, it, expect, afterEach } from "vitest";
import { adminReleaseClaim, transitionTask, ApiRequestError } from "../../src/lib/api";

const realFetch = globalThis.fetch;

function mockFetchOnce(impl: () => Partial<Response> & { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fn = (async () => impl()) as unknown as typeof fetch;
  globalThis.fetch = fn;
  return fn;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("adminReleaseClaim", () => {
  it("POSTs the release body with credentials to the admin-release endpoint", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          task: { id: "t-1", status: "in_progress" },
          released: { workClaim: true, reviewClaim: false },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await adminReleaseClaim("t-1", { releaseWorkClaim: true, reason: "unresponsive agent" });

    expect(seenUrl).toMatch(/\/api\/tasks\/t-1\/admin-release$/);
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.credentials).toBe("include");
    expect(JSON.parse(seenInit?.body as string)).toEqual({
      releaseWorkClaim: true,
      reason: "unresponsive agent",
    });
    expect(result.released).toEqual({ workClaim: true, reviewClaim: false });
    expect(result.task.id).toBe("t-1");
  });

  it("surfaces a 403 as an ApiRequestError with the backend's code and message", async () => {
    mockFetchOnce(() => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden", message: "Only project admins can release another actor's claim" }),
    }));

    await expect(adminReleaseClaim("t-1", { releaseWorkClaim: true })).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
      message: "Only project admins can release another actor's claim",
    });
  });
});

describe("transitionTask precondition_failed exposure", () => {
  it("exposes failed[] and canForce on the thrown ApiRequestError", async () => {
    mockFetchOnce(() => ({
      ok: false,
      status: 422,
      json: async () => ({
        error: "precondition_failed",
        message: "Transition blocked — PR must be present.",
        failed: [{ rule: "prPresent", message: "PR must be present." }],
        canForce: true,
      }),
    }));

    let caught: unknown;
    try {
      await transitionTask("t-1", "review");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiRequestError);
    const err = caught as ApiRequestError;
    expect(err.code).toBe("precondition_failed");
    expect(err.canForce).toBe(true);
    expect(err.failed).toEqual([{ rule: "prPresent", message: "PR must be present." }]);
  });

  it("leaves failed/canForce undefined for error bodies that don't carry them", async () => {
    mockFetchOnce(() => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden", message: "Requires write access" }),
    }));

    let caught: unknown;
    try {
      await transitionTask("t-1", "review");
    } catch (err) {
      caught = err;
    }

    const err = caught as ApiRequestError;
    expect(err.failed).toBeUndefined();
    expect(err.canForce).toBeUndefined();
  });

  it("retrying with force:true and forceReason sends both fields in the body", async () => {
    let seenBody = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = init?.body as string;
      return { ok: true, status: 200, json: async () => ({ task: { id: "t-1", status: "review" } }) } as Response;
    }) as unknown as typeof fetch;

    await transitionTask("t-1", "review", { force: true, forceReason: "imported from Jira" });

    expect(JSON.parse(seenBody)).toEqual({
      status: "review",
      force: true,
      forceReason: "imported from Jira",
    });
  });
});
