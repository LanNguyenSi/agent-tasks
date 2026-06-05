/**
 * Tests the REAL createTask helper (no module mock) so the create contract is
 * pinned: it POSTs JSON to the project tasks endpoint with credentials, and it
 * exposes BOTH the created task and the server's authoritative create-time
 * confidence from the `{ task, confidence }` envelope (T4 / task 1a925647).
 *
 * Runs in the default node environment; undici provides global fetch (Node 18+).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTask, type CreateConfidence, type Task } from "../../src/lib/api";

const realFetch = globalThis.fetch;

function mockFetchOnce(payload: unknown, ok = true, status = 201) {
  const fn = vi.fn().mockResolvedValue({ ok, status, json: async () => payload });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const task = { id: "task-1", projectId: "proj-1", title: "Render create-time confidence" } as unknown as Task;
const confidence: CreateConfidence = {
  score: 62,
  threshold: 60,
  blocking: false,
  missing: ["goal", "acceptanceCriteria"],
  findings: [],
  nextActions: ["Add a one-line Goal stating the intended outcome."],
};

describe("createTask", () => {
  it("returns BOTH the task and the server confidence from the create envelope", async () => {
    const fetchFn = mockFetchOnce({ task, confidence });

    const result = await createTask("proj-1", { title: "Render create-time confidence" });

    expect(result.task).toEqual(task);
    expect(result.confidence).toEqual(confidence);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/projects\/proj-1\/tasks$/);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toMatchObject({ title: "Render create-time confidence" });
  });

  it("tolerates an older backend that omits confidence (confidence is optional)", async () => {
    mockFetchOnce({ task });

    const result = await createTask("proj-1", { title: "X" });

    expect(result.task).toEqual(task);
    expect(result.confidence).toBeUndefined();
  });
});
