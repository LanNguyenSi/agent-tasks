import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { AgentTasksClient, AgentTasksApiError } from "../src/client.js";

describe("AgentTasksClient", () => {
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

  function err(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("sends Authorization header on every request", async () => {
    fetchMock.mockResolvedValue(ok({ projects: [] }));
    const client = new AgentTasksClient(config);
    await client.listProjects();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer tok_abc");
  });

  it("strips trailing slash from baseUrl", async () => {
    fetchMock.mockResolvedValue(ok({ projects: [] }));
    const client = new AgentTasksClient({ ...config, baseUrl: "https://example.test/" });
    await client.listProjects();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/projects/available");
  });

  it("passes limit as query string on listClaimableTasks", async () => {
    fetchMock.mockResolvedValue(ok({ tasks: [] }));
    const client = new AgentTasksClient(config);
    await client.listClaimableTasks({ limit: 50 });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/claimable?limit=50");
  });

  it("omits query string when limit is missing", async () => {
    fetchMock.mockResolvedValue(ok({ tasks: [] }));
    const client = new AgentTasksClient(config);
    await client.listClaimableTasks();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/claimable");
  });

  it("serializes filter params on listClaimableTasks", async () => {
    fetchMock.mockResolvedValue(ok({ tasks: [] }));
    const client = new AgentTasksClient(config);
    await client.listClaimableTasks({
      status: ["open", "in_progress"],
      priority: "HIGH",
      labels: ["mcp", "friction"],
      claimedByAgentId: "me",
      verbose: true,
      projectId: "proj-1",
      limit: 10,
    });
    const [url] = fetchMock.mock.calls[0];
    const u = new URL(url);
    expect(u.pathname).toBe("/api/tasks/claimable");
    expect(u.searchParams.get("status")).toBe("open,in_progress");
    expect(u.searchParams.get("priority")).toBe("HIGH");
    expect(u.searchParams.get("labels")).toBe("mcp,friction");
    expect(u.searchParams.get("claimedByAgentId")).toBe("me");
    expect(u.searchParams.get("verbose")).toBe("true");
    expect(u.searchParams.get("projectId")).toBe("proj-1");
    expect(u.searchParams.get("limit")).toBe("10");
  });

  it("omits verbose query when false on listClaimableTasks", async () => {
    fetchMock.mockResolvedValue(ok({ tasks: [] }));
    const client = new AgentTasksClient(config);
    await client.listClaimableTasks({ verbose: false });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/claimable");
  });

  // ── sort + cursor (task 14c947a7) ───────────────────────────────────────

  it("forwards sort and cursor as query params on listClaimableTasks", async () => {
    fetchMock.mockResolvedValue(ok({ tasks: [], nextCursor: null }));
    const client = new AgentTasksClient(config);
    await client.listClaimableTasks({ sort: "createdAt:desc", cursor: "task-1" });
    const [url] = fetchMock.mock.calls[0];
    const u = new URL(url);
    expect(u.searchParams.get("sort")).toBe("createdAt:desc");
    expect(u.searchParams.get("cursor")).toBe("task-1");
  });

  it("omits sort and cursor from the query string when not provided", async () => {
    fetchMock.mockResolvedValue(ok({ tasks: [] }));
    const client = new AgentTasksClient(config);
    await client.listClaimableTasks();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/claimable");
  });

  it("serializes body and sets Content-Type on POST", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    const client = new AgentTasksClient(config);
    await client.createTask("proj1", { title: "Hello" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/projects/proj1/tasks");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ title: "Hello" });
  });

  it("forwards dependsOn through createTask body", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    const client = new AgentTasksClient(config);
    const blockerA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const blockerB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await client.createTask("proj1", {
      title: "Child",
      dependsOn: [blockerA, blockerB],
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      title: "Child",
      dependsOn: [blockerA, blockerB],
    });
  });

  it("throws AgentTasksApiError with status and body on non-2xx", async () => {
    fetchMock.mockResolvedValue(err(403, { message: "forbidden" }));
    const client = new AgentTasksClient(config);
    await expect(client.claimTask("abc")).rejects.toMatchObject({
      name: "AgentTasksApiError",
      status: 403,
    });
  });

  it("AgentTasksApiError carries parsed body", async () => {
    fetchMock.mockResolvedValue(err(409, { message: "conflict", code: "already_claimed" }));
    const client = new AgentTasksClient(config);
    try {
      await client.claimTask("abc");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentTasksApiError);
      const apiErr = e as AgentTasksApiError;
      expect(apiErr.status).toBe(409);
      expect(apiErr.body).toMatchObject({ code: "already_claimed" });
    }
  });

  it("transitionTask sends status + force fields", async () => {
    fetchMock.mockResolvedValue(ok({ task: { status: "done" } }));
    const client = new AgentTasksClient(config);
    await client.transitionTask("t1", { status: "done", force: true, forceReason: "emergency" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/t1/transition");
    expect(JSON.parse(init.body)).toEqual({
      status: "done",
      force: true,
      forceReason: "emergency",
    });
  });

  it("addTaskComment wraps content in body matching backend schema", async () => {
    fetchMock.mockResolvedValue(ok({ comment: { id: "c1" } }));
    const client = new AgentTasksClient(config);
    await client.addTaskComment("t1", "hello");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/t1/comments");
    expect(JSON.parse(init.body)).toEqual({ content: "hello" });
  });

  it("respecTask POSTs description + templateData to /tasks/:id/respec", async () => {
    fetchMock.mockResolvedValue(
      ok({ task: { id: "t1" }, confidence: { score: 75 } }),
    );
    const client = new AgentTasksClient(config);
    await client.respecTask("t1", {
      description: "new desc",
      templateData: { goal: "ship it" },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/t1/respec");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      description: "new desc",
      templateData: { goal: "ship it" },
    });
  });

  it("ackSignal uses POST with no body", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    const client = new AgentTasksClient(config);
    await client.ackSignal("sig1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/agent/signals/sig1/ack");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  describe("listProjectTasks", () => {
    it("passes UUID through without a slug-lookup round-trip", async () => {
      fetchMock.mockResolvedValueOnce(ok({ tasks: [] }));
      const client = new AgentTasksClient(config);
      await client.listProjectTasks("00000000-0000-0000-0000-000000000001");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "https://example.test/api/projects/00000000-0000-0000-0000-000000000001/tasks",
      );
    });

    it("resolves a slug via /projects/by-slug before hitting the tasks endpoint", async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
        .mockResolvedValueOnce(ok({ tasks: [] }));
      const client = new AgentTasksClient(config);
      await client.listProjectTasks("agent-tasks");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://example.test/api/projects/by-slug/agent-tasks",
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        "https://example.test/api/projects/p1/tasks",
      );
    });

    it("encodes filters as comma-separated query params", async () => {
      fetchMock.mockResolvedValueOnce(ok({ tasks: [] }));
      const client = new AgentTasksClient(config);
      await client.listProjectTasks("00000000-0000-0000-0000-000000000001", {
        status: ["open", "in_progress"],
        priority: "HIGH",
        labels: ["mcp", "dx"],
        unclaimed: true,
        limit: 25,
      });
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("status=open%2Cin_progress");
      expect(url).toContain("priority=HIGH");
      expect(url).toContain("labels=mcp%2Cdx");
      expect(url).toContain("unclaimed=true");
      expect(url).toContain("limit=25");
    });

    it("omits unclaimed when not set", async () => {
      fetchMock.mockResolvedValueOnce(ok({ tasks: [] }));
      const client = new AgentTasksClient(config);
      await client.listProjectTasks("00000000-0000-0000-0000-000000000001", {});
      expect(fetchMock.mock.calls[0][0]).not.toContain("unclaimed");
    });

    it("forwards sort and cursor as query params (task 14c947a7)", async () => {
      fetchMock.mockResolvedValueOnce(ok({ tasks: [], nextCursor: null }));
      const client = new AgentTasksClient(config);
      await client.listProjectTasks("00000000-0000-0000-0000-000000000001", {
        sort: "createdAt:asc",
        cursor: "task-42",
      });
      const url = fetchMock.mock.calls[0][0] as string;
      const u = new URL(url);
      expect(u.searchParams.get("sort")).toBe("createdAt:asc");
      expect(u.searchParams.get("cursor")).toBe("task-42");
    });

    it("omits sort and cursor from the query string when not provided", async () => {
      fetchMock.mockResolvedValueOnce(ok({ tasks: [] }));
      const client = new AgentTasksClient(config);
      await client.listProjectTasks("00000000-0000-0000-0000-000000000001", {});
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).not.toContain("sort");
      expect(url).not.toContain("cursor");
    });

    it("URL-encodes slugs containing special characters", async () => {
      // The server's slug regex is [a-z0-9-], so a slash should never appear
      // in practice; encodeURIComponent is still the right hammer so a stray
      // value 404s on the literal path rather than escaping the segment.
      fetchMock
        .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
        .mockResolvedValueOnce(ok({ tasks: [] }));
      const client = new AgentTasksClient(config);
      await client.listProjectTasks("weird/slug");
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://example.test/api/projects/by-slug/weird%2Fslug",
      );
    });
  });
});
