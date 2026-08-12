import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { AgentTasksClient, AgentTasksApiError, ProjectSlugNotFoundError } from "../src/client.js";

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

    // rc-v1-C006: the slug -> id TTL cache.
    it("caches a resolved slug across repeated calls on the same client instance (no repeated by-slug round trip)", async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
        .mockResolvedValueOnce(ok({ tasks: [] }))
        .mockResolvedValueOnce(ok({ tasks: [] }));
      const client = new AgentTasksClient(config);
      await client.listProjectTasks("agent-tasks");
      expect(fetchMock).toHaveBeenCalledTimes(2); // by-slug + tasks

      await client.listProjectTasks("agent-tasks");
      // Second call reuses the cached id: only one more request (tasks),
      // no second by-slug round trip.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[2][0]).toBe(
        "https://example.test/api/projects/p1/tasks",
      );
    });
  });

  // ── Project-slug resolution: cache, invalidate-and-retry, unknown slug
  // (rc-v1-C006) ────────────────────────────────────────────────────────
  //
  // Shared machinery behind both listProjectTasks's existing slug-or-id
  // `project` param and createTaskByProjectSlug's new projectSlug field.
  describe("project-slug resolution (rc-v1-C006)", () => {
    it("throws ProjectSlugNotFoundError, not a bare AgentTasksApiError, on a fresh (non-cached) 404 slug lookup", async () => {
      fetchMock.mockResolvedValueOnce(err(404, { error: "not_found", message: "Resource not found" }));
      const client = new AgentTasksClient(config);
      await expect(client.listProjectTasks("no-such-project")).rejects.toBeInstanceOf(
        ProjectSlugNotFoundError,
      );
    });

    it("ProjectSlugNotFoundError carries the slug that failed to resolve", async () => {
      fetchMock.mockResolvedValueOnce(err(404, { error: "not_found", message: "Resource not found" }));
      const client = new AgentTasksClient(config);
      try {
        await client.listProjectTasks("no-such-project");
        throw new Error("expected a throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ProjectSlugNotFoundError);
        expect((e as ProjectSlugNotFoundError).slug).toBe("no-such-project");
      }
    });

    it("a non-404 error from the by-slug lookup propagates as a normal AgentTasksApiError, not ProjectSlugNotFoundError", async () => {
      fetchMock.mockResolvedValueOnce(err(500, { error: "internal", message: "boom" }));
      const client = new AgentTasksClient(config);
      await expect(client.listProjectTasks("agent-tasks")).rejects.toMatchObject({
        name: "AgentTasksApiError",
        status: 500,
      });
    });

    // STALE-ENTRY-AFTER-RENAME: the cache holds an id from a prior
    // resolution; the project behind that slug was reassigned/renamed so
    // the cached id no longer resolves downstream (simulated here as a 404
    // on the tasks fetch using the stale id). The resolver must invalidate
    // the stale entry and retry exactly once against a freshly resolved id,
    // succeeding without the caller ever seeing the intermediate failure.
    it("stale cached id: a downstream 404 invalidates the slug cache and retries once against a fresh lookup, succeeding", async () => {
      const client = new AgentTasksClient(config);
      fetchMock
        .mockResolvedValueOnce(ok({ project: { id: "p-old" } })) // warm the cache
        .mockResolvedValueOnce(ok({ tasks: [] })); // first call succeeds
      await client.listProjectTasks("agent-tasks");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock
        .mockResolvedValueOnce(err(404, { error: "not_found", message: "Resource not found" })) // stale id 404s
        .mockResolvedValueOnce(ok({ project: { id: "p-new" } })) // fresh by-slug lookup
        .mockResolvedValueOnce(ok({ tasks: [{ id: "t1" }] })); // retry succeeds

      const result = await client.listProjectTasks("agent-tasks");
      expect(result).toEqual({ tasks: [{ id: "t1" }] });
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(fetchMock.mock.calls[2][0]).toBe(
        "https://example.test/api/projects/p-old/tasks",
      );
      expect(fetchMock.mock.calls[3][0]).toBe(
        "https://example.test/api/projects/by-slug/agent-tasks",
      );
      expect(fetchMock.mock.calls[4][0]).toBe(
        "https://example.test/api/projects/p-new/tasks",
      );

      // The cache now holds the fresh id: a THIRD call reuses it directly,
      // no further by-slug round trip.
      fetchMock.mockResolvedValueOnce(ok({ tasks: [] }));
      await client.listProjectTasks("agent-tasks");
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(fetchMock.mock.calls[5][0]).toBe(
        "https://example.test/api/projects/p-new/tasks",
      );
    });

    it("a second 404 after the invalidate-and-retry propagates unchanged (single retry, not a loop)", async () => {
      const client = new AgentTasksClient(config);
      fetchMock
        .mockResolvedValueOnce(ok({ project: { id: "p-old" } }))
        .mockResolvedValueOnce(ok({ tasks: [] }));
      await client.listProjectTasks("agent-tasks");

      fetchMock
        .mockResolvedValueOnce(err(404, { error: "not_found", message: "Resource not found" })) // stale id 404s
        .mockResolvedValueOnce(ok({ project: { id: "p-new" } })) // fresh lookup succeeds
        .mockResolvedValueOnce(err(404, { error: "not_found", message: "Resource not found" })); // retry ALSO 404s

      await expect(client.listProjectTasks("agent-tasks")).rejects.toMatchObject({
        name: "AgentTasksApiError",
        status: 404,
      });
      // Exactly 3 more calls this round (downstream 404, fresh by-slug,
      // retry 404) -- no further attempt.
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    // createTaskByProjectSlug shares the same resolver/cache.
    it("createTaskByProjectSlug resolves the slug then POSTs to the resolved project's tasks endpoint", async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
        .mockResolvedValueOnce(ok({ task: { id: "t1" } }));
      const client = new AgentTasksClient(config);
      await client.createTaskByProjectSlug("agent-tasks", { title: "New task" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://example.test/api/projects/by-slug/agent-tasks",
      );
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe("https://example.test/api/projects/p1/tasks");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ title: "New task" });
    });

    it("createTaskByProjectSlug reuses a slug cached by a prior listProjectTasks call (shared cache)", async () => {
      const client = new AgentTasksClient(config);
      fetchMock
        .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
        .mockResolvedValueOnce(ok({ tasks: [] }));
      await client.listProjectTasks("agent-tasks");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockResolvedValueOnce(ok({ task: { id: "t1" } }));
      await client.createTaskByProjectSlug("agent-tasks", { title: "New task" });
      // No second by-slug round trip: only the create POST.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[2][0]).toBe(
        "https://example.test/api/projects/p1/tasks",
      );
    });

    it("ProjectSlugNotFoundError on createTaskByProjectSlug carries the slug that failed to resolve", async () => {
      fetchMock.mockResolvedValueOnce(err(404, { error: "not_found", message: "Resource not found" }));
      const client = new AgentTasksClient(config);
      try {
        await client.createTaskByProjectSlug("ghost-project", { title: "x" });
        throw new Error("expected a throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ProjectSlugNotFoundError);
        expect((e as ProjectSlugNotFoundError).slug).toBe("ghost-project");
      }
    });

    // TTL (~15 min per the task spec): a cache entry still within its TTL
    // is reused (already covered above); once the TTL lapses, the next
    // call must re-hit the network rather than serving an unboundedly
    // stale id forever.
    it("TTL: a cached slug entry is re-resolved (fresh network round trip) once ~15 minutes have elapsed", async () => {
      vi.useFakeTimers();
      try {
        const client = new AgentTasksClient(config);
        fetchMock
          .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
          .mockResolvedValueOnce(ok({ tasks: [] }));
        await client.listProjectTasks("agent-tasks");
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Just under the TTL: still cached, no extra by-slug call.
        vi.advanceTimersByTime(14 * 60 * 1000);
        fetchMock.mockResolvedValueOnce(ok({ tasks: [] }));
        await client.listProjectTasks("agent-tasks");
        expect(fetchMock).toHaveBeenCalledTimes(3);

        // Past the TTL: the cache entry has expired, so the next call
        // re-resolves the slug over the network.
        vi.advanceTimersByTime(2 * 60 * 1000);
        fetchMock
          .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
          .mockResolvedValueOnce(ok({ tasks: [] }));
        await client.listProjectTasks("agent-tasks");
        expect(fetchMock).toHaveBeenCalledTimes(5);
        expect(fetchMock.mock.calls[3][0]).toBe(
          "https://example.test/api/projects/by-slug/agent-tasks",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── pollSignals limit (rc-v1-C006) ──────────────────────────────────────
  describe("pollSignals", () => {
    it("forwards an explicit limit as a query param", async () => {
      fetchMock.mockResolvedValue(ok({ signals: [] }));
      const client = new AgentTasksClient(config);
      await client.pollSignals(200);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("https://example.test/api/agent/signals?limit=200");
    });

    it("omits the query string when limit is not passed (backward-compatible with the pre-rc-v1-C006 signature)", async () => {
      fetchMock.mockResolvedValue(ok({ signals: [] }));
      const client = new AgentTasksClient(config);
      await client.pollSignals();
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("https://example.test/api/agent/signals");
    });
  });
});
