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
        "project_tasks",
        "projects_get",
        "projects_get_effective_gates",
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
        "task_attachment_get",
        "task_attachment_list",
        "task_create",
        "task_finish",
        "task_merge",
        "task_note",
        "task_pickup",
        "task_respec",
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

  it("task_attachment_list GETs the task attachments endpoint", async () => {
    fetchMock.mockResolvedValue(ok({ attachments: [] }));
    await tool("task_attachment_list").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
    } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/attachments");
    expect(init.method).toBe("GET");
  });

  it("task_attachment_get builds the content URL with includeBase64 + byte limits", async () => {
    fetchMock.mockResolvedValue(ok({ attachment: {}, content: { status: "ready" } }));
    await tool("task_attachment_get").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      attachmentId: "22222222-2222-2222-2222-222222222222",
      includeBase64: true,
      textByteLimit: 1000,
      base64ByteLimit: 2000,
    } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(
      "/api/tasks/11111111-1111-1111-1111-111111111111/attachments/22222222-2222-2222-2222-222222222222/content",
    );
    expect(url).toContain("includeBase64=true");
    expect(url).toContain("textByteLimit=1000");
    expect(url).toContain("base64ByteLimit=2000");
    expect(init.method).toBe("GET");
  });

  it("task_attachment_get omits the query string when no options are set", async () => {
    fetchMock.mockResolvedValue(ok({ attachment: {}, content: { status: "ready" } }));
    await tool("task_attachment_get").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      attachmentId: "22222222-2222-2222-2222-222222222222",
    } as never);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/attachments/22222222-2222-2222-2222-222222222222/content",
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

  it("task_create forwards templateData to the backend create body", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_create").handler({
      projectId: "22222222-2222-2222-2222-222222222222",
      title: "Specced task",
      templateData: {
        goal: "ship it",
        acceptanceCriteria: "- tests green",
        agentPrompt: "Step 1: ...",
        prefers: { smallDiffs: true },
      },
    } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/projects/22222222-2222-2222-2222-222222222222/tasks",
    );
    expect(JSON.parse(init.body)).toEqual({
      title: "Specced task",
      templateData: {
        goal: "ship it",
        acceptanceCriteria: "- tests green",
        agentPrompt: "Step 1: ...",
        prefers: { smallDiffs: true },
      },
    });
  });

  // ── task_respec ────────────────────────────────────────────────────

  it("task_respec POSTs description to /api/tasks/:id/respec and returns task+confidence", async () => {
    fetchMock.mockResolvedValue(
      ok({
        task: { id: "t1", description: "new desc" },
        confidence: {
          score: 80,
          threshold: 70,
          enforcementMode: "BLOCK",
          blocking: false,
          missing: [],
          findings: [],
          nextActions: [],
        },
      }),
    );
    const result = await tool("task_respec").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      description: "new desc",
    } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/respec",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ description: "new desc" });
    // confidence must be passed through, not dropped.
    expect(result).toMatchObject({
      task: { id: "t1" },
      confidence: { score: 80, blocking: false },
    });
  });

  it("task_respec POSTs templateData only (description omitted from body)", async () => {
    fetchMock.mockResolvedValue(
      ok({ task: { id: "t1" }, confidence: { score: 60 } }),
    );
    await tool("task_respec").handler({
      taskId: "22222222-2222-2222-2222-222222222222",
      templateData: { goal: "ship it" },
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ templateData: { goal: "ship it" } });
    expect(body).not.toHaveProperty("description");
  });

  it("task_respec forwards both description and templateData when both are provided", async () => {
    fetchMock.mockResolvedValue(
      ok({ task: { id: "t1" }, confidence: { score: 90 } }),
    );
    await tool("task_respec").handler({
      taskId: "33333333-3333-3333-3333-333333333333",
      description: "new desc",
      templateData: { goal: "ship it" },
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      description: "new desc",
      templateData: { goal: "ship it" },
    });
  });

  it("task_respec rejects client-side when neither description nor templateData is provided (no HTTP call made)", async () => {
    await expect(
      tool("task_respec").handler({
        taskId: "44444444-4444-4444-4444-444444444444",
      } as never),
    ).rejects.toThrow(/at least one of description or templateData/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("task_respec maps 409 (claimed/non-open task) with the backend message", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "conflict",
          message: "Task must be open and unclaimed to respec",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      tool("task_respec").handler({
        taskId: "55555555-5555-5555-5555-555555555555",
        description: "new desc",
      } as never),
    ).rejects.toThrow(/agent-tasks API 409.*open and unclaimed/);
  });

  it("task_respec maps 403 (non-creator, allowNonCreatorRespec unset) with the backend message", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "forbidden",
          message:
            "Only the task's creator can respec it (a project admin can set allowNonCreatorRespec to relax this)",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      tool("task_respec").handler({
        taskId: "66666666-6666-6666-6666-666666666666",
        description: "new desc",
      } as never),
    ).rejects.toThrow(/agent-tasks API 403.*creator/);
  });

  it("task_respec maps 400 (empty description/templateData rejected by backend) with the backend message", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "bad_request", message: "description must not be empty" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      tool("task_respec").handler({
        taskId: "77777777-7777-7777-7777-777777777777",
        description: "   ",
      } as never),
    ).rejects.toThrow(/agent-tasks API 400.*must not be empty/);
  });

  it("task_respec maps 404 (unknown task) with the backend message", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      tool("task_respec").handler({
        taskId: "88888888-8888-8888-8888-888888888888",
        description: "new desc",
      } as never),
    ).rejects.toThrow(/agent-tasks API 404/);
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

  // ── project_tasks ──────────────────────────────────────────────────

  it("project_tasks accepts a slug and forwards filters to GET /projects/:id/tasks", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
      .mockResolvedValueOnce(ok({ tasks: [] }));
    await tool("project_tasks").handler({
      project: "agent-tasks",
      status: ["open"],
      priority: "HIGH",
      labels: ["mcp", "dx"],
      unclaimed: true,
      limit: 25,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.test/api/projects/by-slug/agent-tasks",
    );
    const url = fetchMock.mock.calls[1][0] as string;
    expect(url.startsWith("https://example.test/api/projects/p1/tasks?")).toBe(true);
    expect(url).toContain("status=open");
    expect(url).toContain("priority=HIGH");
    expect(url).toContain("labels=mcp%2Cdx");
    expect(url).toContain("unclaimed=true");
    expect(url).toContain("limit=25");
  });

  it("project_tasks skips the slug round-trip when given a UUID", async () => {
    fetchMock.mockResolvedValueOnce(ok({ tasks: [] }));
    await tool("project_tasks").handler({
      project: "00000000-0000-0000-0000-000000000001",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.test/api/projects/00000000-0000-0000-0000-000000000001/tasks",
    );
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

  // ── task_pickup reclassify ──────────────────────────────────────────

  it("task_pickup appends ?reclassify=true when reclassify=true", async () => {
    fetchMock.mockResolvedValue(ok({ kind: "idle" }));
    await tool("task_pickup").handler({ reclassify: true } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/pickup?reclassify=true");
    expect(init.method).toBe("POST");
  });

  it("task_pickup omits the reclassify query param when reclassify is not passed", async () => {
    fetchMock.mockResolvedValue(ok({ kind: "idle" }));
    await tool("task_pickup").handler({} as never);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/pickup");
    expect(url).not.toContain("reclassify");
  });

  it("task_pickup omits the reclassify query param when reclassify=false", async () => {
    fetchMock.mockResolvedValue(ok({ kind: "idle" }));
    await tool("task_pickup").handler({ reclassify: false } as never);
    const [url] = fetchMock.mock.calls[0];
    // Backend only honours the literal "?reclassify=true"; false means opt-out so we skip the param.
    expect(url).toBe("https://example.test/api/tasks/pickup");
  });

  // ── task_start reclassify ───────────────────────────────────────────

  it("task_start forwards reclassify as a JSON boolean in the request body", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_start").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      reclassify: true,
    } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/start",
    );
    expect(JSON.parse(init.body)).toEqual({ reclassify: true });
  });

  it("task_start forwards both branchName and reclassify in a single body", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_start").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      branchName: "feat/my-branch",
      reclassify: true,
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      branchName: "feat/my-branch",
      reclassify: true,
    });
  });

  it("task_start omits body when neither branchName nor reclassify are passed", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_start").handler({
      taskId: "22222222-2222-2222-2222-222222222222",
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeUndefined();
  });

  it("task_start omits reclassify from body when not provided but branchName is", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_start").handler({
      taskId: "33333333-3333-3333-3333-333333333333",
      branchName: "feat/only-branch",
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed).toEqual({ branchName: "feat/only-branch" });
    expect(parsed).not.toHaveProperty("reclassify");
  });

  it("task_start sends reclassify:false in the body when explicitly set to false (no-op on backend; documents start-vs-pickup asymmetry)", async () => {
    // task_pickup omits ?reclassify entirely for false; task_start sends the
    // JSON boolean because the backend schema is z.boolean().optional() and
    // false is a valid value (evaluates as !== true, so it is a backend no-op).
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_start").handler({
      taskId: "44444444-4444-4444-4444-444444444444",
      reclassify: false,
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ reclassify: false });
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
