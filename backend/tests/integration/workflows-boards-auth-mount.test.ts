import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppVariables } from "../../src/types/hono.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const shared = vi.hoisted(() => ({ db: undefined as PrismaClient | undefined }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy({}, {
    get: (_target, key) => {
      if (!shared.db) throw new Error("test database not connected");
      const value = Reflect.get(shared.db, key);
      return typeof value === "function" ? value.bind(shared.db) : value;
    },
  }),
}));
const CORS_ORIGIN = "http://localhost:3000";
const SECRET = "test-secret-which-is-long-enough-1234";
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));

import { createApp } from "../../src/app.js";
import { createSessionToken } from "../../src/services/session.js";
import { defaultWorkflowDefinition } from "../../src/services/default-workflow.js";

// The real createApp() is driven end to end: the actor comes from authMiddleware
// (a session token), not from a stub, so a missing `app.use(prefix, authMiddleware)`
// mount for a router that serves /workflows/:id or /boards/:id shows up here.
let store: Awaited<ReturnType<typeof groundingPostgres>> | undefined;
let app: Hono<{ Variables: AppVariables }>;
let adminToken: string;
let memberToken: string;
let agentRawToken: string;
let projectId: string;
let workflowId: string;
let boardId: string;

beforeAll(async () => {
  store = await groundingPostgres();
  shared.db = store.db;
  app = createApp(CORS_ORIGIN);
}, 60_000);
afterAll(async () => { if (store) await store.close(); });

beforeEach(async () => {
  const db = shared.db!;
  const adminId = randomUUID();
  const memberId = randomUUID();
  const teamId = randomUUID();
  projectId = randomUUID();
  await db.user.create({ data: { id: adminId, login: `admin-${adminId}` } });
  await db.user.create({ data: { id: memberId, login: `member-${memberId}` } });
  await db.team.create({ data: { id: teamId, name: "Mount", slug: teamId } });
  await db.teamMember.create({ data: { teamId, userId: adminId, role: "ADMIN" } });
  await db.teamMember.create({ data: { teamId, userId: memberId, role: "HUMAN_MEMBER" } });
  await db.project.create({ data: { id: projectId, teamId, name: "Mount", slug: projectId } });
  workflowId = (await db.workflow.create({ data: { projectId, name: "Before", isDefault: true, definition: defaultWorkflowDefinition() as object } })).id;
  boardId = (await db.board.create({
    data: { projectId, name: "Board", config: { columns: [{ id: "a", label: "Open", status: "open" }], groupBy: "none", filters: [] } },
  })).id;
  agentRawToken = `workflows-boards-mount-agent-${randomUUID()}`;
  await db.agentToken.create({
    data: { teamId, createdById: adminId, name: "Mount agent", tokenHash: createHash("sha256").update(agentRawToken).digest("hex"), scopes: [] },
  });
  adminToken = await createSessionToken(adminId, SECRET);
  memberToken = await createSessionToken(memberId, SECRET);
});

const json = (token: string | undefined, body?: unknown, method = "GET"): RequestInit => ({
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("/api/workflows/:id and /api/boards/:id sit behind authMiddleware", () => {
  it.each([
    ["GET", "/api/workflows/", undefined],
    ["PUT", "/api/workflows/", { name: "x" }],
    ["POST", "/api/workflows/", { from: "open", to: "in_progress" }],
  ])("answers an unauthenticated %s %s:id with 401, not 500", async (method, prefix, body) => {
    const response = await app.request(`${prefix}${workflowId}${method === "POST" ? "/validate-transition" : ""}`, json(undefined, body, method));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthorized" });
  });

  it.each([
    ["GET", undefined],
    ["PUT", { name: "x" }],
  ])("answers an unauthenticated %s /api/boards/:id with 401, not 500", async (method, body) => {
    const response = await app.request(`/api/boards/${boardId}`, json(undefined, body, method));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthorized" });
  });

  it("answers a bad bearer token with 401 on the new prefixes", async () => {
    expect((await app.request(`/api/workflows/${workflowId}`, json("not-a-token"))).status).toBe(401);
    expect((await app.request(`/api/boards/${boardId}`, json("not-a-token"))).status).toBe(401);
  });

  it("keeps the static catalogs public", async () => {
    expect((await app.request("/api/workflow-rules")).status).toBe(200);
    expect((await app.request("/api/workflow-templates")).status).toBe(200);
  });

  it("lets a signed-in user read the workflow and validate a transition", async () => {
    const read = await app.request(`/api/workflows/${workflowId}`, json(memberToken));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { workflow: { id: string } }).workflow.id).toBe(workflowId);
    const validate = await app.request(`/api/workflows/${workflowId}/validate-transition`, json(memberToken, { from: "open", to: "in_progress", actorRole: "any" }, "POST"));
    expect(validate.status).toBe(200);
  });

  it("lets a project admin PUT a valid body and persists it", async () => {
    const response = await app.request(`/api/workflows/${workflowId}`, json(adminToken, { name: "After" }, "PUT"));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { workflow: { name: string } }).workflow.name).toBe("After");
    expect((await shared.db!.workflow.findUniqueOrThrow({ where: { id: workflowId } })).name).toBe("After");
  });

  it("denies a non-admin member the workflow PUT with 403 and leaves the row", async () => {
    const response = await app.request(`/api/workflows/${workflowId}`, json(memberToken, { name: "Nope" }, "PUT"));
    expect(response.status).toBe(403);
    expect((await shared.db!.workflow.findUniqueOrThrow({ where: { id: workflowId } })).name).toBe("Before");
  });

  it("answers a schema-rejected workflow PUT body with 400 and a top-level message naming the first issue", async () => {
    const response = await app.request(`/api/workflows/${workflowId}`, json(adminToken, { name: "" }, "PUT"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { success: boolean; message: string; error: { name: string; issues: { message: string; path: unknown[] }[] } };
    expect(body.success).toBe(false);
    expect(body.error.name).toBe("ZodError");
    expect(body.error.issues[0]!.path).toEqual(["name"]);
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.message).toBe(body.error.issues[0]!.message);
    expect((await shared.db!.workflow.findUniqueOrThrow({ where: { id: workflowId } })).name).toBe("Before");
  });

  it("runs authentication before body validation: an unauthenticated PUT with an invalid body answers 401, not 400", async () => {
    const response = await app.request(`/api/workflows/${workflowId}`, json(undefined, { name: "" }, "PUT"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthorized" });
  });

  it("treats an AgentToken like it is treated under /api/projects/*: reads pass, the workflow write is refused", async () => {
    expect((await app.request(`/api/workflows/${workflowId}`, json(agentRawToken))).status).toBe(200);
    expect((await app.request(`/api/boards/${boardId}`, json(agentRawToken))).status).toBe(200);
    const write = await app.request(`/api/workflows/${workflowId}`, json(agentRawToken, { name: "Agent" }, "PUT"));
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: "forbidden", message: "Agents cannot modify workflows" });
    expect((await shared.db!.workflow.findUniqueOrThrow({ where: { id: workflowId } })).name).toBe("Before");
  });

  it("answers a CORS preflight on /api/workflows/:id with 204 and the allowed origin, as on /api/projects/:id", async () => {
    const preflight = (path: string) => app.request(path, {
      method: "OPTIONS",
      headers: { origin: CORS_ORIGIN, "access-control-request-method": "PUT" },
    });
    const projectPreflight = await preflight(`/api/projects/${projectId}`);
    const workflowPreflight = await preflight(`/api/workflows/${workflowId}`);
    expect(projectPreflight.status).toBe(204);
    expect(workflowPreflight.status).toBe(204);
    expect(workflowPreflight.headers.get("access-control-allow-origin")).toBe(CORS_ORIGIN);
    expect(workflowPreflight.headers.get("access-control-allow-origin")).toBe(projectPreflight.headers.get("access-control-allow-origin"));
  });

  it("lets a signed-in user read the board and a project admin update it", async () => {
    const read = await app.request(`/api/boards/${boardId}`, json(memberToken));
    expect(read.status).toBe(200);
    const update = await app.request(`/api/boards/${boardId}`, json(adminToken, { name: "Renamed" }, "PUT"));
    expect(update.status).toBe(200);
    expect((await shared.db!.board.findUniqueOrThrow({ where: { id: boardId } })).name).toBe("Renamed");
  });
});
