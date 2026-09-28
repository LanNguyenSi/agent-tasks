import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  InvalidOperationKeyError,
  createTask,
  taskPickup,
  taskStart,
  taskFinish,
  taskAbandon,
  createPullRequest,
  mergePullRequest,
  submitPr,
  getEffectiveGates,
  listProjectTasks,
  respecTask,
  searchTaskPool,
  matchTaskIdPrefix,
  withProject,
  type Task,
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

describe("createTask", () => {
  const confidence = {
    score: 80,
    threshold: 60,
    enforcementMode: "WARN",
    blocking: false,
    missing: [],
    findings: [],
    nextActions: [],
  };

  it("POSTs the input as the body to /api/projects/:id/tasks and returns the full { task, confidence } envelope", async () => {
    const task = { id: "t1", title: "x", status: "open", priority: "MEDIUM" };
    fetchMock.mockResolvedValueOnce(jsonResponse({ task, confidence }));
    // Full envelope, not just the task -- createTask must not drop
    // confidence the way it used to before task e7911cdd.
    const result = await createTask(config, "p1", { title: "x" });
    expect(result).toEqual({ task, confidence });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/projects/p1/tasks");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ title: "x" });
  });

  it("forwards debugFlavor and dependsOn when set", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "open", priority: "MEDIUM" }, confidence }),
    );
    await createTask(config, "p1", {
      title: "x",
      debugFlavor: false,
      dependsOn: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      title: "x",
      debugFlavor: false,
      dependsOn: ["00000000-0000-0000-0000-000000000000"],
    });
  });

  it("omits debugFlavor and dependsOn from the body when unset", async () => {
    // The CLI's --debug-flavor guard leaves the field off `input` unless the
    // flag was passed; the body must then carry no debugFlavor key, so the
    // backend heuristic stays in charge.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "open", priority: "MEDIUM" }, confidence }),
    );
    await createTask(config, "p1", { title: "x" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).not.toHaveProperty("debugFlavor");
    expect(body).not.toHaveProperty("dependsOn");
  });
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

  it("forwards an explicit operation key unchanged as the Idempotency-Key header", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "done", priority: "MEDIUM" } }),
    );
    await taskFinish(config, "t1", { outcome: "approve" }, "my-retry-key.1:a");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["Idempotency-Key"]).toBe("my-retry-key.1:a");
  });

  it("generates a fresh Idempotency-Key when the operation key is omitted", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "done", priority: "MEDIUM" } }),
    );
    await taskFinish(config, "t1", { outcome: "approve" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("generates a different key on each invocation", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "done", priority: "MEDIUM" } }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "done", priority: "MEDIUM" } }),
    );
    await taskFinish(config, "t1", { outcome: "approve" });
    await taskFinish(config, "t1", { outcome: "approve" });
    const key1 = fetchMock.mock.calls[0]![1].headers["Idempotency-Key"];
    const key2 = fetchMock.mock.calls[1]![1].headers["Idempotency-Key"];
    expect(key1).not.toBe(key2);
  });

  it("rejects an invalid operation key before making any request", async () => {
    await expect(
      taskFinish(config, "t1", { outcome: "approve" }, "has a space"),
    ).rejects.toBeInstanceOf(InvalidOperationKeyError);
    await expect(
      taskFinish(config, "t1", { outcome: "approve" }, "a".repeat(129)),
    ).rejects.toBeInstanceOf(InvalidOperationKeyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("also sends the operation key when finishing with autoMerge", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "done", priority: "MEDIUM" } }),
    );
    await taskFinish(config, "t1", { outcome: "approve", autoMerge: true }, "merge-key");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["Idempotency-Key"]).toBe("merge-key");
    expect(JSON.parse(init.body)).toMatchObject({ autoMerge: true });
  });

  it("accepts a 128-char operation key (the format's own upper bound)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "done", priority: "MEDIUM" } }),
    );
    const key = "a".repeat(128);
    await taskFinish(config, "t1", { outcome: "approve" }, key);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["Idempotency-Key"]).toBe(key);
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

  it("forwards an explicit operation key unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "open", priority: "LOW" } }),
    );
    await taskAbandon(config, "t1", "abandon-key_1");
    expect(fetchMock.mock.calls[0]![1].headers["Idempotency-Key"]).toBe("abandon-key_1");
  });

  it("generates a fresh key when omitted, different across invocations", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "open", priority: "LOW" } }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "open", priority: "LOW" } }),
    );
    await taskAbandon(config, "t1");
    await taskAbandon(config, "t1");
    const key1 = fetchMock.mock.calls[0]![1].headers["Idempotency-Key"];
    const key2 = fetchMock.mock.calls[1]![1].headers["Idempotency-Key"];
    expect(key1).toBeTruthy();
    expect(key1).not.toBe(key2);
  });

  it("rejects an invalid operation key before making any request", async () => {
    await expect(taskAbandon(config, "t1", "bad key")).rejects.toBeInstanceOf(
      InvalidOperationKeyError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a key valid only under the relaxed pr-create/merge format, not abandon's tighter one", async () => {
    // "!" is inside PR_OPERATION_KEY_PATTERN's \x21-\x7E range but outside
    // abandon's tighter alnum/./_/:/- set -- this discriminates abandon
    // from a regression that widened its pattern to the PR one.
    await expect(taskAbandon(config, "t1", "has!bang")).rejects.toBeInstanceOf(
      InvalidOperationKeyError,
    );
    // 200 chars exceeds abandon's 128-char cap but fits under the PR
    // format's 255-char cap -- same discriminator, on length instead of
    // charset.
    await expect(taskAbandon(config, "t1", "a".repeat(200))).rejects.toBeInstanceOf(
      InvalidOperationKeyError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a 128-char operation key (the format's own upper bound)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: { id: "t1", title: "x", status: "open", priority: "LOW" } }),
    );
    const key = "a".repeat(128);
    await taskAbandon(config, "t1", key);
    expect(fetchMock.mock.calls[0]![1].headers["Idempotency-Key"]).toBe(key);
  });
});

describe("createPullRequest", () => {
  const input = {
    taskId: "t1",
    owner: "o",
    repo: "r",
    head: "feat/x",
    base: "main",
    title: "Add x",
  };

  it("forwards an explicit operation key unchanged in the header and the body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ pullRequest: { number: 1, url: "https://github.com/o/r/pull/1" } }),
    );
    await createPullRequest(config, input, "create-key!");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["Idempotency-Key"]).toBe("create-key!");
    expect(JSON.parse(init.body)).toMatchObject({ idempotencyKey: "create-key!" });
  });

  it("generates a fresh key when omitted, sent identically in both places", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ pullRequest: { number: 1, url: "https://github.com/o/r/pull/1" } }),
    );
    await createPullRequest(config, input);
    const [, init] = fetchMock.mock.calls[0]!;
    const headerKey = init.headers["Idempotency-Key"];
    expect(headerKey).toBeTruthy();
    expect(JSON.parse(init.body).idempotencyKey).toBe(headerKey);
  });

  it("generates a different key on each invocation", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ pullRequest: { number: 1, url: "https://github.com/o/r/pull/1" } }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ pullRequest: { number: 2, url: "https://github.com/o/r/pull/2" } }),
    );
    await createPullRequest(config, input);
    await createPullRequest(config, input);
    const key1 = fetchMock.mock.calls[0]![1].headers["Idempotency-Key"];
    const key2 = fetchMock.mock.calls[1]![1].headers["Idempotency-Key"];
    expect(key1).not.toBe(key2);
  });

  it("rejects an invalid operation key (whitespace, or 256 chars) before making any request", async () => {
    await expect(createPullRequest(config, input, "has space")).rejects.toBeInstanceOf(
      InvalidOperationKeyError,
    );
    await expect(createPullRequest(config, input, "a".repeat(256))).rejects.toBeInstanceOf(
      InvalidOperationKeyError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a 255-char key using the format's wider printable-ASCII set (the format's own upper bound)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ pullRequest: { number: 1, url: "https://github.com/o/r/pull/1" } }),
    );
    const key = "a/".repeat(127) + "b";
    expect(key).toHaveLength(255);
    await createPullRequest(config, input, key);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["Idempotency-Key"]).toBe(key);
  });
});

describe("mergePullRequest", () => {
  const input = { taskId: "t1", owner: "o", repo: "r", merge_method: "squash" as const };

  it("forwards an explicit operation key unchanged in the header and the body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ merged: true, sha: "abc" }));
    await mergePullRequest(config, 1, input, "merge-key.1");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["Idempotency-Key"]).toBe("merge-key.1");
    expect(JSON.parse(init.body)).toMatchObject({ idempotencyKey: "merge-key.1" });
  });

  it("generates a fresh key when omitted, sent identically in both places", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ merged: true }));
    await mergePullRequest(config, 1, input);
    const [, init] = fetchMock.mock.calls[0]!;
    const headerKey = init.headers["Idempotency-Key"];
    expect(headerKey).toBeTruthy();
    expect(JSON.parse(init.body).idempotencyKey).toBe(headerKey);
  });

  it("generates a different key on each invocation", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ merged: true }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ merged: true }));
    await mergePullRequest(config, 1, input);
    await mergePullRequest(config, 1, input);
    const key1 = fetchMock.mock.calls[0]![1].headers["Idempotency-Key"];
    const key2 = fetchMock.mock.calls[1]![1].headers["Idempotency-Key"];
    expect(key1).not.toBe(key2);
  });

  it("rejects an invalid operation key (129 chars) before making any request", async () => {
    await expect(
      mergePullRequest(config, 1, input, "a".repeat(129)),
    ).rejects.toBeInstanceOf(InvalidOperationKeyError);
    // Merge uses the tighter format: printable-ASCII-but-not-alnum chars like
    // '!' are valid for pr create but invalid here.
    await expect(
      mergePullRequest(config, 1, input, "has!bang"),
    ).rejects.toBeInstanceOf(InvalidOperationKeyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a 128-char operation key (the format's own upper bound)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ merged: true }));
    const key = "a".repeat(128);
    await mergePullRequest(config, 1, input, key);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["Idempotency-Key"]).toBe(key);
  });

  it("rejects a 200-char operation key (tighter format caps at 128, unlike pr create's 255)", async () => {
    await expect(
      mergePullRequest(config, 1, input, "a".repeat(200)),
    ).rejects.toBeInstanceOf(InvalidOperationKeyError);
    expect(fetchMock).not.toHaveBeenCalled();
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

describe("respecTask", () => {
  const confidence = {
    score: 72,
    threshold: 60,
    enforcementMode: "WARN",
    blocking: false,
    missing: [],
    findings: [],
    nextActions: [],
  };

  it("POSTs the input to /api/tasks/:id/respec and returns the full { task, confidence } envelope", async () => {
    const task = { id: "t1", title: "x", status: "open", priority: "MEDIUM", description: "new desc" };
    fetchMock.mockResolvedValueOnce(jsonResponse({ task, confidence }));
    const result = await respecTask(config, "t1", { description: "new desc" });
    // Full envelope, not just the task — respec must NOT drop confidence the
    // way createTask drops it from the caller-visible return value.
    expect(result).toEqual({ task, confidence });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/tasks/t1/respec");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ description: "new desc" });
  });

  it("forwards templateData in the request body", async () => {
    const task = { id: "t1", title: "x", status: "open", priority: "MEDIUM" };
    fetchMock.mockResolvedValueOnce(jsonResponse({ task, confidence }));
    await respecTask(config, "t1", { templateData: { taskType: "feature" } });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      templateData: { taskType: "feature" },
    });
  });

  it("throws ApiError with the backend message on 403 (not creator, not allowed)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: "forbidden", message: "Only the task's creator can respec it" },
        403,
      ),
    );
    await expect(respecTask(config, "t1", { description: "x" })).rejects.toMatchObject({
      status: 403,
      body: { error: "forbidden", message: "Only the task's creator can respec it" },
    });
  });

  it("throws ApiError with the backend message on 409 (task not open/unclaimed)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: "conflict", message: "Task must be open and unclaimed to respec" },
        409,
      ),
    );
    await expect(respecTask(config, "t1", { description: "x" })).rejects.toMatchObject({
      status: 409,
      body: { error: "conflict", message: "Task must be open and unclaimed to respec" },
    });
  });
});

describe("searchTaskPool", () => {
  it("GETs /api/tasks/claimable with an explicit all-status, newest-first search", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tasks: [], nextCursor: null }));
    await searchTaskPool(config, "abc");
    const url = fetchMock.mock.calls[0]![0] as string;
    // sort=createdAt:desc (task e7911cdd fix round): the pool's own default
    // is createdAt:asc, which would search the OLDEST tasks first -- exactly
    // backwards from `tasks list`'s newest-first table the ID column comes
    // from.
    expect(url).toBe(
      "http://api.test/api/tasks/claimable?status=backlog%2Copen%2Cin_progress%2Creview%2Cdone%2Cabandoned&limit=200&sort=createdAt%3Adesc",
    );
  });

  it("D18: includes backlog in the search pool so a backlog task's prefix resolves", async () => {
    const tasks = [
      { id: "abcdef12-0000-0000-0000-000000000000", title: "Backlog match", status: "backlog", priority: "LOW" },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse({ tasks, nextCursor: null }));
    const result = await searchTaskPool(config, "abcdef12");
    expect(result).toEqual({
      match: { kind: "unique", id: "abcdef12-0000-0000-0000-000000000000" },
      searched: 1,
      capped: false,
    });
    expect(fetchMock.mock.calls[0]![0] as string).toContain("backlog");
  });

  it("forwards a custom limit", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tasks: [], nextCursor: null }));
    await searchTaskPool(config, "abc", 25);
    expect(fetchMock.mock.calls[0]![0] as string).toContain("limit=25");
  });

  it("returns a unique match found on the first page without paging further", async () => {
    const tasks = [{ id: "abcdef12-0000-0000-0000-000000000000", title: "x", status: "open", priority: "LOW" }];
    fetchMock.mockResolvedValueOnce(jsonResponse({ tasks, nextCursor: "abcdef12-0000-0000-0000-000000000000" }));
    const result = await searchTaskPool(config, "abcdef12");
    expect(result).toEqual({
      match: { kind: "unique", id: "abcdef12-0000-0000-0000-000000000000" },
      searched: 1,
      capped: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("follows nextCursor to a second page to find a match not present on the first page", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        tasks: [{ id: "11111111-0000-0000-0000-000000000000", title: "page 1", status: "open", priority: "LOW" }],
        nextCursor: "11111111-0000-0000-0000-000000000000",
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        tasks: [{ id: "abcdef12-0000-0000-0000-000000000000", title: "page 2 match", status: "open", priority: "LOW" }],
        nextCursor: null,
      }),
    );
    const result = await searchTaskPool(config, "abcdef12");
    expect(result).toEqual({
      match: { kind: "unique", id: "abcdef12-0000-0000-0000-000000000000" },
      searched: 2,
      capped: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = fetchMock.mock.calls[1]![0] as string;
    expect(secondUrl).toContain("cursor=11111111-0000-0000-0000-000000000000");
  });

  it("stops at the hard page cap and reports capped when no match was found", async () => {
    // 10 pages of a full 200-row page each, always with a nextCursor, never
    // a match -- proves the loop is bounded rather than paging forever.
    for (let i = 0; i < 10; i++) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          tasks: [{ id: `${i}0000000-0000-0000-0000-000000000000`, title: "x", status: "open", priority: "LOW" }],
          nextCursor: `${i}0000000-0000-0000-0000-000000000000`,
        }),
      );
    }
    const result = await searchTaskPool(config, "zzzzzzzz");
    expect(result).toEqual({ match: { kind: "none" }, searched: 10, capped: true });
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});

describe("matchTaskIdPrefix", () => {
  const pool: Task[] = [
    { id: "abcdef12-0000-0000-0000-000000000000", title: "First", status: "open", priority: "LOW" },
    { id: "abcdef99-0000-0000-0000-000000000000", title: "Second", status: "open", priority: "LOW" },
    { id: "12345678-0000-0000-0000-000000000000", title: "Third", status: "open", priority: "LOW" },
  ];

  it("returns a unique match for a prefix matched by exactly one task", () => {
    const result = matchTaskIdPrefix(pool, "12345678");
    expect(result).toEqual({ kind: "unique", id: "12345678-0000-0000-0000-000000000000" });
  });

  it("matches case-insensitively", () => {
    const result = matchTaskIdPrefix(pool, "ABCDEF99");
    expect(result).toEqual({ kind: "unique", id: "abcdef99-0000-0000-0000-000000000000" });
  });

  it("reports 'none' for a prefix matched by zero tasks", () => {
    expect(matchTaskIdPrefix(pool, "ffffffff")).toEqual({ kind: "none" });
  });

  it("reports 'ambiguous' with every matching task -- never silently picks the first match", () => {
    const result = matchTaskIdPrefix(pool, "abcdef");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matches).toHaveLength(2);
      expect(result.matches.map((t) => t.id)).toEqual([
        "abcdef12-0000-0000-0000-000000000000",
        "abcdef99-0000-0000-0000-000000000000",
      ]);
    }
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

describe("listProjectTasks", () => {
  it("GETs /api/projects/:id/tasks without query when no filters are passed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tasks: [] }));
    await listProjectTasks(config, "p1");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://api.test/api/projects/p1/tasks",
    );
  });

  it("encodes filters as comma-separated query params", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tasks: [] }));
    await listProjectTasks(config, "p1", {
      status: ["open", "in_progress"],
      priority: ["HIGH", "CRITICAL"],
      labels: ["mcp", "dx"],
      unclaimed: true,
      limit: 25,
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("status=open%2Cin_progress");
    expect(url).toContain("priority=HIGH%2CCRITICAL");
    expect(url).toContain("labels=mcp%2Cdx");
    expect(url).toContain("unclaimed=true");
    expect(url).toContain("limit=25");
  });

  it("omits unclaimed=true when unclaimed is false or absent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tasks: [] }));
    await listProjectTasks(config, "p1", { unclaimed: false });
    expect(fetchMock.mock.calls[0]![0]).not.toContain("unclaimed");
  });

  it("returns the tasks array unwrapped from the envelope", async () => {
    const tasks = [
      { id: "t1", title: "one", status: "open", priority: "LOW" },
      { id: "t2", title: "two", status: "open", priority: "HIGH" },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse({ tasks }));
    const result = await listProjectTasks(config, "p1");
    expect(result).toEqual(tasks);
  });
});

describe("withProject", () => {
  const project = { id: "p1", name: "Project One", slug: "project-one" };

  it("backfills project on tasks that don't already have one", () => {
    const tasks: Task[] = [
      { id: "t1", title: "one", status: "open", priority: "LOW" },
      { id: "t2", title: "two", status: "open", priority: "HIGH" },
    ];
    const result = withProject(tasks, project);
    expect(result).toEqual([
      { id: "t1", title: "one", status: "open", priority: "LOW", project: { id: "p1", name: "Project One", slug: "project-one" } },
      { id: "t2", title: "two", status: "open", priority: "HIGH", project: { id: "p1", name: "Project One", slug: "project-one" } },
    ]);
  });

  it("preserves a task's existing project instead of overwriting it", () => {
    const tasks: Task[] = [
      { id: "t1", title: "one", status: "open", priority: "LOW", project: { name: "Other", slug: "other" } },
    ];
    const result = withProject(tasks, project);
    expect(result[0]!.project).toEqual({ name: "Other", slug: "other" });
  });

  it("does not mutate the input array", () => {
    const tasks: Task[] = [{ id: "t1", title: "one", status: "open", priority: "LOW" }];
    withProject(tasks, project);
    expect(tasks[0]).not.toHaveProperty("project");
  });
});

describe("operation key format edges", () => {
  const prInput = { taskId: "t1", owner: "o", repo: "r", head: "feat/x", base: "main", title: "Add x" };
  const mergeInput = { taskId: "t1", owner: "o", repo: "r", merge_method: "squash" as const };

  it("rejects an empty explicit key on the tight format before any request", async () => {
    await expect(taskFinish(config, "t1", { prUrl: "https://github.com/o/r/pull/1" }, "")).rejects.toBeInstanceOf(
      InvalidOperationKeyError,
    );
    await expect(mergePullRequest(config, 1, mergeInput, "")).rejects.toBeInstanceOf(InvalidOperationKeyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty explicit key on the pr-create format before any request", async () => {
    await expect(createPullRequest(config, prInput, "")).rejects.toBeInstanceOf(InvalidOperationKeyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects '/' in the tight format (finish, abandon, pr merge)", async () => {
    await expect(taskAbandon(config, "t1", "a/b")).rejects.toBeInstanceOf(InvalidOperationKeyError);
    await expect(mergePullRequest(config, 1, mergeInput, "a/b")).rejects.toBeInstanceOf(InvalidOperationKeyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
