/**
 * POST /projects/:projectId/workflow/apply-template/:slug refuses with 409 when
 * the project has tasks whose status is not a state of the template, because
 * applying a template moves no task. Backlog and abandoned live outside every
 * workflow and never count; a task pinned to another workflow keeps that
 * workflow and does not count; a repeated apply of an identical definition
 * changes nothing and is not checked.
 *
 * Against the registered templates (they share the four built-in names) the
 * guard only fires for a project whose tasks sit on other names.
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

  it("a task of a project without any workflow row counts too (it follows the built-in default)", async () => {
    const stranded = await seedTask("weird_status");
    const res = await apply("release-ops-no-pr");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { taskIds: string[] }).taskIds).toEqual([stranded.id]);
    expect(await rowCount()).toBe(0);
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
    await store.db.task.createMany({
      data: Array.from({ length: 52 }, (_, i) => ({ projectId, title: `S${i}`, status: "stranded", createdByUserId: adminId })),
    });
    const res = await apply("branch-pr-merge-gated");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { taskIds: string[]; truncated: boolean; message: string };
    expect(body.taskIds).toHaveLength(50);
    expect(body.truncated).toBe(true);
    expect(body.message).toContain("more than 50");
  });
});
