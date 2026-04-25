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

  it("ackSignal uses POST with no body", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    const client = new AgentTasksClient(config);
    await client.ackSignal("sig1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/agent/signals/sig1/ack");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});
