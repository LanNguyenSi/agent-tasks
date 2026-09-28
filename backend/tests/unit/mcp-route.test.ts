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
  idempotencyKey: string | null;
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
      idempotencyKey: c.req.header("Idempotency-Key") ?? null,
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

  it("tools/list returns the full set of 26 tools", async () => {
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
        "task_abandon",
        "task_finish",
        "task_grounding_attempt_create",
        "task_grounding_receipt_upload",
        "task_merge",
      ].sort(),
    );
  });
});

describe("POST /api/mcp — tool dispatch self-forwards via app.fetch", () => {
  let app: Hono<{ Variables: AppVariables }>;
  let recorded: RecordedRequest[];
  let nextResponse: { status: number; json: unknown };

  beforeEach(() => {
    ({ app, recorded, nextResponse } = makeTestApp());
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

  it("tasks_list serializes status/priority/labels arrays as CSV", async () => {
    await callTool("tasks_list", {
      status: ["open", "in_progress"],
      priority: ["HIGH", "CRITICAL"],
      labels: ["mcp", "friction"],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].query).toEqual({
      status: "open,in_progress",
      priority: "HIGH,CRITICAL",
      labels: "mcp,friction",
    });
  });

  it("tasks_list serializes scalar status/priority verbatim", async () => {
    await callTool("tasks_list", {
      status: "in_progress",
      priority: "HIGH",
    });
    expect(recorded[0].query).toEqual({
      status: "in_progress",
      priority: "HIGH",
    });
  });

  it("tasks_list forwards claimedByAgentId='me' through to the backend", async () => {
    await callTool("tasks_list", { claimedByAgentId: "me" });
    expect(recorded[0].query).toEqual({ claimedByAgentId: "me" });
  });

  it("tasks_list forwards verbose=true and projectId together", async () => {
    const projectId = "11111111-2222-3333-4444-555555555555";
    await callTool("tasks_list", { verbose: true, projectId });
    expect(recorded[0].query).toEqual({
      verbose: "true",
      projectId,
    });
  });

  it("tasks_list omits verbose when false (default summary projection)", async () => {
    await callTool("tasks_list", { verbose: false });
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

  it("tasks_create forwards dependsOn through to the backend body", async () => {
    const projectId = "11111111-1111-1111-1111-111111111111";
    const blockerA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const blockerB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await callTool("tasks_create", {
      projectId,
      title: "Child task",
      dependsOn: [blockerA, blockerB],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].body).toEqual({
      title: "Child task",
      dependsOn: [blockerA, blockerB],
    });
  });

  it("tasks_create forwards templateData through to the backend body", async () => {
    const projectId = "11111111-1111-1111-1111-111111111111";
    await callTool("tasks_create", {
      projectId,
      title: "Specced task",
      templateData: {
        goal: "ship it",
        acceptanceCriteria: "- tests green",
        agentPrompt: "Step 1: ...",
        prefers: { smallDiffs: true },
      },
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].body).toEqual({
      title: "Specced task",
      templateData: {
        goal: "ship it",
        acceptanceCriteria: "- tests green",
        agentPrompt: "Step 1: ...",
        prefers: { smallDiffs: true },
      },
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

  it("grounding tools forward the exact challenge and signed-receipt contracts", async () => {
    const taskId = "33333333-3333-3333-3333-333333333333";
    const attemptId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await callTool("task_grounding_attempt_create", { taskId, intent: "finish" });
    expect(recorded[0]).toMatchObject({ method: "POST", path: `/api/tasks/${taskId}/grounding-attempts`, body: { intent: "finish" } });
    recorded.length = 0;
    await callTool("task_grounding_receipt_upload", { taskId, attemptId, session: { id: "producer.session", revision: 1 }, receipt: '{"signed":"bytes"}' });
    expect(recorded[0]).toMatchObject({ method: "POST", path: `/api/tasks/${taskId}/grounding-attempts/${attemptId}/receipt`, body: { session: { id: "producer.session", revision: 1 }, receipt: '{"signed":"bytes"}' } });
  });

  it("rejects a non-HTTP finish prUrl before self-dispatch", async () => {
    const response = await mcpRequest(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_finish", arguments: { taskId: "33333333-3333-3333-3333-333333333333", prUrl: "javascript:alert(1)" } } }, { Authorization: "Bearer good_token" });
    expect(response.status).toBe(200);
    expect(recorded).toHaveLength(0);
    expect(response.body).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("Invalid arguments") }] } });
  });

  it("can complete the hosted assessment transport sequence without treating receipt upload as completion", async () => {
    const taskId = "33333333-3333-3333-3333-333333333333";
    const attemptId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    nextResponse.json = { attemptId, nonce: "challenge-nonce" };
    const challenge = await mcpRequest(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_grounding_attempt_create", arguments: { taskId, intent: "finish" } } }, { Authorization: "Bearer good_token" });
    expect(challenge.body).toMatchObject({ result: { content: [{ text: expect.stringContaining("challenge-nonce") }] } });
    nextResponse.json = { receiptId: "receipt-1", replayed: false };
    const uploaded = await mcpRequest(app, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "task_grounding_receipt_upload", arguments: { taskId, attemptId, session: { id: "producer", revision: 1 }, receipt: "{}" } } }, { Authorization: "Bearer good_token" });
    expect(uploaded.body).toMatchObject({ result: { content: [{ text: expect.stringContaining("receipt-1") }] } });
    nextResponse.json = { task: { id: taskId, status: "review" } };
    const completed = await mcpRequest(app, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "task_finish", arguments: { taskId, operationKey: "operation-1" } } }, { Authorization: "Bearer good_token" });
    expect(completed.body).toMatchObject({ result: { content: [{ text: expect.stringContaining('"status": "review"') }] } });
    expect(recorded.map(request => request.path)).toEqual([`/api/tasks/${taskId}/grounding-attempts`, `/api/tasks/${taskId}/grounding-attempts/${attemptId}/receipt`, `/api/tasks/${taskId}/finish`]);
  });

  it("passes operationKey as Idempotency-Key for completion without turning a pending response into success", async () => {
    const taskId = "33333333-3333-3333-3333-333333333333";
    nextResponse.status = 202;
    nextResponse.json = { pending: true, operationId: "op-1" };
    const response = await mcpRequest(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_finish", arguments: { taskId, operationKey: "retry-key-1" } } }, { Authorization: "Bearer good_token" });
    expect(response.status).toBe(200);
    expect(recorded[0]).toMatchObject({ method: "POST", path: `/api/tasks/${taskId}/finish`, body: {} });
    expect(recorded[0].authorization).toBe("Bearer good_token");
    expect(recorded[0].idempotencyKey).toBe("retry-key-1");
    expect(response.body).toMatchObject({ result: { content: [{ text: expect.stringContaining('"pending": true') }] } });
  });

  // Operation/idempotency-key coverage for the five remote-MCP tools that
  // now always send a key (see mcp.ts's resolveOperationKey): the caller's
  // explicit key is forwarded unchanged, and an omitted key is replaced by
  // a freshly generated one so a provisioned Grounding backend always
  // receives one while an unconfigured (legacy) backend keeps working
  // (it just ignores the header/field it does not require).
  const TASK_ID = "33333333-3333-3333-3333-333333333333";

  it.each([
    { name: "task_finish", args: { taskId: TASK_ID }, path: `/api/tasks/${TASK_ID}/finish` },
    { name: "task_merge", args: { taskId: TASK_ID }, path: `/api/tasks/${TASK_ID}/merge` },
    { name: "task_abandon", args: { taskId: TASK_ID }, path: `/api/tasks/${TASK_ID}/abandon` },
  ])("$name forwards an explicit operationKey as Idempotency-Key unchanged", async ({ name, args, path }) => {
    await callTool(name, { ...args, operationKey: "explicit-key-1" });
    expect(recorded[0]).toMatchObject({ method: "POST", path });
    expect(recorded[0].idempotencyKey).toBe("explicit-key-1");
  });

  it.each([
    { name: "task_finish", args: { taskId: TASK_ID }, path: `/api/tasks/${TASK_ID}/finish` },
    { name: "task_merge", args: { taskId: TASK_ID }, path: `/api/tasks/${TASK_ID}/merge` },
    { name: "task_abandon", args: { taskId: TASK_ID }, path: `/api/tasks/${TASK_ID}/abandon` },
  ])("$name generates an Idempotency-Key header when operationKey is omitted", async ({ name, args, path }) => {
    await callTool(name, args);
    expect(recorded[0]).toMatchObject({ method: "POST", path });
    expect(recorded[0].idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  });

  it.each(["task_finish", "task_merge", "task_abandon"])(
    "%s generates a DIFFERENT Idempotency-Key on each call when operationKey is omitted",
    async (name) => {
      await callTool(name, { taskId: TASK_ID });
      await callTool(name, { taskId: TASK_ID });
      expect(recorded).toHaveLength(2);
      expect(recorded[0].idempotencyKey).toBeTruthy();
      expect(recorded[1].idempotencyKey).toBeTruthy();
      expect(recorded[0].idempotencyKey).not.toBe(recorded[1].idempotencyKey);
    },
  );

  it("pull_requests_create forwards an explicit idempotencyKey unchanged, as both header and body", async () => {
    await callTool("pull_requests_create", {
      taskId: TASK_ID,
      owner: "o",
      repo: "r",
      head: "b",
      title: "t",
      idempotencyKey: "explicit-key-2",
    });
    expect(recorded[0]).toMatchObject({ method: "POST", path: "/api/github/pull-requests" });
    expect(recorded[0].idempotencyKey).toBe("explicit-key-2");
    expect((recorded[0].body as { idempotencyKey?: string }).idempotencyKey).toBe("explicit-key-2");
  });

  it("pull_requests_create generates an idempotencyKey (header + body) when omitted", async () => {
    await callTool("pull_requests_create", { taskId: TASK_ID, owner: "o", repo: "r", head: "b", title: "t" });
    const bodyKey = (recorded[0].body as { idempotencyKey?: string }).idempotencyKey;
    expect(bodyKey).toBeTruthy();
    expect(recorded[0].idempotencyKey).toBe(bodyKey);
  });

  it("pull_requests_merge forwards an explicit idempotencyKey unchanged, as both header and body", async () => {
    await callTool("pull_requests_merge", {
      taskId: TASK_ID,
      owner: "o",
      repo: "r",
      prNumber: 1,
      idempotencyKey: "explicit-key-3",
    });
    expect(recorded[0]).toMatchObject({ method: "POST", path: "/api/github/pull-requests/1/merge" });
    expect(recorded[0].idempotencyKey).toBe("explicit-key-3");
    expect((recorded[0].body as { idempotencyKey?: string }).idempotencyKey).toBe("explicit-key-3");
  });

  it("pull_requests_merge generates an idempotencyKey (header + body) when omitted", async () => {
    await callTool("pull_requests_merge", { taskId: TASK_ID, owner: "o", repo: "r", prNumber: 1 });
    const bodyKey = (recorded[0].body as { idempotencyKey?: string }).idempotencyKey;
    expect(bodyKey).toBeTruthy();
    expect(recorded[0].idempotencyKey).toBe(bodyKey);
  });

  // Format-narrowing coverage: pull_requests_create's idempotencyKey uses
  // the wider createIdempotencyKey pattern (printable ASCII, 1-255, may
  // contain '/'), while pull_requests_merge and the three task_* verbs use
  // the operationKey pattern (1-128 chars of [A-Za-z0-9._:-]). A
  // mutant that widens pull_requests_merge's schema to createIdempotencyKey
  // would let a 200-char key through and dispatch the merge call; the
  // 200-char merge test below catches that.
  it("pull_requests_create forwards a 200-char printable-ASCII idempotencyKey containing '/' unchanged, as both header and body", async () => {
    const key = `${"a/".repeat(99)}aa`; // 200 chars, contains '/', outside operationKey's charset
    expect(key).toHaveLength(200);
    await callTool("pull_requests_create", {
      taskId: TASK_ID,
      owner: "o",
      repo: "r",
      head: "b",
      title: "t",
      idempotencyKey: key,
    });
    expect(recorded[0]).toMatchObject({ method: "POST", path: "/api/github/pull-requests" });
    expect(recorded[0].idempotencyKey).toBe(key);
    expect((recorded[0].body as { idempotencyKey?: string }).idempotencyKey).toBe(key);
  });

  // Accept side of both length caps: a key at exactly the upper bound is
  // dispatched unchanged, so a lowered cap (1-200 for create, 1-100 for the
  // operationKey format) fails here.
  it("pull_requests_create dispatches a 255-char printable-ASCII idempotencyKey (the upper bound) unchanged, as both header and body", async () => {
    const key = "a/~".repeat(85);
    expect(key).toHaveLength(255);
    await callTool("pull_requests_create", {
      taskId: TASK_ID,
      owner: "o",
      repo: "r",
      head: "b",
      title: "t",
      idempotencyKey: key,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ method: "POST", path: "/api/github/pull-requests" });
    expect(recorded[0].idempotencyKey).toBe(key);
    expect((recorded[0].body as { idempotencyKey?: string }).idempotencyKey).toBe(key);
  });

  it.each([
    { name: "pull_requests_merge", args: { taskId: TASK_ID, owner: "o", repo: "r", prNumber: 1 }, keyField: "idempotencyKey", path: "/api/github/pull-requests/1/merge", inBody: true },
    { name: "task_finish", args: { taskId: TASK_ID }, keyField: "operationKey", path: `/api/tasks/${TASK_ID}/finish`, inBody: false },
    { name: "task_merge", args: { taskId: TASK_ID }, keyField: "operationKey", path: `/api/tasks/${TASK_ID}/merge`, inBody: false },
    { name: "task_abandon", args: { taskId: TASK_ID }, keyField: "operationKey", path: `/api/tasks/${TASK_ID}/abandon`, inBody: false },
  ])("$name dispatches a 128-char $keyField (the upper bound) unchanged", async ({ name, args, keyField, path, inBody }) => {
    const key = "Az09._:-".repeat(16);
    expect(key).toHaveLength(128);
    await callTool(name, { ...args, [keyField]: key });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ method: "POST", path });
    expect(recorded[0].idempotencyKey).toBe(key);
    expect((recorded[0].body as { idempotencyKey?: string }).idempotencyKey).toBe(inBody ? key : undefined);
  });

  it("rejects a pull_requests_create idempotencyKey containing whitespace before self-dispatch", async () => {
    const response = await mcpRequest(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pull_requests_create", arguments: { taskId: TASK_ID, owner: "o", repo: "r", head: "b", title: "t", idempotencyKey: "has a space" } } },
      { Authorization: "Bearer good_token" },
    );
    expect(response.status).toBe(200);
    expect(recorded).toHaveLength(0);
    expect(response.body).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("Invalid arguments") }] } });
  });

  it.each([
    { name: "pull_requests_merge", args: { taskId: TASK_ID, owner: "o", repo: "r", prNumber: 1 }, keyField: "idempotencyKey" },
    { name: "task_finish", args: { taskId: TASK_ID }, keyField: "operationKey" },
    { name: "task_merge", args: { taskId: TASK_ID }, keyField: "operationKey" },
    { name: "task_abandon", args: { taskId: TASK_ID }, keyField: "operationKey" },
  ])("rejects a 129-char $keyField on $name before self-dispatch", async ({ name, args, keyField }) => {
    const key = "a".repeat(129);
    const response = await mcpRequest(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args, [keyField]: key } } },
      { Authorization: "Bearer good_token" },
    );
    expect(response.status).toBe(200);
    expect(recorded).toHaveLength(0);
    expect(response.body).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("Invalid arguments") }] } });
  });

  it("rejects a 200-char idempotencyKey on pull_requests_merge before self-dispatch", async () => {
    // Guards against a mutant that widens pull_requests_merge's schema from
    // operationKey to createIdempotencyKey: a 200-char all-letter key is
    // valid under the wide format but exceeds operationKey's 128-char cap,
    // so it must still be rejected locally, before any self-dispatch call.
    const key = "a".repeat(200);
    const response = await mcpRequest(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pull_requests_merge", arguments: { taskId: TASK_ID, owner: "o", repo: "r", prNumber: 1, idempotencyKey: key } } },
      { Authorization: "Bearer good_token" },
    );
    expect(response.status).toBe(200);
    expect(recorded).toHaveLength(0);
    expect(response.body).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("Invalid arguments") }] } });
  });

  it("rejects an oversized multibyte receipt before it reaches the REST route", async () => {
    const taskId = "33333333-3333-3333-3333-333333333333";
    const response = await mcpRequest(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_grounding_receipt_upload", arguments: { taskId, attemptId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", session: { id: "producer", revision: 1 }, receipt: "😀".repeat(8_193) } } }, { Authorization: "Bearer good_token" });
    expect(response.status).toBe(200);
    expect(recorded).toHaveLength(0);
    expect(response.body).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("32768 UTF-8 bytes") }] } });
  });

  it("preserves a stable grounding error code when the backend provides no message", async () => {
    const taskId = "33333333-3333-3333-3333-333333333333";
    nextResponse.status = 409;
    nextResponse.json = { error: "grounding_required" };
    const response = await mcpRequest(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_finish", arguments: { taskId, operationKey: "retry-key-1" } } }, { Authorization: "Bearer good_token" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("grounding_required") }] } });
  });

  it.each(["grounding_receipt_unsupported", "grounding_receipt_untrusted", "grounding_verification_unavailable", "grounding_receipt_mismatch"])("preserves embedded grounding code %s", async (code) => {
    nextResponse.status = code === "grounding_verification_unavailable" ? 503 : 409;
    nextResponse.json = { error: code };
    const response = await mcpRequest(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_finish", arguments: { taskId: "33333333-3333-3333-3333-333333333333", operationKey: "retry-key-1" } } }, { Authorization: "Bearer good_token" });
    expect(response.body).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining(code) }] } });
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
