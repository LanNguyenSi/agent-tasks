/**
 * Integration tests for the `POST /api/mcp` route.
 *
 * The route self-dispatches every tool call through the same Hono
 * app the REST routes live on. For these tests we inject a *fake*
 * Hono app whose routes record every inbound request — this lets
 * us assert "tool X forwarded to path Y with body Z" without
 * standing up Prisma, the real backend, or a second HTTP server.
 *
 * What we verify:
 *   1. Missing / malformed Authorization header → 401 before any
 *      MCP machinery runs.
 *   2. `tools/list` returns exactly the 20 expected tool names.
 *   3. `tools/call` for each family reaches the right self-dispatch
 *      path and forwards the caller's Bearer token verbatim.
 *   4. GET and DELETE return 405 with `Allow: POST`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mcpRouter, setApp } from "../../src/routes/mcp.js";
import type { AppVariables } from "../../src/types/hono.js";

interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  body: unknown;
}

/**
 * Build a disposable Hono app that mounts the MCP router AND a
 * catch-all handler that records every request. `callSelf` inside
 * `mcp.ts` calls `app.fetch(...)` on this same app — because we
 * inject this app via `setApp`, the tool handlers end up hitting
 * the recording catch-all instead of the real REST routes.
 */
function makeTestApp(): {
  app: Hono<{ Variables: AppVariables }>;
  recorded: RecordedRequest[];
  nextResponse: { status: number; json: unknown };
} {
  const recorded: RecordedRequest[] = [];
  const nextResponse = { status: 200, json: { ok: true } as unknown };

  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/mcp", mcpRouter);

  // Catch-all for the self-dispatch targets. Recorded for assertions,
  // returns the configured `nextResponse` so tool handlers can parse
  // a valid shape.
  app.all("*", async (c) => {
    const bodyText = await c.req.text().catch(() => "");
    let parsedBody: unknown = null;
    if (bodyText.length > 0) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        parsedBody = bodyText;
      }
    }
    const url = new URL(c.req.url);
    recorded.push({
      method: c.req.method,
      path: c.req.path,
      query: Object.fromEntries(url.searchParams),
      authorization: c.req.header("Authorization") ?? null,
      body: parsedBody,
    });
    return c.json(nextResponse.json, nextResponse.status as 200);
  });

  setApp(app);
  return { app, recorded, nextResponse };
}

async function mcpRequest(
  app: Hono<{ Variables: AppVariables }>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const req = new Request("http://127.0.0.1/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const res = await app.fetch(req);
  const raw = await res.text();
  let parsed: unknown = raw;
  if (raw.length > 0) {
    const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
    if (dataLine) {
      parsed = JSON.parse(dataLine.slice(6));
    } else {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
  }
  return { status: res.status, body: parsed };
}

describe("POST /api/mcp — auth gate", () => {
  let app: Hono<{ Variables: AppVariables }>;

  beforeEach(() => {
    ({ app } = makeTestApp());
  });

  it("rejects a request without an Authorization header", async () => {
    const res = await mcpRequest(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request whose Authorization header is not Bearer", async () => {
    const res = await mcpRequest(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Authorization: "Basic dXNlcjpwYXNz" },
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/mcp — tool registration", () => {
  let app: Hono<{ Variables: AppVariables }>;

  beforeEach(() => {
    ({ app } = makeTestApp());
  });

  it("tools/list returns the full set of 21 tools", async () => {
    const res = await mcpRequest(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Authorization: "Bearer good_token" },
    );
    expect(res.status).toBe(200);
    const payload = res.body as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = (payload.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(
      [
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
});

describe("POST /api/mcp — tool dispatch self-forwards via app.fetch", () => {
  let app: Hono<{ Variables: AppVariables }>;
  let recorded: RecordedRequest[];

  beforeEach(() => {
    ({ app, recorded } = makeTestApp());
  });

  afterEach(() => {
    recorded.length = 0;
  });

  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    await mcpRequest(
      app,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      { Authorization: "Bearer good_token" },
    );
  }

  it("projects_list → GET /api/projects/available with forwarded Bearer token", async () => {
    await callTool("projects_list", {});
    // The first recorded entry is the internal self-dispatch — the
    // MCP POST to /api/mcp itself also hits the Hono stack but
    // lands inside mcpRouter, not the catch-all, so it does NOT
    // appear in `recorded`.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      method: "GET",
      path: "/api/projects/available",
      authorization: "Bearer good_token",
    });
  });

  it("tasks_list forwards optional limit as a query parameter", async () => {
    await callTool("tasks_list", { limit: 25 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      method: "GET",
      path: "/api/tasks/claimable",
      query: { limit: "25" },
    });
  });

  it("tasks_list omits limit query when not provided", async () => {
    await callTool("tasks_list", {});
    expect(recorded).toHaveLength(1);
    expect(recorded[0].query).toEqual({});
  });

  it("tasks_create → POST /api/projects/:id/tasks with body", async () => {
    const projectId = "11111111-1111-1111-1111-111111111111";
    await callTool("tasks_create", {
      projectId,
      title: "MCP-created task",
      priority: "HIGH",
      externalRef: "mcp-1",
      labels: ["imported"],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      method: "POST",
      path: `/api/projects/${projectId}/tasks`,
      authorization: "Bearer good_token",
    });
    expect(recorded[0].body).toEqual({
      title: "MCP-created task",
      priority: "HIGH",
      externalRef: "mcp-1",
      labels: ["imported"],
    });
  });

  it("tasks_comment sends { content: ... } matching backend createCommentSchema", async () => {
    const taskId = "22222222-2222-2222-2222-222222222222";
    await callTool("tasks_comment", { taskId, content: "progress update" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      method: "POST",
      path: `/api/tasks/${taskId}/comments`,
      body: { content: "progress update" },
    });
  });

  it("tasks_transition forwards status + force + forceReason", async () => {
    const taskId = "33333333-3333-3333-3333-333333333333";
    await callTool("tasks_transition", {
      taskId,
      status: "done",
      force: true,
      forceReason: "hotfix rollback",
    });
    expect(recorded[0]).toMatchObject({
      method: "POST",
      path: `/api/tasks/${taskId}/transition`,
      body: { status: "done", force: true, forceReason: "hotfix rollback" },
    });
  });

  it("signals_poll → GET /api/agent/signals", async () => {
    await callTool("signals_poll", {});
    expect(recorded[0]).toMatchObject({
      method: "GET",
      path: "/api/agent/signals",
    });
  });

  it("signals_ack → POST /api/agent/signals/:id/ack", async () => {
    const signalId = "44444444-4444-4444-4444-444444444444";
    await callTool("signals_ack", { signalId });
    expect(recorded[0]).toMatchObject({
      method: "POST",
      path: `/api/agent/signals/${signalId}/ack`,
    });
  });

  it("projects_get routes a UUID to /api/projects/:id", async () => {
    const slugOrId = "77777777-7777-7777-7777-777777777777";
    await callTool("projects_get", { slugOrId });
    expect(recorded[0]).toMatchObject({
      method: "GET",
      path: `/api/projects/${slugOrId}`,
    });
  });

  it("projects_get routes a non-UUID slug to /api/projects/by-slug/:slug", async () => {
    // Hono decodes the path before recording; the wire-level encoding
    // is asserted in mcp-server/tests/tools.test.ts. Here we just
    // verify the UUID-vs-slug branch selected the slug route.
    await callTool("projects_get", { slugOrId: "alpha" });
    expect(recorded[0]).toMatchObject({
      method: "GET",
      path: "/api/projects/by-slug/alpha",
    });
  });

  it("review_approve → POST /api/tasks/:id/review with action=approve", async () => {
    const taskId = "88888888-8888-8888-8888-888888888888";
    await callTool("review_approve", { taskId, comment: "lgtm" });
    expect(recorded[0]).toMatchObject({
      method: "POST",
      path: `/api/tasks/${taskId}/review`,
      body: { action: "approve", comment: "lgtm" },
    });
  });

  it("review_request_changes → POST /api/tasks/:id/review with action=request_changes", async () => {
    const taskId = "99999999-9999-9999-9999-999999999999";
    await callTool("review_request_changes", {
      taskId,
      comment: "please split the diff",
    });
    expect(recorded[0]).toMatchObject({
      method: "POST",
      path: `/api/tasks/${taskId}/review`,
      body: { action: "request_changes", comment: "please split the diff" },
    });
  });

  it("review_claim → POST /api/tasks/:id/review/claim with no body", async () => {
    const taskId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await callTool("review_claim", { taskId });
    expect(recorded[0]).toMatchObject({
      method: "POST",
      path: `/api/tasks/${taskId}/review/claim`,
    });
  });

  it("review_release → POST /api/tasks/:id/review/release with no body", async () => {
    const taskId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await callTool("review_release", { taskId });
    expect(recorded[0]).toMatchObject({
      method: "POST",
      path: `/api/tasks/${taskId}/review/release`,
    });
  });

  // The remaining five tools are structurally identical to the
  // ones above — thin wrappers that rewrite a URL path and
  // optionally forward a body. Parameterized smoke so a typo in
  // any of them (e.g. `/instructions` vs `/instruction`) fails
  // red instead of shipping silently.
  const taskId = "55555555-5555-5555-5555-555555555555";
  it.each([
    {
      tool: "tasks_get",
      args: { taskId },
      expected: { method: "GET", path: `/api/tasks/${taskId}` },
    },
    {
      tool: "tasks_instructions",
      args: { taskId },
      expected: { method: "GET", path: `/api/tasks/${taskId}/instructions` },
    },
    {
      tool: "tasks_claim",
      args: { taskId },
      expected: { method: "POST", path: `/api/tasks/${taskId}/claim` },
    },
    {
      tool: "tasks_release",
      args: { taskId },
      expected: { method: "POST", path: `/api/tasks/${taskId}/release` },
    },
    {
      tool: "tasks_update",
      args: {
        taskId,
        branchName: "feat/x",
        prUrl: "https://github.com/o/r/pull/1",
        prNumber: 1,
      },
      expected: {
        method: "PATCH",
        path: `/api/tasks/${taskId}`,
        body: {
          branchName: "feat/x",
          prUrl: "https://github.com/o/r/pull/1",
          prNumber: 1,
        },
      },
    },
  ])("$tool self-dispatches to the right path", async ({ tool, args, expected }) => {
    await callTool(tool, args);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject(expected);
    expect(recorded[0].authorization).toBe("Bearer good_token");
  });
});

describe("POST /api/mcp — method gate", () => {
  let app: Hono<{ Variables: AppVariables }>;

  beforeEach(() => {
    ({ app } = makeTestApp());
  });

  it("GET /api/mcp returns 405 with Allow: POST", async () => {
    const res = await app.fetch(
      new Request("http://127.0.0.1/api/mcp", {
        method: "GET",
        headers: { Authorization: "Bearer good_token" },
      }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("DELETE /api/mcp returns 405", async () => {
    const res = await app.fetch(
      new Request("http://127.0.0.1/api/mcp", {
        method: "DELETE",
        headers: { Authorization: "Bearer good_token" },
      }),
    );
    expect(res.status).toBe(405);
  });
});
