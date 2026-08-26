/**
 * Tests the REAL `updateTask` api helper (no module mock) for the `labels`
 * field specifically, mirroring api.adminRelease.test.ts: request shape
 * (URL, method, body, credentials). Guards the PATCH wiring the labels
 * editor (TaskMetaSidebar via TaskDetail.handleUpdateLabels) depends on --
 * this is the human PATCH /tasks/:id lane updateTaskSchema already accepts
 * `labels` on (backend/src/routes/tasks.ts:314-333).
 */
import { describe, it, expect, afterEach } from "vitest";
import { updateTask } from "../../src/lib/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("updateTask labels", () => {
  it("PATCHes /api/tasks/:id with credentials and labels in the JSON body", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ task: { id: "t-1", labels: ["frontend", "needs-operator"] } }),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await updateTask("t-1", { labels: ["frontend", "needs-operator"] });

    expect(seenUrl).toMatch(/\/api\/tasks\/t-1$/);
    expect(seenInit?.method).toBe("PATCH");
    expect(seenInit?.credentials).toBe("include");
    expect(JSON.parse(seenInit?.body as string)).toEqual({
      labels: ["frontend", "needs-operator"],
    });
    expect(result.labels).toEqual(["frontend", "needs-operator"]);
  });
});
