/**
 * POST /projects/:projectId/workflow/apply-template/:slug refuses with 409 when
 * the change strands a task: a task in a non-terminal state of the workflow it
 * follows that the template lacks, because applying a template moves no task.
 * Backlog and abandoned live outside every workflow and never count; a task
 * pinned to another workflow keeps that workflow and does not count; a repeated
 * apply of an identical definition changes nothing and is not checked. A task
 * in a terminal state of the workflow it follows is finished work that cannot
 * be moved, and a task on a status that workflow does not have is already
 * outside it; the change does nothing to either, so neither blocks and the 2xx
 * response lists them (`terminalOutsideWorkflow`, `outsideWorkflow`).
 *
 * Against the registered templates (they share the four built-in names) the
 * guard only fires for a project whose tasks sit on other names.
 *
 * The same check guards the other routes that replace the workflow a group of
 * tasks follows: reset (DELETE /projects/:id/workflow), PUT /workflows/:id and
 * POST /projects/:id/workflows with isDefault true.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppVariables } from "../../src/types/hono.js";

const harness = vi.hoisted(() => ({ current: null as (() => PrismaClient) | null }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy({}, {
    get: (_target, property) => {
      const db = harness.current!();
      const value = Reflect.get(db, property);
      return typeof value === "function" ? value.bind(db) : value;
    },
  }),
}));

import { workflowRouter } from "../../src/routes/workflows.js";
import { WORKFLOW_TEMPLATES } from "../../src/services/workflow-templates.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const requestDb = new AsyncLocalStorage<PrismaClient>();
let store: Awaited<ReturnType<typeof groundingPostgres>>;
let projectId: string;
let teamId: string;
let adminId: string;
harness.current = () => requestDb.getStore() ?? store.db;

function apply(slug: string) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", { type: "human", userId: adminId });
    await requestDb.run(store.db, next);
  });
  app.route("/", workflowRouter);
  return app.request(`/projects/${projectId}/workflow/apply-template/${slug}`, { method: "POST" });
}

const seedTask = (status: string, overrides: Record<string, unknown> = {}) =>
  store.db.task.create({
    data: { projectId, title: `T-${status}`, status, createdByUserId: adminId, ...overrides },
  });

const QA_DEFINITION = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [{ from: "open", to: "qa" }, { from: "qa", to: "shipped" }],
};

const rowCount = () => store.db.workflow.count({ where: { projectId } });

beforeAll(async () => { store = await groundingPostgres(); }, 60_000);
afterAll(async () => { await store?.close(); });
beforeEach(async () => {
  adminId = randomUUID();
  teamId = randomUUID();
  projectId = randomUUID();
  await store.db.user.create({ data: { id: adminId, login: `admin-${adminId}` } });
  await store.db.team.create({ data: { id: teamId, name: "Team", slug: `team-${teamId}` } });
  await store.db.teamMember.create({ data: { teamId, userId: adminId, role: "ADMIN" } });
  await store.db.project.create({ data: { id: projectId, teamId, name: "P", slug: `project-${projectId}` } });
});

describe("apply-template guard", () => {
  it("answers 409 naming the stranded tasks, and writes no workflow row", async () => {
    await store.db.workflow.create({ data: { projectId, name: "QA", isDefault: true, definition: QA_DEFINITION as never } });
    const stranded = await seedTask("qa");
    await seedTask("open");
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string; taskIds: string[]; truncated: boolean };
    expect(body).toMatchObject({ error: "stranded_tasks", taskIds: [stranded.id], truncated: false });
    expect(body.message).toContain("branch-pr-merge-gated");
    // The existing row is untouched.
    const row = await store.db.workflow.findFirstOrThrow({ where: { projectId } });
    expect(row.name).toBe("QA");
    expect(row.definition).toEqual(QA_DEFINITION);
    expect(await rowCount()).toBe(1);
  });

  it("a project without any workflow row: a task on a legacy status is listed in outsideWorkflow, not refused", async () => {
    // The registered templates keep the four built-in names, so a built-in state is never dropped here
    // (the stranding case over the built-in default runs through POST isDefault); a legacy status is only listed.
    const unknown = await seedTask("weird_status");
    const res = await apply("release-ops-no-pr");
    expect(res.status).toBe(201);
    expect(((await res.json()) as OutsideReport).outsideWorkflow).toEqual([{ id: unknown.id, status: "weird_status" }]);
    expect(await rowCount()).toBe(1);
  });

  it.each(WORKFLOW_TEMPLATES.map((t) => t.slug))(
    "%s applies (201) over tasks on every built-in status plus backlog and abandoned",
    async (slug) => {
      for (const status of ["open", "in_progress", "review", "done", "backlog", "abandoned"]) await seedTask(status);
      const res = await apply(slug);
      expect(res.status).toBe(201);
      expect(await rowCount()).toBe(1);
    },
  );

  it("a project with no tasks applies (201)", async () => {
    expect((await apply("branch-pr-merge-gated")).status).toBe(201);
  });

  it("a task pinned to another workflow does not block the apply", async () => {
    const other = await store.db.workflow.create({ data: { projectId, name: "Other", isDefault: false, definition: QA_DEFINITION as never } });
    await seedTask("qa", { workflowId: other.id });
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(201);
  });

  it("a task pinned to the replaced default row counts", async () => {
    const existing = await store.db.workflow.create({ data: { projectId, name: "QA", isDefault: true, definition: QA_DEFINITION as never } });
    const stranded = await seedTask("qa", { workflowId: existing.id });
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { taskIds: string[] }).taskIds).toEqual([stranded.id]);
  });

  it("applies once the stranded task has moved to a state of the template", async () => {
    await store.db.workflow.create({ data: { projectId, name: "QA", isDefault: true, definition: QA_DEFINITION as never } });
    const task = await seedTask("qa");
    expect((await apply("branch-pr-merge-gated")).status).toBe(409);
    await store.db.task.update({ where: { id: task.id }, data: { status: "review" } });
    expect((await apply("branch-pr-merge-gated")).status).toBe(201);
  });

  it("re-applying an identical definition is not checked: nothing changes, so nothing is stranded", async () => {
    expect((await apply("branch-pr-merge-gated")).status).toBe(201);
    await seedTask("weird_status");
    expect((await apply("branch-pr-merge-gated")).status).toBe(201);
  });

  it("names at most 50 task ids and says the list is cut", async () => {
    await store.db.workflow.create({ data: { projectId, name: "QA", isDefault: true, definition: QA_DEFINITION as never } });
    await store.db.task.createMany({
      data: Array.from({ length: 52 }, (_, i) => ({ projectId, title: `S${i}`, status: "qa", createdByUserId: adminId })),
    });
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { taskIds: string[]; truncated: boolean; message: string };
    expect(body.taskIds).toHaveLength(50);
    expect(body.truncated).toBe(true);
    expect(body.message).toContain("more than 50");
  });
});

// ── The shared check on the terminal exclusion and the other three routes ────

function call(method: string, path: string, body?: unknown) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", { type: "human", userId: adminId });
    await requestDb.run(store.db, next);
  });
  app.route("/", workflowRouter);
  return app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

const reset = () => call("DELETE", `/projects/${projectId}/workflow`);
const createWorkflow = (body: Record<string, unknown>) => call("POST", `/projects/${projectId}/workflows`, body);
const updateWorkflow = (id: string, body: Record<string, unknown>) => call("PUT", `/workflows/${id}`, body);

// open -> shipped only: no "qa", terminal "shipped".
const SHIPPED_ONLY = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [{ from: "open", to: "shipped" }],
};
// Keeps "qa" and "shipped", adds "released".
const QA_AND_MORE = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
    { name: "released", label: "Released", terminal: true },
  ],
  transitions: [{ from: "open", to: "qa" }, { from: "qa", to: "shipped" }, { from: "shipped", to: "released" }],
};

const defaultRow = (definition: unknown = QA_DEFINITION, isDefault = true) =>
  store.db.workflow.create({ data: { projectId, name: "QA", isDefault, definition: definition as never } });
const statusOf = async (id: string) => (await store.db.task.findUniqueOrThrow({ where: { id } })).status;

type Conflict = { error: string; message: string; taskIds: string[]; truncated: boolean };
type OutsideReport = { outsideWorkflow: { id: string; status: string }[]; outsideTruncated: boolean };
type TerminalReport = { terminalOutsideWorkflow: { id: string; status: string }[]; terminalOutsideTruncated: boolean };

describe("terminal tasks do not block the guard", () => {
  it("apply-template: a task in a custom terminal state does not block, keeps its status and is reported", async () => {
    await defaultRow();
    const shipped = await seedTask("shipped");
    await seedTask("open");
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(201);
    const body = (await res.json()) as TerminalReport;
    expect(body.terminalOutsideWorkflow).toEqual([{ id: shipped.id, status: "shipped" }]);
    expect(body.terminalOutsideTruncated).toBe(false);
    expect(await statusOf(shipped.id)).toBe("shipped");
    expect((await store.db.workflow.findFirstOrThrow({ where: { projectId } })).name).toBe("Branch, PR & Merge Gated");
  });

  it("apply-template: a terminal task does not hide a non-terminal stranded one, and only the latter is named", async () => {
    await defaultRow();
    await seedTask("shipped");
    const stranded = await seedTask("qa");
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(409);
    const body = (await res.json()) as Conflict;
    expect(body.taskIds).toEqual([stranded.id]);
    expect(body.message).toContain("terminal state");
  });

  it("apply-template: a terminal task pinned to the replaced default row is excluded too", async () => {
    const existing = await defaultRow();
    const shipped = await seedTask("shipped", { workflowId: existing.id });
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(201);
    expect(((await res.json()) as TerminalReport).terminalOutsideWorkflow).toEqual([{ id: shipped.id, status: "shipped" }]);
  });

  it("apply-template: a terminal state the template also has is neither reported nor a problem", async () => {
    for (const status of ["open", "done"]) await seedTask(status);
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(201);
    expect(((await res.json()) as TerminalReport).terminalOutsideWorkflow).toEqual([]);
  });

  it("apply-template: a status the followed workflow does not have is already outside it: it does not block and is listed", async () => {
    await defaultRow();
    const legacy = await seedTask("released");
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(201);
    const body = (await res.json()) as OutsideReport & TerminalReport;
    expect(body.outsideWorkflow).toEqual([{ id: legacy.id, status: "released" }]);
    expect(body.outsideTruncated).toBe(false);
    expect(body.terminalOutsideWorkflow).toEqual([]);
    expect(await statusOf(legacy.id)).toBe("released");
  });

  it("apply-template: the outside list names at most 50 tasks and says it is cut", async () => {
    await defaultRow();
    await store.db.task.createMany({
      data: Array.from({ length: 52 }, (_, i) => ({ projectId, title: `L${i}`, status: "legacy", createdByUserId: adminId })),
    });
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(201);
    const body = (await res.json()) as OutsideReport;
    expect(body.outsideWorkflow).toHaveLength(50);
    expect(body.outsideTruncated).toBe(true);
  });

  it("a task a change left outside does not block the later changes of that workflow (apply, PUT, apply, reset)", async () => {
    await defaultRow();
    const shipped = await seedTask("shipped");
    const first = await apply("branch-pr-merge-gated");
    expect(first.status).toBe(201);
    expect(((await first.json()) as TerminalReport).terminalOutsideWorkflow).toEqual([{ id: shipped.id, status: "shipped" }]);
    // "shipped" is now a status of no state of the workflow the task follows.
    const row = await store.db.workflow.findFirstOrThrow({ where: { projectId, isDefault: true } });
    const def = row.definition as { states: unknown[] };
    const added = { ...def, states: [...def.states, { name: "qa2", label: "QA2", terminal: false }] };
    const put = await updateWorkflow(row.id, { definition: added });
    expect(put.status).toBe(200);
    expect(((await put.json()) as OutsideReport).outsideWorkflow).toEqual([{ id: shipped.id, status: "shipped" }]);
    expect((await apply("release-ops-no-pr")).status).toBe(201);
    expect((await reset()).status).toBe(200);
    expect(await statusOf(shipped.id)).toBe("shipped");
  });

  it("PUT: a task on a status the workflow never had does not block a save that only adds a state, and is listed", async () => {
    const existing = await defaultRow();
    const legacy = await seedTask("legacy_unknown");
    const res = await updateWorkflow(existing.id, { definition: QA_AND_MORE });
    expect(res.status).toBe(200);
    expect(((await res.json()) as OutsideReport).outsideWorkflow).toEqual([{ id: legacy.id, status: "legacy_unknown" }]);
  });

  it("apply-template: the report names at most 50 terminal tasks and says it is cut", async () => {
    await defaultRow();
    await store.db.task.createMany({
      data: Array.from({ length: 52 }, (_, i) => ({ projectId, title: `S${i}`, status: "shipped", createdByUserId: adminId })),
    });
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(201);
    const body = (await res.json()) as TerminalReport;
    expect(body.terminalOutsideWorkflow).toHaveLength(50);
    expect(body.terminalOutsideTruncated).toBe(true);
  });

  it("a four-state project is unchanged: every route answers 2xx with an empty report", async () => {
    for (const status of ["open", "in_progress", "review", "done", "backlog", "abandoned"]) await seedTask(status);
    const applied = await apply("release-ops-no-pr");
    expect(applied.status).toBe(201);
    expect(((await applied.json()) as TerminalReport).terminalOutsideWorkflow).toEqual([]);
    const done = await reset();
    expect(done.status).toBe(200);
    expect(((await done.json()) as TerminalReport).terminalOutsideWorkflow).toEqual([]);
  });
});

describe("reset (DELETE /projects/:id/workflow) guard", () => {
  it("answers 409 naming the stranded tasks, keeps the row and the pins", async () => {
    const existing = await defaultRow();
    const pinned = await seedTask("qa", { workflowId: existing.id });
    const inherited = await seedTask("qa");
    const res = await reset();
    expect(res.status).toBe(409);
    const body = (await res.json()) as Conflict;
    expect(body).toMatchObject({ error: "stranded_tasks", truncated: false });
    expect(body.taskIds.sort()).toEqual([pinned.id, inherited.id].sort());
    expect(await rowCount()).toBe(1);
    expect((await store.db.task.findUniqueOrThrow({ where: { id: pinned.id } })).workflowId).toBe(existing.id);
  });

  it("a custom terminal task does not block: reset answers 200, drops the row and reports the task", async () => {
    const existing = await defaultRow();
    const shipped = await seedTask("shipped", { workflowId: existing.id });
    await seedTask("open");
    const res = await reset();
    expect(res.status).toBe(200);
    const body = (await res.json()) as TerminalReport & { source: string };
    expect(body.source).toBe("default");
    expect(body.terminalOutsideWorkflow).toEqual([{ id: shipped.id, status: "shipped" }]);
    expect(await rowCount()).toBe(0);
    const after = await store.db.task.findUniqueOrThrow({ where: { id: shipped.id } });
    expect(after).toMatchObject({ status: "shipped", workflowId: null });
  });

  it("answers 200 when every task is on a built-in state", async () => {
    const existing = await defaultRow();
    await seedTask("open", { workflowId: existing.id });
    await seedTask("review");
    expect((await reset()).status).toBe(200);
    expect(await rowCount()).toBe(0);
  });

  it("a task pinned to another workflow does not block", async () => {
    await defaultRow();
    const other = await defaultRow(QA_DEFINITION, false);
    await seedTask("qa", { workflowId: other.id });
    expect((await reset()).status).toBe(200);
    expect(await rowCount()).toBe(1);
  });

  it("answers 404 for a project without a custom workflow, whatever its tasks", async () => {
    await seedTask("weird_status");
    expect((await reset()).status).toBe(404);
  });
});

describe("POST /projects/:id/workflows with isDefault guard", () => {
  it("answers 409 when the new default drops a state of a task that follows the previous default; no row is written", async () => {
    const existing = await defaultRow();
    const stranded = await seedTask("qa");
    const res = await createWorkflow({ name: "Slim", isDefault: true, definition: SHIPPED_ONLY });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Conflict).taskIds).toEqual([stranded.id]);
    expect(await rowCount()).toBe(1);
    expect((await store.db.workflow.findUniqueOrThrow({ where: { id: existing.id } })).isDefault).toBe(true);
  });

  it("answers 409 over the built-in default when a task sits on a state the new definition lacks", async () => {
    const stranded = await seedTask("review");
    const res = await createWorkflow({ name: "Slim", isDefault: true, definition: SHIPPED_ONLY });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Conflict).taskIds).toEqual([stranded.id]);
    expect(await rowCount()).toBe(0);
  });

  it("answers 201 when the new default keeps the state, and the previous default stops being the default", async () => {
    const existing = await defaultRow();
    await seedTask("qa");
    const res = await createWorkflow({ name: "More", isDefault: true, definition: QA_AND_MORE });
    expect(res.status).toBe(201);
    expect(((await res.json()) as TerminalReport).terminalOutsideWorkflow).toEqual([]);
    expect((await store.db.workflow.findUniqueOrThrow({ where: { id: existing.id } })).isDefault).toBe(false);
    expect(await rowCount()).toBe(2);
  });

  it("a custom terminal task does not block and is reported", async () => {
    await defaultRow(QA_AND_MORE);
    const released = await seedTask("released");
    await seedTask("open");
    const res = await createWorkflow({ name: "Slim", isDefault: true, definition: SHIPPED_ONLY });
    expect(res.status).toBe(201);
    expect(((await res.json()) as TerminalReport).terminalOutsideWorkflow).toEqual([{ id: released.id, status: "released" }]);
    expect(await statusOf(released.id)).toBe("released");
  });

  it("a task pinned to the previous default row keeps that row and does not block", async () => {
    const existing = await defaultRow();
    await seedTask("qa", { workflowId: existing.id });
    expect((await createWorkflow({ name: "Slim", isDefault: true, definition: SHIPPED_ONLY })).status).toBe(201);
  });

  it("a non-default workflow is never checked", async () => {
    await defaultRow();
    await seedTask("qa");
    const res = await createWorkflow({ name: "Slim", isDefault: false, definition: SHIPPED_ONLY });
    expect(res.status).toBe(201);
    expect(((await res.json()) as TerminalReport).terminalOutsideWorkflow).toEqual([]);
  });

  it("isDefault absent behaves like false: not checked", async () => {
    await seedTask("weird_status");
    expect((await createWorkflow({ name: "Slim", definition: SHIPPED_ONLY })).status).toBe(201);
  });
});

describe("PUT /workflows/:id guard", () => {
  it("answers 409 when the definition of the default row drops the state of a following task; the row is untouched", async () => {
    const existing = await defaultRow();
    const stranded = await seedTask("qa");
    const res = await updateWorkflow(existing.id, { definition: SHIPPED_ONLY });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Conflict).taskIds).toEqual([stranded.id]);
    expect((await store.db.workflow.findUniqueOrThrow({ where: { id: existing.id } })).definition).toEqual(QA_DEFINITION);
  });

  it("answers 409 for a task pinned to the default row", async () => {
    const existing = await defaultRow();
    const stranded = await seedTask("qa", { workflowId: existing.id });
    const res = await updateWorkflow(existing.id, { definition: SHIPPED_ONLY });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Conflict).taskIds).toEqual([stranded.id]);
  });

  it("a custom terminal task does not block and is reported", async () => {
    const existing = await defaultRow();
    const shipped = await seedTask("shipped");
    const res = await updateWorkflow(existing.id, { definition: { ...SHIPPED_ONLY, states: SHIPPED_ONLY.states.filter((st) => st.name !== "shipped").concat({ name: "done", label: "Done", terminal: true }), transitions: [{ from: "open", to: "done" }] } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TerminalReport).terminalOutsideWorkflow).toEqual([{ id: shipped.id, status: "shipped" }]);
    expect(await statusOf(shipped.id)).toBe("shipped");
  });

  it("answers 200 when the new definition keeps the states in use", async () => {
    const existing = await defaultRow();
    await seedTask("qa");
    await seedTask("open");
    const res = await updateWorkflow(existing.id, { definition: QA_AND_MORE });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TerminalReport).terminalOutsideWorkflow).toEqual([]);
  });

  it("a rename and an identical definition are not checked", async () => {
    // Stored in the shape the route's schema yields, so the PUT body is identical.
    const parsed = { ...QA_DEFINITION, transitions: QA_DEFINITION.transitions.map((t) => ({ ...t, requiredRole: "any" })) };
    const existing = await defaultRow(parsed);
    await seedTask("weird_status");
    expect((await updateWorkflow(existing.id, { name: "Renamed" })).status).toBe(200);
    expect((await updateWorkflow(existing.id, { definition: QA_DEFINITION })).status).toBe(200);
  });

  it("a non-default row: only the tasks pinned to it count, the tasks of the default do not", async () => {
    await defaultRow();
    const other = await defaultRow(QA_DEFINITION, false);
    await seedTask("qa");
    const pinned = await seedTask("qa", { workflowId: other.id });
    const refused = await updateWorkflow(other.id, { definition: SHIPPED_ONLY });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as Conflict).taskIds).toEqual([pinned.id]);
    await store.db.task.update({ where: { id: pinned.id }, data: { status: "open" } });
    expect((await updateWorkflow(other.id, { definition: SHIPPED_ONLY })).status).toBe(200);
  });

  it("making a row the default checks the tasks that follow the previous default against its definition", async () => {
    await defaultRow();
    const stranded = await seedTask("qa");
    const other = await defaultRow(SHIPPED_ONLY, false);
    const refused = await updateWorkflow(other.id, { isDefault: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as Conflict).taskIds).toEqual([stranded.id]);
    expect((await store.db.workflow.findUniqueOrThrow({ where: { id: other.id } })).isDefault).toBe(false);
    const keeps = await defaultRow(QA_AND_MORE, false);
    expect((await updateWorkflow(keeps.id, { isDefault: true })).status).toBe(200);
  });

  it("making a row the default with a new definition checks against the new definition", async () => {
    await defaultRow();
    await seedTask("qa");
    const other = await defaultRow(SHIPPED_ONLY, false);
    expect((await updateWorkflow(other.id, { isDefault: true, definition: SHIPPED_ONLY })).status).toBe(409);
    expect((await updateWorkflow(other.id, { isDefault: true, definition: QA_AND_MORE })).status).toBe(200);
  });

  it("demoting the default row checks the tasks against the built-in definition", async () => {
    const existing = await defaultRow();
    const stranded = await seedTask("qa");
    const refused = await updateWorkflow(existing.id, { isDefault: false });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as Conflict).taskIds).toEqual([stranded.id]);
    await store.db.task.update({ where: { id: stranded.id }, data: { status: "open" } });
    expect((await updateWorkflow(existing.id, { isDefault: false })).status).toBe(200);
  });

  it("demoting a row that is not the default changes nothing for the tasks and is not checked", async () => {
    await defaultRow();
    const other = await defaultRow(QA_DEFINITION, false);
    await seedTask("qa");
    expect((await updateWorkflow(other.id, { isDefault: false })).status).toBe(200);
  });
});

// ── Two default rows: the tasks follow the next one once the first stops being the default ──

// Older default row: open, qa, review, shipped (terminal).
const OLDER_DEFAULT = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "review", label: "Review", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [{ from: "open", to: "qa" }, { from: "qa", to: "review" }, { from: "review", to: "shipped" }],
};

// Two default rows can only be inserted directly; the routes keep one. The next default row has "qa"
// (the built-in definition lacks it) and lacks "review" (the built-in definition has it).
async function twoDefaultRows() {
  const first = await store.db.workflow.create({ data: { projectId, name: "A", isDefault: true, definition: OLDER_DEFAULT as never, createdAt: new Date("2020-01-01") } });
  const second = await store.db.workflow.create({ data: { projectId, name: "B", isDefault: true, definition: QA_AND_MORE as never, createdAt: new Date("2021-01-01") } });
  return { first, second };
}

describe("two default rows", () => {
  it("PUT demoting the first default checks against the next default row: a state it has is fine", async () => {
    const { first } = await twoDefaultRows();
    await seedTask("qa");
    expect((await updateWorkflow(first.id, { isDefault: false })).status).toBe(200);
  });

  it("PUT demoting the first default checks against the next default row: a state it lacks strands the task", async () => {
    const { first } = await twoDefaultRows();
    const stranded = await seedTask("review");
    const res = await updateWorkflow(first.id, { isDefault: false });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Conflict).taskIds).toEqual([stranded.id]);
    expect((await store.db.workflow.findUniqueOrThrow({ where: { id: first.id } })).isDefault).toBe(true);
  });

  it("reset checks against the next default row: a state it has is fine and the next row stays", async () => {
    const { first, second } = await twoDefaultRows();
    await seedTask("qa");
    await seedTask("qa", { workflowId: first.id });
    expect((await reset()).status).toBe(200);
    const rows = await store.db.workflow.findMany({ where: { projectId } });
    expect(rows.map((r) => r.id)).toEqual([second.id]);
  });

  it("reset checks against the next default row: a state it lacks strands the task and nothing is dropped", async () => {
    const { first } = await twoDefaultRows();
    const stranded = await seedTask("review");
    const res = await reset();
    expect(res.status).toBe(409);
    expect(((await res.json()) as Conflict).taskIds).toEqual([stranded.id]);
    expect(await rowCount()).toBe(2);
    expect(await store.db.workflow.findUnique({ where: { id: first.id } })).not.toBeNull();
  });
});

describe("the 409 names the target states", () => {
  it("one list when every group has the same target", async () => {
    const existing = await defaultRow();
    await seedTask("qa");
    const res = await updateWorkflow(existing.id, { definition: SHIPPED_ONLY });
    expect(((await res.json()) as Conflict).message).toContain("(open, shipped)");
  });

  it("one list per group when a PUT demotes the default row and changes its definition", async () => {
    const { first } = await twoDefaultRows();
    const pinned = await seedTask("qa", { workflowId: first.id });
    const inherited = await seedTask("review");
    const res = await updateWorkflow(first.id, { isDefault: false, definition: SHIPPED_ONLY });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Conflict;
    expect(body.taskIds.sort()).toEqual([pinned.id, inherited.id].sort());
    expect(body.message).toContain("one list per group of tasks");
    expect(body.message).toContain("open, shipped");
    expect(body.message).toContain("open, qa, shipped, released");
  });

  it("only the groups that have stranded tasks are listed", async () => {
    const { first } = await twoDefaultRows();
    // The pinned task is stranded by the new definition; the inherited task is fine under the next default row.
    const pinned = await seedTask("qa", { workflowId: first.id });
    await seedTask("open");
    const res = await updateWorkflow(first.id, { isDefault: false, definition: SHIPPED_ONLY });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Conflict;
    expect(body.taskIds).toEqual([pinned.id]);
    expect(body.message).toContain("(open, shipped)");
    expect(body.message).not.toContain("released");
  });
});
