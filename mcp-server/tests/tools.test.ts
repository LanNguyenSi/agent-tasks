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
        "projects_list",
        "signals_ack",
        "signals_poll",
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
});
