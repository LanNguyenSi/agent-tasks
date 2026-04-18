import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { buildTools } from "../src/tools.js";
import { AgentTasksClient, AgentTasksApiError } from "../src/client.js";

describe("buildTools", () => {
  const config = { baseUrl: "https://example.test", token: "tok_abc" };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ok(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function tool(name: string) {
    const tools = buildTools(new AgentTasksClient(config));
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not registered`);
    return t;
  }

  it("registers all expected tools", () => {
    const tools = buildTools(new AgentTasksClient(config));
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "projects_get",
        "projects_list",
        "pull_requests_comment",
        "pull_requests_create",
        "pull_requests_merge",
        "review_approve",
        "review_claim",
        "review_release",
        "review_request_changes",
        "signals_ack",
        "signals_poll",
        "task_abandon",
        "task_artifact_create",
        "task_artifact_get",
        "task_artifact_list",
        "task_create",
        "task_finish",
        "task_merge",
        "task_note",
        "task_pickup",
        "task_start",
        "task_submit_pr",
        "tasks_claim",
        "tasks_comment",
        "tasks_create",
        "tasks_get",
        "tasks_instructions",
        "tasks_list",
        "tasks_release",
        "tasks_transition",
        "tasks_update",
      ].sort(),
    );
  });

  it("tasks_comment sends content field (not message) — matches backend createCommentSchema", async () => {
    fetchMock.mockResolvedValue(ok({ comment: { id: "c1" } }));
    await tool("tasks_comment").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      content: "progress update",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/comments",
    );
    expect(JSON.parse(init.body)).toEqual({ content: "progress update" });
  });

  it("tasks_create forwards externalRef and labels", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("tasks_create").handler({
      projectId: "22222222-2222-2222-2222-222222222222",
      title: "Imported task",
      externalRef: "jira-PROJ-42",
      labels: ["imported", "backend"],
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      title: "Imported task",
      externalRef: "jira-PROJ-42",
      labels: ["imported", "backend"],
    });
  });

  it("tasks_transition passes status and force fields", async () => {
    fetchMock.mockResolvedValue(ok({ task: { status: "done" } }));
    await tool("tasks_transition").handler({
      taskId: "33333333-3333-3333-3333-333333333333",
      status: "done",
      force: true,
      forceReason: "manual override",
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      status: "done",
      force: true,
      forceReason: "manual override",
    });
  });

  it("wrap translates AgentTasksApiError to Error with status prefix", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      tool("tasks_claim").handler({
        taskId: "44444444-4444-4444-4444-444444444444",
      }),
    ).rejects.toThrow(/agent-tasks API 403/);
  });

  it("unknown-tool guard: AgentTasksApiError is caught and rethrown, not leaked", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await expect(
      tool("projects_list").handler({} as never),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("does not put Bearer token in thrown error messages", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "denied" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await tool("tasks_claim").handler({
        taskId: "55555555-5555-5555-5555-555555555555",
      });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("tok_abc");
      expect(msg).not.toContain("Bearer");
    }
  });

  // Tell TypeScript the AgentTasksApiError symbol is used (for import side-effects).
  it("AgentTasksApiError is exported", () => {
    expect(AgentTasksApiError.name).toBe("AgentTasksApiError");
  });

  // ── GitHub PR tools ────────────────────────────────────────────────

  it("pull_requests_create POSTs the full body shape the backend expects", async () => {
    fetchMock.mockResolvedValue(
      ok({ pullRequest: { number: 42, url: "https://github.com/o/r/pull/42", title: "t" } }),
    );
    await tool("pull_requests_create").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      owner: "LanNguyenSi",
      repo: "agent-tasks",
      head: "feat/foo",
      base: "master",
      title: "feat: foo",
      body: "PR body",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/github/pull-requests");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      taskId: "11111111-1111-1111-1111-111111111111",
      owner: "LanNguyenSi",
      repo: "agent-tasks",
      head: "feat/foo",
      base: "master",
      title: "feat: foo",
      body: "PR body",
    });
  });

  it("pull_requests_create omits base when unset so backend default (main) applies", async () => {
    fetchMock.mockResolvedValue(ok({ pullRequest: { number: 1, url: "u", title: "t" } }));
    await tool("pull_requests_create").handler({
      taskId: "22222222-2222-2222-2222-222222222222",
      owner: "o",
      repo: "r",
      head: "b",
      title: "t",
    });
    const [, init] = fetchMock.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed).not.toHaveProperty("base");
    expect(parsed).not.toHaveProperty("body");
  });

  it("pull_requests_merge routes to /pull-requests/{prNumber}/merge and translates mergeMethod → merge_method", async () => {
    fetchMock.mockResolvedValue(ok({ merged: true, sha: "abc", message: "ok", task: { id: "t", status: "done" } }));
    await tool("pull_requests_merge").handler({
      taskId: "33333333-3333-3333-3333-333333333333",
      owner: "LanNguyenSi",
      repo: "agent-tasks",
      prNumber: 136,
      mergeMethod: "squash",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/github/pull-requests/136/merge");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.merge_method).toBe("squash");
    // Must NOT leak the camelCase variant into the wire format — the
    // backend's zod validator would silently drop it and fall back to
    // the default, which is subtle and wrong if the caller picked
    // "rebase".
    expect(body).not.toHaveProperty("mergeMethod");
    // prNumber goes in the URL, not the body.
    expect(body).not.toHaveProperty("prNumber");
    expect(body.taskId).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("pull_requests_merge omits merge_method when mergeMethod unset so backend default (squash) applies", async () => {
    fetchMock.mockResolvedValue(ok({ merged: true, sha: null, message: "ok", task: { id: "t", status: "done" } }));
    await tool("pull_requests_merge").handler({
      taskId: "44444444-4444-4444-4444-444444444444",
      owner: "o",
      repo: "r",
      prNumber: 1,
    });
    const [, init] = fetchMock.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed).not.toHaveProperty("merge_method");
    expect(parsed).not.toHaveProperty("mergeMethod");
  });

  it("pull_requests_comment routes to /pull-requests/{prNumber}/comments and keeps body field", async () => {
    fetchMock.mockResolvedValue(ok({ comment: { id: "c1" } }));
    await tool("pull_requests_comment").handler({
      taskId: "55555555-5555-5555-5555-555555555555",
      owner: "LanNguyenSi",
      repo: "agent-tasks",
      prNumber: 136,
      body: "CI green, merging now.",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/github/pull-requests/136/comments");
    expect(init.method).toBe("POST");
    const parsed = JSON.parse(init.body);
    expect(parsed).toEqual({
      taskId: "55555555-5555-5555-5555-555555555555",
      owner: "LanNguyenSi",
      repo: "agent-tasks",
      body: "CI green, merging now.",
    });
    expect(parsed).not.toHaveProperty("prNumber");
  });

  // ── projects_get ───────────────────────────────────────────────────

  it("projects_get routes UUIDs to /api/projects/:id", async () => {
    fetchMock.mockResolvedValue(ok({ project: { id: "77777777-7777-7777-7777-777777777777" } }));
    await tool("projects_get").handler({
      slugOrId: "77777777-7777-7777-7777-777777777777",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/projects/77777777-7777-7777-7777-777777777777",
    );
    expect(init.method).toBe("GET");
  });

  it("projects_get routes slugs to /api/projects/by-slug/:slug and URL-encodes them", async () => {
    fetchMock.mockResolvedValue(ok({ project: { slug: "agent tasks" } }));
    await tool("projects_get").handler({ slugOrId: "agent tasks" });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/projects/by-slug/agent%20tasks");
  });

  // ── review_* ───────────────────────────────────────────────────────

  it("review_approve POSTs action=approve with optional comment", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1", status: "done" } }));
    await tool("review_approve").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      comment: "lgtm",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/review",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ action: "approve", comment: "lgtm" });
  });

  it("review_request_changes POSTs action=request_changes", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1", status: "in_progress" } }));
    await tool("review_request_changes").handler({
      taskId: "22222222-2222-2222-2222-222222222222",
      comment: "please split the diff",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/22222222-2222-2222-2222-222222222222/review",
    );
    expect(JSON.parse(init.body)).toEqual({
      action: "request_changes",
      comment: "please split the diff",
    });
  });

  it("review_claim POSTs to /review/claim with no body", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("review_claim").handler({
      taskId: "33333333-3333-3333-3333-333333333333",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/33333333-3333-3333-3333-333333333333/review/claim",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("review_release POSTs to /review/release", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("review_release").handler({
      taskId: "44444444-4444-4444-4444-444444444444",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/44444444-4444-4444-4444-444444444444/review/release",
    );
    expect(init.method).toBe("POST");
  });

  it("pull_requests_merge propagates a 403 delegation-missing error through wrap", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "forbidden",
          message:
            "No authorized user for GitHub delegation. A team member must connect GitHub and enable 'Allow agents to merge PRs' in Settings.",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      tool("pull_requests_merge").handler({
        taskId: "66666666-6666-6666-6666-666666666666",
        owner: "o",
        repo: "r",
        prNumber: 7,
      }),
    ).rejects.toThrow(/agent-tasks API 403.*delegation/);
  });
});
