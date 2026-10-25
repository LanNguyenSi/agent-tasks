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
import { defaultWorkflowDefinition } from "../../src/services/default-workflow.js";
import { findWorkflowTemplate } from "../../src/services/workflow-templates.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const requestDb = new AsyncLocalStorage<PrismaClient>();
let store: Awaited<ReturnType<typeof groundingPostgres>>;
let projectId: string;
let adminId: string;
harness.current = () => requestDb.getStore() ?? store.db;

function call(path: string, method: string) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", { type: "human", userId: adminId });
    await requestDb.run(store.db, next);
  });
  app.route("/", workflowRouter);
  return app.request(`/projects/${projectId}${path}`, { method });
}

/**
 * Two default rows in one project. The NEWER row is inserted first, so an
 * unordered scan returns it before the oldest row (physical order), while the
 * readers' FIRST_DEFAULT_ROW_ORDER picks the oldest by createdAt.
 */
async function twoDefaults() {
  const data = (name: string, createdAt: Date) => ({
    id: randomUUID(), projectId, name, isDefault: true, createdAt, definition: defaultWorkflowDefinition() as object,
  });
  const newer = await store.db.workflow.create({ data: data("Newer default", new Date("2026-02-01T00:00:00Z")) });
  const oldest = await store.db.workflow.create({ data: data("Oldest default", new Date("2026-01-01T00:00:00Z")) });
  return { oldest, newer };
}

beforeAll(async () => { store = await groundingPostgres(); }, 60_000);
afterAll(async () => { await store?.close(); });
beforeEach(async () => {
  await store.db.task.deleteMany();
  await store.db.workflow.deleteMany();
  await store.db.project.deleteMany();
  await store.db.teamMember.deleteMany();
  await store.db.team.deleteMany();
  await store.db.user.deleteMany();
  const teamId = randomUUID();
  [projectId, adminId] = [randomUUID(), randomUUID()];
  await store.db.user.create({ data: { id: adminId, login: `admin-${adminId}` } });
  await store.db.team.create({ data: { id: teamId, name: "Team", slug: `team-${teamId}` } });
  await store.db.teamMember.create({ data: { teamId, userId: adminId, role: "ADMIN" } });
  await store.db.project.create({ data: { id: projectId, teamId, name: "P", slug: `project-${projectId}` } });
});

describe("workflow mutations act on the oldest default row (the one readers use)", () => {
  it("fixture: an unordered scan really returns the newer row first", async () => {
    const { oldest, newer } = await twoDefaults();
    const unordered = await store.db.workflow.findFirst({ where: { projectId, isDefault: true } });
    expect(unordered?.id).toBe(newer.id);
    expect(unordered?.id).not.toBe(oldest.id);
  });

  it("customize reports a conflict with the oldest default row", async () => {
    const { oldest } = await twoDefaults();
    const res = await call("/workflow/customize", "POST");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ workflowId: oldest.id });
  });

  it("apply-template updates the oldest default row and leaves the newer one alone", async () => {
    const { oldest, newer } = await twoDefaults();
    const template = findWorkflowTemplate("release-ops-no-pr")!;
    const res = await call("/workflow/apply-template/release-ops-no-pr", "POST");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ workflowId: oldest.id });
    expect((await store.db.workflow.findUniqueOrThrow({ where: { id: oldest.id } })).definition).toEqual(template.definition);
    expect(await store.db.workflow.findUniqueOrThrow({ where: { id: newer.id } })).toMatchObject({ name: "Newer default", definition: defaultWorkflowDefinition() });
  });

  it("reset deletes the oldest default row and keeps the newer one", async () => {
    const { oldest, newer } = await twoDefaults();
    const res = await call("/workflow", "DELETE");
    expect(res.status).toBe(200);
    expect(await store.db.workflow.findUnique({ where: { id: oldest.id } })).toBeNull();
    expect(await store.db.workflow.findUnique({ where: { id: newer.id } })).not.toBeNull();
  });
});
