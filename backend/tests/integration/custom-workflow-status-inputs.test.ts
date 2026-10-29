/**
 * DB-backed test: the API status inputs and filters accept the states of the
 * task's / project's own workflow, not a fixed list of four names.
 *
 * The workflow API still accepts only the four built-in state names, so the
 * custom definition is stored directly. It has no `open` / `in_progress` /
 * `review` / `done`: `queued` is the initial state, `working` the work state,
 * `checking` the review state and `shipped` the terminal one. A four-state
 * project next to it pins that the built-in behaviour (names, message shape)
 * is unchanged.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const shared = vi.hoisted(() => ({ db: undefined as PrismaClient | undefined }));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, key) => {
        if (!shared.db) throw new Error("test database not connected");
        const value = Reflect.get(shared.db, key);
        return typeof value === "function" ? value.bind(shared.db) : value;
      },
    },
  ),
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
  resolveTeamId: vi.fn(),
  resolveTeamIdErrorBody: vi.fn(),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);
vi.mock("../../src/services/audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/audit.js")>()),
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: vi.fn().mockResolvedValue(undefined),
  emitChangesRequestedSignal: vi.fn().mockResolvedValue(undefined),
  emitTaskApprovedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/task-signal.js", () => ({
  emitTaskAvailableSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/force-transition-signal.js", () => ({
  emitForceTransitionedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/self-merge-notice.js", () => ({
  emitSelfMergeNoticeIfApplicable: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../src/services/grounding-client.js", () => ({
  getGroundingClient: () => ({
    start: vi.fn().mockResolvedValue(null),
    getLedgerSummary: vi.fn().mockResolvedValue({ entryCount: 0 }),
  }),
  RealGroundingClient: class {},
  NullGroundingClient: class {},
  __resetGroundingClientCacheForTests: () => {},
}));

import { taskRouter } from "../../src/routes/tasks.js";
import { mcpRouter, setApp } from "../../src/routes/mcp.js";
import { emitTaskAvailableSignal } from "../../src/services/task-signal.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let userId: string;
let agentTokenId: string;
let human: Actor;
let agent: Actor;

const customDefinition = {
  initialState: "queued",
  states: [
    { name: "queued", label: "Queued", terminal: false },
    { name: "working", label: "Working", terminal: false },
    { name: "checking", label: "Checking", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "queued", to: "working" },
    { from: "working", to: "checking" },
    { from: "checking", to: "shipped" },
    { from: "checking", to: "working" },
  ],
};
// A second vocabulary, used as a pinned (non-default) workflow.
const pinnedDefinition = {
  initialState: "todo",
  states: [
    { name: "todo", label: "Todo", terminal: false },
    { name: "doing", label: "Doing", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "released", label: "Released", terminal: true },
  ],
  transitions: [
    { from: "todo", to: "doing" },
    { from: "doing", to: "qa" },
    { from: "qa", to: "released" },
  ],
};
const BUILTIN_CREATE_MESSAGE = 'Invalid option: expected one of "backlog"|"open"|"in_progress"|"review"|"done"';

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  app.route("/api", taskRouter);
  app.route("/api/mcp", mcpRouter);
  setApp(app);
  return app;
}

async function call(actor: Actor, method: string, path: string, body?: unknown) {
  const res = await makeApp(actor).request(`/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  const res = await makeApp(human).request("/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
  const message = JSON.parse(dataLine ? dataLine.slice(6) : raw);
  const text = message.result?.content?.[0]?.text as string | undefined;
  return { isError: message.result?.isError === true, text: text ?? "", message };
}

async function seedProject(opts: { custom: boolean }) {
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "P", slug: randomUUID() } });
  if (opts.custom) {
    await db.workflow.create({ data: { projectId, name: "custom", isDefault: true, definition: customDefinition } });
  }
  return projectId;
}
async function seedTask(projectId: string, status: string, extra: Record<string, unknown> = {}) {
  return db.task.create({
    data: { projectId, title: `Task ${randomUUID().slice(0, 8)}`, description: "Seeded.", status, createdByUserId: userId, ...extra },
  });
}

beforeAll(async () => {
  store = await groundingPostgres();
  db = store.db;
  shared.db = db;
}, 60000);

afterAll(async () => {
  if (store) await store.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);

  userId = randomUUID();
  await db.user.create({ data: { id: userId, login: `u-${userId}` } });
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Inputs", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  accessMocks.resolveTeamId.mockResolvedValue({ ok: true, teamId });
  const scopes = ["tasks:read", "tasks:claim", "tasks:transition", "tasks:update", "tasks:create"];
  agentTokenId = randomUUID();
  await db.agentToken.create({
    data: { id: agentTokenId, teamId, createdById: userId, name: "author", tokenHash: randomUUID(), scopes },
  });
  human = { type: "human", userId, teamId, role: "ADMIN" };
  agent = { type: "agent", tokenId: agentTokenId, teamId, userId, scopes };
});

describe("POST /projects/:id/tasks status", () => {
  it("accepts a state of the project's custom workflow and writes it", async () => {
    const projectId = await seedProject({ custom: true });
    const { status, body } = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: "working" });
    expect(status).toBe(201);
    expect(body.task.status).toBe("working");
  });

  it("rejects a built-in name the custom workflow lacks, an unknown name and abandoned with a 400 in the validation shape", async () => {
    const projectId = await seedProject({ custom: true });
    for (const bad of ["in_progress", "open", "bogus", "abandoned"]) {
      const { status, body } = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: bad });
      expect(status, bad).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.name).toBe("ZodError");
      expect(body.error.issues[0]).toMatchObject({ path: ["status"], message: 'Invalid option: expected one of "backlog"|"queued"|"working"|"checking"|"shipped"' });
    }
    expect(await db.task.count({ where: { projectId } })).toBe(0);
  });

  it("accepts backlog for every workflow", async () => {
    const projectId = await seedProject({ custom: true });
    const { status, body } = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: "backlog" });
    expect(status).toBe(201);
    expect(body.task.status).toBe("backlog");
  });

  it("keeps the built-in names, order and message for a four-state project", async () => {
    const projectId = await seedProject({ custom: false });
    for (const ok of ["backlog", "open", "in_progress", "review", "done"]) {
      expect((await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: ok })).status, ok).toBe(201);
    }
    for (const bad of ["bogus", "abandoned", "queued"]) {
      const { status, body } = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: bad });
      expect(status, bad).toBe(400);
      expect(body.error.issues[0]).toMatchObject({ path: ["status"], message: BUILTIN_CREATE_MESSAGE });
    }
  });

  it("judges the status on the pinned workflow when workflowId is given, not on the project default", async () => {
    const projectId = await seedProject({ custom: false });
    const pinned = await db.workflow.create({ data: { projectId, name: "pinned", isDefault: false, definition: pinnedDefinition } });
    const ok = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: "qa", workflowId: pinned.id });
    expect(ok.status).toBe(201);
    expect(ok.body.task.status).toBe("qa");
    const bad = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: "open", workflowId: pinned.id });
    expect(bad.status).toBe(400);
    const defaultOnly = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: "qa" });
    expect(defaultOnly.status).toBe(400);
  });

  it("answers an unknown status with the validation 400 for an agent too, before the backlog routing rule", async () => {
    const projectId = await seedProject({ custom: true });
    const unknown = await call(agent, "POST", `/projects/${projectId}/tasks`, { title: "T", status: "bogus" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error?.name).toBe("ZodError");
    const known = await call(agent, "POST", `/projects/${projectId}/tasks`, { title: "T", status: "working" });
    expect(known.status).toBe(400);
    expect(known.body.error).toBe("backlog_routing_enforced");
  });
});

describe("POST /projects/:id/tasks/import status", () => {
  it("accepts custom states and refuses the whole batch for one unknown name", async () => {
    const projectId = await seedProject({ custom: true });
    const ok = await call(human, "POST", `/projects/${projectId}/tasks/import`, { tasks: [{ title: "A", status: "working" }, { title: "B", status: "backlog" }] });
    expect(ok.status).toBe(201);
    expect(ok.body.created).toBe(2);
    expect((await db.task.findMany({ where: { projectId }, orderBy: { title: "asc" } })).map((t) => t.status)).toEqual(["working", "backlog"]);

    const bad = await call(human, "POST", `/projects/${projectId}/tasks/import`, { tasks: [{ title: "C", status: "checking" }, { title: "D", status: "bogus" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.issues[0]).toMatchObject({ path: ["tasks", 1, "status"] });
    expect(await db.task.count({ where: { projectId } })).toBe(2);
  });
});

describe("initial status of a created or imported task", () => {
  const signalCalls = () => (emitTaskAvailableSignal as any).mock.calls as [string, string, string, string][];

  // Case 1: no status input, no stored workflow -> the built-in initial
  // state `open`, and task_available fires for it.
  it("no status, four-state project default: open, signal emitted", async () => {
    const projectId = await seedProject({ custom: false });
    const { status, body } = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T" });
    expect(status).toBe(201);
    expect(body.task.status).toBe("open");
    expect(signalCalls()).toEqual([[body.task.id, projectId, "human", "Human"]]);
  });

  // Case 2: no status input, task pinned to a stored workflow whose initial
  // state is a custom name -> that name, and the signal fires for it. The
  // project default here is the built-in workflow, so `open` (not a state of
  // the pinned definition) proves which workflow was consulted.
  it("no status, pinned workflow: its initialState, signal emitted", async () => {
    const projectId = await seedProject({ custom: false });
    const pinned = await db.workflow.create({ data: { projectId, name: "pinned", isDefault: false, definition: pinnedDefinition } });
    const { status, body } = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", workflowId: pinned.id });
    expect(status).toBe(201);
    expect(body.task.status).toBe("todo");
    expect(signalCalls()).toEqual([[body.task.id, projectId, "human", "Human"]]);
  });

  // Case 3: no status input, no pin -> the project default stored definition's
  // initial state, not the literal `open`.
  it("no status, custom project default definition: its initialState, signal emitted", async () => {
    const projectId = await seedProject({ custom: true });
    const { status, body } = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T" });
    expect(status).toBe(201);
    expect(body.task.status).toBe("queued");
    expect(signalCalls()).toEqual([[body.task.id, projectId, "human", "Human"]]);
  });

  // Case 4: both pins set and they differ -> the task's pinned workflow wins
  // over the project default (`todo`, not `queued`).
  it("no status, pinned workflow and a differing project default: the pin wins", async () => {
    const projectId = await seedProject({ custom: true });
    const pinned = await db.workflow.create({ data: { projectId, name: "pinned", isDefault: false, definition: pinnedDefinition } });
    const { status, body } = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", workflowId: pinned.id });
    expect(status).toBe(201);
    expect(body.task.status).toBe("todo");
    expect(signalCalls()).toEqual([[body.task.id, projectId, "human", "Human"]]);
  });

  // Case 5: an explicit status is the caller's, and the signal follows it:
  // emitted only when that status is the initial state.
  it("explicit status wins over the initial state; signal only when it equals it", async () => {
    const projectId = await seedProject({ custom: true });
    const nonInitial = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "A", status: "working" });
    expect(nonInitial.status).toBe(201);
    expect(nonInitial.body.task.status).toBe("working");
    expect(signalCalls()).toEqual([]);
    const initial = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "B", status: "queued" });
    expect(initial.status).toBe(201);
    expect(initial.body.task.status).toBe("queued");
    expect(signalCalls()).toEqual([[initial.body.task.id, projectId, "human", "Human"]]);
    const draft = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "C", status: "backlog" });
    expect(draft.body.task.status).toBe("backlog");
    expect(signalCalls()).toHaveLength(1);
  });

  // Case 6: the batch path has no per-item workflow pin, so the project
  // default decides; rows without a status get its initial state, rows with a
  // status keep theirs, and the signal fires only for the initial state.
  it("batch import: rows without status use the initial state, rows with status keep theirs", async () => {
    const projectId = await seedProject({ custom: true });
    const { status, body } = await call(human, "POST", `/projects/${projectId}/tasks/import`, {
      tasks: [{ title: "A" }, { title: "B", status: "working" }, { title: "C", status: "backlog" }, { title: "D", status: "queued" }],
    });
    expect(status).toBe(201);
    expect(body.created).toBe(4);
    const rows = await db.task.findMany({ where: { projectId }, orderBy: { title: "asc" } });
    expect(rows.map((t) => t.status)).toEqual(["queued", "working", "backlog", "queued"]);
    expect(signalCalls().map(([taskId]) => taskId).sort()).toEqual([rows[0]!.id, rows[3]!.id].sort());
    const plain = await seedProject({ custom: false });
    const plainRes = await call(human, "POST", `/projects/${plain}/tasks/import`, { tasks: [{ title: "E" }, { title: "F", status: "review" }] });
    expect(plainRes.status).toBe(201);
    expect((await db.task.findMany({ where: { projectId: plain }, orderBy: { title: "asc" } })).map((t) => t.status)).toEqual(["open", "review"]);
    expect(signalCalls()).toHaveLength(3);
  });

  // Case 7: an agent token is hard-routed to `backlog` whatever the workflow's
  // initial state is, on create and on import, and a backlog task is not
  // claimable, so neither path emits task_available.
  it("agent create and agent import in a custom-workflow project: backlog, no signal", async () => {
    const projectId = await seedProject({ custom: true });
    const created = await call(agent, "POST", `/projects/${projectId}/tasks`, { title: "A" });
    expect(created.status).toBe(201);
    expect(created.body.task.status).toBe("backlog");
    expect(signalCalls()).toEqual([]);
    const imported = await call(agent, "POST", `/projects/${projectId}/tasks/import`, { tasks: [{ title: "B" }, { title: "C" }] });
    expect(imported.status).toBe(201);
    expect(imported.body.created).toBe(2);
    expect((await db.task.findMany({ where: { projectId }, orderBy: { title: "asc" } })).map((t) => t.status)).toEqual(["backlog", "backlog", "backlog"]);
    expect(signalCalls()).toEqual([]);
  });
});

describe("PATCH /tasks/:id status", () => {
  it("moves a task along the custom workflow's edge", async () => {
    const projectId = await seedProject({ custom: true });
    const task = await seedTask(projectId, "working");
    const { status, body } = await call(human, "PATCH", `/tasks/${task.id}`, { status: "checking" });
    expect(status).toBe(200);
    expect(body.task.status).toBe("checking");
  });

  it("rejects an unknown name and a built-in name the workflow lacks with the existing 400 body", async () => {
    const projectId = await seedProject({ custom: true });
    const task = await seedTask(projectId, "working");
    for (const bad of ["bogus", "in_progress", "done"]) {
      const { status, body } = await call(human, "PATCH", `/tasks/${task.id}`, { status: bad });
      expect(status, bad).toBe(400);
      expect(body).toMatchObject({ error: "bad_request", message: "Validation failed" });
      expect(body.details.fieldErrors.status[0]).toBe('Invalid option: expected one of "backlog"|"queued"|"working"|"checking"|"shipped"|"abandoned"');
    }
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("working");
  });

  it("checks the status against the pinned workflow of the task", async () => {
    const projectId = await seedProject({ custom: true });
    const pinned = await db.workflow.create({ data: { projectId, name: "pinned", isDefault: false, definition: pinnedDefinition } });
    const task = await seedTask(projectId, "doing", { workflowId: pinned.id });
    const ok = await call(human, "PATCH", `/tasks/${task.id}`, { status: "qa" });
    expect(ok.status).toBe(200);
    expect(ok.body.task.status).toBe("qa");
    const bad = await call(human, "PATCH", `/tasks/${task.id}`, { status: "checking" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe("Validation failed");
  });

  it("still lets a no-op echo of the current status through, and keeps the backlog demote and discard moves", async () => {
    const projectId = await seedProject({ custom: true });
    const task = await seedTask(projectId, "working");
    expect((await call(human, "PATCH", `/tasks/${task.id}`, { status: "working", title: "Renamed" })).status).toBe(200);
    // A status the workflow no longer has (a task left over from before a
    // workflow switch) can still be echoed back: nothing changes, nothing is checked.
    const stale = await seedTask(projectId, "in_progress");
    const echo = await call(human, "PATCH", `/tasks/${stale.id}`, { status: "in_progress", title: "Stale" });
    expect(echo.status).toBe(200);
    expect(echo.body.task).toMatchObject({ status: "in_progress", title: "Stale" });
    // "abandoned" is a valid name, but only the backlog discard may write it.
    const abandoned = await call(human, "PATCH", `/tasks/${task.id}`, { status: "abandoned" });
    expect(abandoned.status).toBe(400);
    expect(abandoned.body.error).toBe("bad_request");
    expect(abandoned.body.message).not.toBe("Validation failed");
    const draft = await seedTask(projectId, "backlog");
    const discarded = await call(human, "PATCH", `/tasks/${draft.id}`, { status: "abandoned" });
    expect(discarded.status).toBe(200);
    expect(discarded.body.task.status).toBe("abandoned");
  });

  it("keeps the four-state behaviour: the old names, the old message", async () => {
    const projectId = await seedProject({ custom: false });
    const task = await seedTask(projectId, "open");
    const bad = await call(human, "PATCH", `/tasks/${task.id}`, { status: "bogus" });
    expect(bad.status).toBe(400);
    expect(bad.body.details.fieldErrors.status[0]).toBe('Invalid option: expected one of "backlog"|"open"|"in_progress"|"review"|"done"|"abandoned"');
    expect((await call(human, "PATCH", `/tasks/${task.id}`, { status: "in_progress" })).status).toBe(200);
  });
});

describe("tasks_transition (MCP) status", () => {
  it("transitions a task to a state of its custom workflow", async () => {
    const projectId = await seedProject({ custom: true });
    const task = await seedTask(projectId, "working");
    const result = await mcpCall("tasks_transition", { taskId: task.id, status: "checking" });
    expect(result.isError).toBe(false);
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("checking");
  });

  it("refuses an unknown state with the backend's 400 and leaves the task alone", async () => {
    const projectId = await seedProject({ custom: true });
    const task = await seedTask(projectId, "working");
    const result = await mcpCall("tasks_transition", { taskId: task.id, status: "bogus" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("400");
    expect(result.text).toContain("not allowed by workflow");
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("working");
  });
});

describe("status filters", () => {
  it("GET /projects/:id/tasks accepts the project's workflow states and rejects the others", async () => {
    const projectId = await seedProject({ custom: true });
    const checking = await seedTask(projectId, "checking");
    await seedTask(projectId, "working");
    const ok = await call(human, "GET", `/projects/${projectId}/tasks?status=checking`);
    expect(ok.status).toBe(200);
    expect(ok.body.tasks.map((t: any) => t.id)).toEqual([checking.id]);
    expect((await call(human, "GET", `/projects/${projectId}/tasks?status=checking,backlog,abandoned`)).status).toBe(200);
    for (const bad of ["bogus", "in_progress"]) {
      const res = await call(human, "GET", `/projects/${projectId}/tasks?status=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body).toEqual({
        error: "bad_request",
        message: `Invalid status '${bad}'. Expected one of: backlog, queued, working, checking, shipped, abandoned`,
      });
    }
  });

  it("GET /projects/:id/tasks keeps the four-state list for a project without a stored workflow", async () => {
    const projectId = await seedProject({ custom: false });
    const res = await call(human, "GET", `/projects/${projectId}/tasks?status=bogus`);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid status 'bogus'. Expected one of: backlog, open, in_progress, review, done, abandoned");
    expect((await call(human, "GET", `/projects/${projectId}/tasks?status=in_progress`)).status).toBe(200);
  });

  it("GET /projects/:id/tasks accepts a state of a pinned workflow of the project", async () => {
    const projectId = await seedProject({ custom: true });
    const pinned = await db.workflow.create({ data: { projectId, name: "pinned", isDefault: false, definition: pinnedDefinition } });
    const task = await seedTask(projectId, "qa", { workflowId: pinned.id });
    const res = await call(human, "GET", `/projects/${projectId}/tasks?status=qa`);
    expect(res.status).toBe(200);
    expect(res.body.tasks.map((t: any) => t.id)).toEqual([task.id]);
  });

  it("GET /tasks/claimable with a projectId accepts the project's states and rejects the others", async () => {
    const projectId = await seedProject({ custom: true });
    const task = await seedTask(projectId, "checking");
    const ok = await call(human, "GET", `/tasks/claimable?projectId=${projectId}&status=checking`);
    expect(ok.status).toBe(200);
    expect(ok.body.tasks.map((t: any) => t.id)).toEqual([task.id]);
    const bad = await call(human, "GET", `/tasks/claimable?projectId=${projectId}&status=in_progress`);
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({
      error: "bad_request",
      message: "invalid status: in_progress; must be one of backlog, queued, working, checking, shipped, abandoned",
    });
  });

  it("GET /tasks/claimable at team scope accepts the built-in states and every workflow state of the team", async () => {
    await seedProject({ custom: true });
    expect((await call(human, "GET", `/tasks/claimable?status=checking`)).status).toBe(200);
    expect((await call(human, "GET", `/tasks/claimable?status=in_progress`)).status).toBe(200);
    const bad = await call(human, "GET", `/tasks/claimable?status=bogus`);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe("invalid status: bogus; must be one of backlog, open, in_progress, review, done, queued, working, checking, shipped, abandoned");
  });

  it("does not disclose the workflow vocabulary to a caller without access to the project", async () => {
    const projectId = await seedProject({ custom: true });
    accessMocks.hasProjectAccess.mockResolvedValue(false);
    const browse = await call(human, "GET", `/projects/${projectId}/tasks?status=bogus`);
    expect(browse.status).toBe(403);
    const claimable = await call(human, "GET", `/tasks/claimable?projectId=${projectId}&status=bogus`);
    expect(claimable.status).toBe(403);
  });

  it("tasks_list (MCP) passes a custom state through to the claimable search", async () => {
    const projectId = await seedProject({ custom: true });
    const task = await seedTask(projectId, "checking");
    const result = await mcpCall("tasks_list", { projectId, status: "checking" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).tasks.map((t: any) => t.id)).toEqual([task.id]);
    const bad = await mcpCall("tasks_list", { projectId, status: "bogus" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("400");
  });
});

describe("GET /teams/:teamId/tasks priority count", () => {
  it("counts a HIGH task in a custom work or review state, not one in the custom terminal state, backlog or abandoned", async () => {
    const projectId = await seedProject({ custom: true });
    for (const status of ["queued", "working", "checking"]) await seedTask(projectId, status, { priority: "HIGH" });
    for (const status of ["shipped", "backlog", "abandoned"]) await seedTask(projectId, status, { priority: "CRITICAL" });
    await seedTask(projectId, "working", { priority: "LOW" });
    const { status, body } = await call(human, "GET", `/teams/${teamId}/tasks`);
    expect(status).toBe(200);
    expect(body.counts.priority).toBe(3);
  });

  it("counts a task in the built-in terminal state `done` of a four-state project as not actionable, and the others as actionable", async () => {
    const projectId = await seedProject({ custom: false });
    for (const status of ["open", "in_progress", "review"]) await seedTask(projectId, status, { priority: "CRITICAL" });
    for (const status of ["done", "backlog", "abandoned"]) await seedTask(projectId, status, { priority: "CRITICAL" });
    const { body } = await call(human, "GET", `/teams/${teamId}/tasks`);
    expect(body.counts.priority).toBe(3);
  });
});

describe("status values that are empty, over-long or not a string", () => {
  const odd: [string, unknown][] = [["empty", ""], ["over-long", "x".repeat(101)], ["a number", 7], ["null", null]];

  it.each(odd)("create answers a %s status with the old invalid_value issue", async (_label, value) => {
    const projectId = await seedProject({ custom: false });
    const { status, body } = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: value });
    expect(status).toBe(400);
    expect(body.error.issues).toHaveLength(1);
    expect(body.error.issues[0]).toMatchObject({ code: "invalid_value", path: ["status"], message: BUILTIN_CREATE_MESSAGE });
    expect(await db.task.count({ where: { projectId } })).toBe(0);
  });

  it.each(odd)("import answers a %s status with the old invalid_value issue on tasks.<index>.status", async (_label, value) => {
    const projectId = await seedProject({ custom: false });
    const { status, body } = await call(human, "POST", `/projects/${projectId}/tasks/import`, { tasks: [{ title: "A" }, { title: "B", status: value }] });
    expect(status).toBe(400);
    expect(body.error.issues[0]).toMatchObject({ code: "invalid_value", path: ["tasks", 1, "status"], message: BUILTIN_CREATE_MESSAGE });
    expect(await db.task.count({ where: { projectId } })).toBe(0);
  });

  it.each(odd.filter(([label]) => label !== "null"))("PATCH answers a %s status with the old invalid_value message", async (_label, value) => {
    const projectId = await seedProject({ custom: false });
    const task = await seedTask(projectId, "open");
    const { status, body } = await call(human, "PATCH", `/tasks/${task.id}`, { status: value });
    expect(status).toBe(400);
    expect(body.details.fieldErrors.status).toEqual(['Invalid option: expected one of "backlog"|"open"|"in_progress"|"review"|"done"|"abandoned"']);
  });
});

describe("the order of the accepted names for a stored four-state definition", () => {
  // The same four names as the built-in workflow, stored in another order.
  const reordered = {
    initialState: "open",
    states: [
      { name: "done", label: "Done", terminal: true },
      { name: "review", label: "Review", terminal: false },
      { name: "in_progress", label: "In progress", terminal: false },
      { name: "open", label: "Open", terminal: false },
    ],
    transitions: [{ from: "open", to: "in_progress" }, { from: "in_progress", to: "review" }, { from: "review", to: "done" }],
  };

  it("lists them in the canonical order in the create, PATCH and filter messages", async () => {
    const projectId = await seedProject({ custom: false });
    await db.workflow.create({ data: { projectId, name: "reordered", isDefault: true, definition: reordered } });
    const create = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: "bogus" });
    expect(create.body.error.issues[0].message).toBe(BUILTIN_CREATE_MESSAGE);
    const task = await seedTask(projectId, "open");
    const patch = await call(human, "PATCH", `/tasks/${task.id}`, { status: "bogus" });
    expect(patch.body.details.fieldErrors.status[0]).toBe('Invalid option: expected one of "backlog"|"open"|"in_progress"|"review"|"done"|"abandoned"');
    const filter = await call(human, "GET", `/projects/${projectId}/tasks?status=bogus`);
    expect(filter.body.message).toBe("Invalid status 'bogus'. Expected one of: backlog, open, in_progress, review, done, abandoned");
  });

  it("keeps the stored order when the names are not the built-in set", async () => {
    const projectId = await seedProject({ custom: true });
    const create = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: "bogus" });
    expect(create.body.error.issues[0].message).toBe('Invalid option: expected one of "backlog"|"queued"|"working"|"checking"|"shipped"');
  });
});

describe("a caller who may not write to the project and sends an unknown status", () => {
  // The access answer comes before any judgement of the status, so a caller
  // without access learns nothing about the project's workflow vocabulary.
  it.each([["no access", () => accessMocks.hasProjectAccess.mockResolvedValue(false)], ["read-only role", () => accessMocks.requireProjectWrite.mockResolvedValue(false)]] as const)("create and import answer 403 for %s", async (_label, deny) => {
    const projectId = await seedProject({ custom: true });
    deny();
    const create = await call(human, "POST", `/projects/${projectId}/tasks`, { title: "T", status: "bogus" });
    expect(create.status).toBe(403);
    const imported = await call(human, "POST", `/projects/${projectId}/tasks/import`, { tasks: [{ title: "T", status: "bogus" }] });
    expect(imported.status).toBe(403);
    expect(await db.task.count({ where: { projectId } })).toBe(0);
  });
});
