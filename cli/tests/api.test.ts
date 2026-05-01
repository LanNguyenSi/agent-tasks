import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  taskPickup,
  taskStart,
  taskFinish,
  taskAbandon,
  submitPr,
  getEffectiveGates,
} from "../src/api.js";
import type { Config } from "../src/config.js";

const config: Config = { endpoint: "http://api.test", token: "tok" };

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("taskPickup", () => {
  it("POSTs to /api/tasks/pickup and returns the polymorphic body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ kind: "idle" }));
    const result = await taskPickup(config);
    expect(result).toEqual({ kind: "idle" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/tasks/pickup");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });
});

describe("taskStart", () => {
  it("POSTs to /api/tasks/:id/start and returns kind + expectedFinishState", async () => {
    const body = {
      kind: "work",
      task: { id: "t1", title: "x", status: "in_progress", priority: "MEDIUM" },
      project: { id: "p1", name: "P", slug: "p" },
      expectedFinishState: "review",
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    const result = await taskStart(config, "t1");
    expect(result).toEqual(body);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://api.test/api/tasks/t1/start");
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });
});

describe("taskFinish", () => {
  it("sends a work-claim body { result, prUrl } as JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "review", priority: "MEDIUM" } }),
    );
    await taskFinish(config, "t1", {
      result: "done",
      prUrl: "https://github.com/o/r/pull/1",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/tasks/t1/finish");
    expect(JSON.parse(init.body)).toEqual({
      result: "done",
      prUrl: "https://github.com/o/r/pull/1",
    });
  });

  it("sends a review-claim body { outcome, result }", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "done", priority: "MEDIUM" } }),
    );
    await taskFinish(config, "t1", { outcome: "approve", result: "lgtm" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      outcome: "approve",
      result: "lgtm",
    });
  });

  it("forwards autoMerge + mergeMethod", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "done", priority: "MEDIUM" } }),
    );
    await taskFinish(config, "t1", { outcome: "approve", autoMerge: true, mergeMethod: "rebase" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      outcome: "approve",
      autoMerge: true,
      mergeMethod: "rebase",
    });
  });

  it("throws ApiError on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "bad_state", message: "nope" }, 409),
    );
    await expect(
      taskFinish(config, "t1", { outcome: "approve" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("taskAbandon", () => {
  it("POSTs to /api/tasks/:id/abandon", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "open", priority: "LOW" } }),
    );
    await taskAbandon(config, "t1");
    expect(fetchMock.mock.calls[0]![0]).toBe("http://api.test/api/tasks/t1/abandon");
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });
});

describe("submitPr", () => {
  it("POSTs branch+pr metadata to /api/tasks/:id/submit-pr", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        task: {
          id: "t1",
          title: "x",
          status: "in_progress",
          priority: "MEDIUM",
          branchName: "feat/x",
          prNumber: 42,
          prUrl: "https://github.com/o/r/pull/42",
        },
      }),
    );
    await submitPr(config, "t1", {
      branchName: "feat/x",
      prUrl: "https://github.com/o/r/pull/42",
      prNumber: 42,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/tasks/t1/submit-pr");
    expect(JSON.parse(init.body)).toEqual({
      branchName: "feat/x",
      prUrl: "https://github.com/o/r/pull/42",
      prNumber: 42,
    });
  });
});

describe("getEffectiveGates", () => {
  it("GETs the gates and flattens the keyed Record into an array", async () => {
    // Backend returns Record<gateCode, EffectiveGate> — the client flattens
    // it so callers can iterate without caring about the key shape.
    const effectiveGates = {
      branch_present: {
        code: "branch_present",
        name: "Branch present",
        active: true,
        because: "PR required",
        appliesTo: ["task_finish"],
      },
      distinct_reviewer: {
        code: "distinct_reviewer",
        name: "Distinct reviewer",
        active: false,
        because: "solo",
        appliesTo: ["task_finish"],
      },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ effectiveGates }));
    const result = await getEffectiveGates(config, "p1");
    expect(result).toEqual(Object.values(effectiveGates));
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://api.test/api/projects/p1/effective-gates",
    );
  });
});
