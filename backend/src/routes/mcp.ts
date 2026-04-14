/**
 * HTTP-transport peer of the stdio `@agent-tasks/mcp-server` package.
 * Exposes the same 15 tools over JSON-RPC via the MCP SDK's
 * `WebStandardStreamableHTTPServerTransport`, which plugs directly
 * into Hono's fetch-native request/response.
 *
 * ## Why
 *
 * Remote MCP clients (e.g. Triologue's `mcpBridge.ts`) speak HTTP +
 * JSON-RPC, not stdio. Without an HTTP endpoint, those clients cannot
 * reach the agent-tasks tool surface at all. This route closes the
 * gap without disturbing the stdio package, which stays the
 * preferred path for local Claude Code / Cursor integrations.
 *
 * ## Transport
 *
 * Stateless — one `McpServer` per HTTP request, no session ID, no
 * reconnection state. Each request carries its own Bearer token in
 * the Authorization header. The authMiddleware that gates
 * `/api/mcp` (wired in `app.ts`) validates the token before this
 * handler ever sees it, and the handler re-reads the raw token off
 * the request so it can forward it into the self-dispatch fetch
 * calls that the individual tool handlers make.
 *
 * ## Tool dispatch via `app.fetch`
 *
 * Instead of duplicating the business logic of every REST route
 * into a second code path, the tool handlers reuse the existing
 * routes by calling `app.fetch(request)` — the Hono app's own
 * fetch handler. This keeps validation, authz, audit, and signal
 * emission in exactly one place (the REST routes in
 * `backend/src/routes/*.ts`). The only cost is a second pass
 * through `authMiddleware` per tool call, which is cheap (one
 * indexed Prisma lookup).
 *
 * The Hono app reference is injected at startup via `setApp`
 * because importing `app.ts` here would create a circular
 * dependency — same pattern the byoa-mcp and byoa-sse routes use
 * in `triologue-agent-gateway`.
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { AppVariables } from "../types/hono.js";

type HonoApp = Hono<{ Variables: AppVariables }>;

let appRef: HonoApp | null = null;

/**
 * Inject the Hono app instance used by the tool handlers for
 * self-dispatch. Called from `createApp` once the app is built.
 */
export function setApp(app: HonoApp): void {
  appRef = app;
}

function getApp(): HonoApp {
  if (!appRef) {
    throw new Error(
      "routes/mcp: app not set — call setApp() during startup before handling requests",
    );
  }
  return appRef;
}

/**
 * Self-dispatch helper. Rebuilds a fetch `Request` pointing at a
 * local path and runs it through the same Hono app stack the REST
 * API uses. Re-adds the caller's Bearer token so the inner route's
 * `authMiddleware` re-validates it — cheap (indexed lookup) and
 * keeps the MCP path from bypassing any downstream authz.
 */
async function callSelf(
  path: string,
  init: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
  },
  token: string,
): Promise<unknown> {
  // The host part is ignored by Hono's internal router — we only
  // need a well-formed absolute URL so `new Request()` accepts it.
  const url = `http://127.0.0.1${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const req = new Request(url, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const res = await getApp().fetch(req);
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : `backend ${res.status}`;
    throw new Error(`agent-tasks API ${res.status}: ${message}`);
  }
  return parsed;
}

// ── Tool definitions ────────────────────────────────────────────────────────

const transitionStatusEnum = z.enum([
  "open",
  "in_progress",
  "review",
  "done",
]);
const priorityEnum = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const uuid = () => z.string().uuid();

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * Build a fresh `McpServer` with all 15 tools bound to the caller's
 * token. Called per request so there is no shared mutable state
 * between concurrent MCP requests.
 */
function buildServer(token: string): McpServer {
  const server = new McpServer({
    name: "agent-tasks-mcp-http",
    version: "0.1.0",
  });

  server.registerTool(
    "projects_list",
    {
      description:
        "List all projects visible to the authenticated actor. Returns id, slug, name, and GitHub repo for each.",
      inputSchema: {},
    },
    async () => {
      try {
        const r = await callSelf("/api/projects/available", { method: "GET" }, token);
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "tasks_list",
    {
      description:
        "List tasks that the authenticated actor may claim (status=open, not blocked, not already claimed). Supports an optional limit.",
      inputSchema: {
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ limit }) => {
      try {
        const qs = limit !== undefined ? `?limit=${limit}` : "";
        const r = await callSelf(`/api/tasks/claimable${qs}`, { method: "GET" }, token);
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "tasks_get",
    {
      description: "Fetch a single task by id, including comments and dependencies.",
      inputSchema: { taskId: uuid() },
    },
    async ({ taskId }) => {
      try {
        const r = await callSelf(`/api/tasks/${taskId}`, { method: "GET" }, token);
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "tasks_instructions",
    {
      description:
        "Fetch agent-facing instructions for a task: current state, allowed transitions, confidence score, required-field checklist, and updatable fields.",
      inputSchema: { taskId: uuid() },
    },
    async ({ taskId }) => {
      try {
        const r = await callSelf(`/api/tasks/${taskId}/instructions`, { method: "GET" }, token);
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "tasks_create",
    {
      description:
        "Create a new task in a project. Only title is required. Use externalRef as an idempotency key for bulk imports — the backend dedupes on (projectId, externalRef).",
      inputSchema: {
        projectId: uuid(),
        title: z.string().min(1).max(255),
        description: z.string().optional(),
        priority: priorityEnum.optional(),
        workflowId: uuid().optional(),
        dueAt: z.string().datetime().optional(),
        externalRef: z.string().trim().min(1).max(255).optional(),
        labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      },
    },
    async ({ projectId, ...body }) => {
      try {
        const r = await callSelf(
          `/api/projects/${projectId}/tasks`,
          { method: "POST", body },
          token,
        );
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "tasks_claim",
    {
      description:
        "Claim a task as the authenticated actor. Fails if the task is already claimed, blocked, or not in a claimable state.",
      inputSchema: { taskId: uuid() },
    },
    async ({ taskId }) => {
      try {
        const r = await callSelf(
          `/api/tasks/${taskId}/claim`,
          { method: "POST" },
          token,
        );
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "tasks_release",
    {
      description:
        "Release a previously claimed task, returning it to the claimable pool.",
      inputSchema: { taskId: uuid() },
    },
    async ({ taskId }) => {
      try {
        const r = await callSelf(
          `/api/tasks/${taskId}/release`,
          { method: "POST" },
          token,
        );
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "tasks_transition",
    {
      description:
        "Transition a task to a new status. Preconditions from the task's workflow (branchPresent, prMerged, ciGreen, …) are enforced server-side. Use force=true with a forceReason only when you have explicit authorization to bypass gates.",
      inputSchema: {
        taskId: uuid(),
        status: transitionStatusEnum,
        force: z.boolean().optional(),
        forceReason: z.string().max(500).optional(),
      },
    },
    async ({ taskId, ...body }) => {
      try {
        const r = await callSelf(
          `/api/tasks/${taskId}/transition`,
          { method: "POST", body },
          token,
        );
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "tasks_update",
    {
      description:
        "Update mutable fields on a task: branchName, prUrl, prNumber, result. Pass null to clear a field.",
      inputSchema: {
        taskId: uuid(),
        branchName: z.string().max(255).nullable().optional(),
        prUrl: z.string().url().nullable().optional(),
        prNumber: z.number().int().positive().nullable().optional(),
        result: z.string().nullable().optional(),
      },
    },
    async ({ taskId, ...body }) => {
      try {
        const r = await callSelf(
          `/api/tasks/${taskId}`,
          { method: "PATCH", body },
          token,
        );
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "tasks_comment",
    {
      description:
        "Add a comment to a task. Useful for logging progress, asking human reviewers for clarification, or recording decisions.",
      inputSchema: {
        taskId: uuid(),
        content: z.string().min(1).max(5000),
      },
    },
    async ({ taskId, content }) => {
      try {
        const r = await callSelf(
          `/api/tasks/${taskId}/comments`,
          { method: "POST", body: { content } },
          token,
        );
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "signals_poll",
    {
      description:
        "Poll the signal inbox for the authenticated agent. Signals represent state changes the agent should react to (task claimed, review requested, force-transition, …).",
      inputSchema: {},
    },
    async () => {
      try {
        const r = await callSelf("/api/agent/signals", { method: "GET" }, token);
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "signals_ack",
    {
      description:
        "Acknowledge a signal by id. Acknowledged signals are removed from the inbox.",
      inputSchema: { signalId: uuid() },
    },
    async ({ signalId }) => {
      try {
        const r = await callSelf(
          `/api/agent/signals/${signalId}/ack`,
          { method: "POST" },
          token,
        );
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // ── GitHub PR delegation tools ──────────────────────────────────────
  //
  // Mirror of the three `pull_requests_*` tools registered in
  // `mcp-server/src/tools.ts`. Kept in sync by hand because the HTTP MCP
  // route cannot import the stdio package's tool table directly —
  // re-declared here with matching schemas. The test that asserts the
  // stdio package's registered tool list is the canonical check; any
  // drift between the two surfaces shows up as a missing tool on one
  // side. Back-end routes themselves (`/api/github/pull-requests*`) are
  // the single source of truth for wire-format — see
  // `backend/src/routes/github.ts`.

  server.registerTool(
    "pull_requests_create",
    {
      description:
        "Create a GitHub pull request bound to a task via delegation. The backend dispatches the create call through a team member who has connected GitHub and enabled 'Allow agents to create PRs'; on success the task's branchName, prUrl, and prNumber are patched server-side. Requires token scope tasks:update. base defaults to 'main' — pass the repo's actual default branch (e.g. 'master') explicitly if it differs.",
      inputSchema: {
        taskId: uuid(),
        owner: z.string().min(1),
        repo: z.string().min(1),
        head: z.string().min(1),
        base: z.string().min(1).optional(),
        title: z.string().min(1),
        body: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const r = await callSelf(
          "/api/github/pull-requests",
          { method: "POST", body: args },
          token,
        );
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "pull_requests_merge",
    {
      description:
        "Merge a GitHub pull request via delegation and auto-transition the linked task to 'done'. Dispatched through a team member with 'Allow agents to merge PRs' consent. Idempotent on PRs that are already merged. Requires token scope tasks:transition. mergeMethod defaults to 'squash'.",
      inputSchema: {
        taskId: uuid(),
        owner: z.string().min(1),
        repo: z.string().min(1),
        prNumber: z.number().int().positive(),
        mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
      },
    },
    async ({ prNumber, mergeMethod, ...rest }) => {
      try {
        const body: Record<string, unknown> = { ...rest };
        if (mergeMethod !== undefined) {
          // Backend field is snake_case `merge_method`; MCP tool uses
          // camelCase for wire-format consistency with the other tools.
          body.merge_method = mergeMethod;
        }
        const r = await callSelf(
          `/api/github/pull-requests/${prNumber}/merge`,
          { method: "POST", body },
          token,
        );
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "pull_requests_comment",
    {
      description:
        "Post a comment on a GitHub pull request via delegation. Dispatched through a team member with 'Allow agents to comment on PRs' consent. Requires token scope tasks:comment.",
      inputSchema: {
        taskId: uuid(),
        owner: z.string().min(1),
        repo: z.string().min(1),
        prNumber: z.number().int().positive(),
        body: z.string().min(1),
      },
    },
    async ({ prNumber, ...rest }) => {
      try {
        const r = await callSelf(
          `/api/github/pull-requests/${prNumber}/comments`,
          { method: "POST", body: rest },
          token,
        );
        return textResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}

// ── Router ──────────────────────────────────────────────────────────────────

export const mcpRouter = new Hono<{ Variables: AppVariables }>();

/**
 * POST /api/mcp — one JSON-RPC request per call, stateless.
 *
 * Assumes the outer `authMiddleware` in `app.ts` has already
 * validated the token and set `c.var.actor`. The handler re-reads
 * the raw `Authorization` header because it needs the *token
 * string* to forward to the self-dispatch, not just the validated
 * actor.
 */
mcpRouter.post("/", async (c) => {
  const auth = c.req.header("Authorization");
  const match = auth && /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) {
    // authMiddleware should have rejected this already, but guard
    // defensively in case the middleware wiring changes.
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Missing Authorization: Bearer header",
        },
        id: null,
      },
      401,
    );
  }
  const token = match[1];

  const server = buildServer(token);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  const response = await transport.handleRequest(c.req.raw);
  // The SDK returns a standard Response; hand it back to Hono as-is.
  return response;
});

// GET and DELETE are spec-compliant but meaningless in stateless
// mode (no session to resume or tear down). Reject cheaply with a
// 405 before spinning up a server.
mcpRouter.on(["GET", "DELETE"], "/", (c) => {
  c.header("Allow", "POST");
  return c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32601,
        message:
          "Method Not Allowed — /api/mcp accepts POST only (stateless Streamable HTTP)",
      },
      id: null,
    },
    405,
  );
});
