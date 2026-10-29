/**
 * Workflow API (POST create, PUT update) with a custom state vocabulary.
 *
 * The state NAMES are free; `initialState` stays "open"; `backlog` and
 * `abandoned` are reserved. Structural errors keep answering the validator's
 * 400 with the issue list in `error.issues`.
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
import { defaultWorkflowDefinition } from "../../src/services/default-workflow.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const requestDb = new AsyncLocalStorage<PrismaClient>();
let store: Awaited<ReturnType<typeof groundingPostgres>>;
let projectId: string;
let adminId: string;
harness.current = () => requestDb.getStore() ?? store.db;

function call(path: string, method: string, body?: unknown) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", { type: "human", userId: adminId });
    await requestDb.run(store.db, next);
  });
  app.route("/", workflowRouter);
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function sevenStage() {
  return {
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "spec", label: "Spec", terminal: false },
      { name: "implement", label: "Implement", terminal: false },
      { name: "review", label: "Review", terminal: false },
      { name: "shipped", label: "Shipped", terminal: true },
    ],
    transitions: [
      { from: "open", to: "spec" },
      { from: "spec", to: "open" },
      { from: "spec", to: "implement" },
      { from: "implement", to: "review" },
      { from: "review", to: "shipped" },
    ],
    initialState: "open",
  };
}

async function issuesOf(res: Response): Promise<string[]> {
  const body = (await res.json()) as { error: { issues: { message: string }[] } };
  return body.error.issues.map((i) => i.message);
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

describe("POST /projects/:projectId/workflows", () => {
  it("persists a definition with custom state names, a custom terminal and missing built-ins", async () => {
    const res = await call(`/projects/${projectId}/workflows`, "POST", { name: "Custom", isDefault: true, definition: sevenStage() });
    expect(res.status).toBe(201);
    const row = await store.db.workflow.findFirstOrThrow({ where: { projectId } });
    expect(row.definition).toMatchObject(sevenStage());
    // The effective-workflow reader serves the stored custom vocabulary.
    const eff = await call(`/projects/${projectId}/effective-workflow`, "GET");
    expect(eff.status).toBe(200);
    const effBody = (await eff.json()) as { source: string; definition: { states: { name: string }[] } };
    expect(effBody.source).toBe("custom");
    expect(effBody.definition.states.map((s) => s.name)).toEqual(["open", "spec", "implement", "review", "shipped"]);
  });

  it("still accepts the built-in four-state definition", async () => {
    const res = await call(`/projects/${projectId}/workflows`, "POST", { name: "Four", definition: defaultWorkflowDefinition() });
    expect(res.status).toBe(201);
  });

  it("rejects a state named backlog", async () => {
    const def = sevenStage();
    def.states.push({ name: "backlog", label: "Backlog", terminal: false });
    const res = await call(`/projects/${projectId}/workflows`, "POST", { name: "X", definition: def });
    expect(res.status).toBe(400);
    expect((await issuesOf(res)).some((m) => /State name "backlog" is reserved/.test(m))).toBe(true);
    expect(await store.db.workflow.count({ where: { projectId } })).toBe(0);
  });

  it("rejects an edge to backlog", async () => {
    const def = sevenStage();
    def.transitions.push({ from: "open", to: "backlog" });
    const res = await call(`/projects/${projectId}/workflows`, "POST", { name: "X", definition: def });
    expect(res.status).toBe(400);
    expect((await issuesOf(res)).some((m) => /to reserved state "backlog"/.test(m))).toBe(true);
  });

  it("rejects an edge from abandoned", async () => {
    const def = sevenStage();
    def.transitions.push({ from: "abandoned", to: "open" });
    const res = await call(`/projects/${projectId}/workflows`, "POST", { name: "X", definition: def });
    expect(res.status).toBe(400);
    expect((await issuesOf(res)).some((m) => /from reserved state "abandoned"/.test(m))).toBe(true);
  });

  it("rejects a state named abandoned", async () => {
    const def = sevenStage();
    def.states.push({ name: "abandoned", label: "Abandoned", terminal: true });
    const res = await call(`/projects/${projectId}/workflows`, "POST", { name: "X", definition: def });
    expect(res.status).toBe(400);
    expect((await issuesOf(res)).some((m) => /State name "abandoned" is reserved/.test(m))).toBe(true);
  });

  it("bounds a state name at 64 characters: 64 is created, 65 answers 400 and stores nothing", async () => {
    const withName = (name: string) => {
      const def = sevenStage();
      def.states[4]!.name = name;
      def.transitions[4]!.to = name;
      return def;
    };
    const ok = await call(`/projects/${projectId}/workflows`, "POST", { name: "Max", definition: withName("s".repeat(64)) });
    expect(ok.status).toBe(201);
    const before = await store.db.workflow.count({ where: { projectId } });
    const res = await call(`/projects/${projectId}/workflows`, "POST", { name: "Over", definition: withName("s".repeat(65)) });
    expect(res.status).toBe(400);
    expect(await store.db.workflow.count({ where: { projectId } })).toBe(before);
  });

  it("rejects a custom initialState", async () => {
    const def = sevenStage();
    def.initialState = "spec";
    const res = await call(`/projects/${projectId}/workflows`, "POST", { name: "X", definition: def });
    expect(res.status).toBe(400);
    expect((await issuesOf(res)).some((m) => /initialState must be "open"/.test(m))).toBe(true);
  });

  it("keeps the structural errors: duplicate state, missing endpoint, duplicate pair", async () => {
    const def = sevenStage();
    def.states.push({ name: "spec", label: "Spec 2", terminal: false });
    def.transitions.push({ from: "ghost", to: "open" }, { from: "open", to: "phantom" }, { from: "open", to: "spec" });
    const res = await call(`/projects/${projectId}/workflows`, "POST", { name: "X", definition: def });
    expect(res.status).toBe(400);
    const messages = await issuesOf(res);
    expect(messages.some((m) => /Duplicate state name: "spec"/.test(m))).toBe(true);
    expect(messages.some((m) => /missing "from" state: "ghost"/.test(m))).toBe(true);
    expect(messages.some((m) => /missing "to" state: "phantom"/.test(m))).toBe(true);
    expect(messages.some((m) => /Duplicate transition: open→spec/.test(m))).toBe(true);
  });
});

describe("PUT /workflows/:id", () => {
  async function seed() {
    return store.db.workflow.create({
      data: { id: randomUUID(), projectId, name: "Seed", isDefault: true, definition: defaultWorkflowDefinition() as object },
    });
  }

  it("replaces the definition with a custom vocabulary", async () => {
    const row = await seed();
    const res = await call(`/workflows/${row.id}`, "PUT", { definition: sevenStage() });
    expect(res.status).toBe(200);
    expect((await store.db.workflow.findUniqueOrThrow({ where: { id: row.id } })).definition).toMatchObject(sevenStage());
  });

  it("rejects a reserved name and leaves the stored row alone", async () => {
    const row = await seed();
    const def = sevenStage();
    def.transitions.push({ from: "review", to: "backlog" });
    const res = await call(`/workflows/${row.id}`, "PUT", { definition: def });
    expect(res.status).toBe(400);
    expect((await issuesOf(res)).some((m) => /reserved state "backlog"/.test(m))).toBe(true);
    expect((await store.db.workflow.findUniqueOrThrow({ where: { id: row.id } })).definition).toEqual(defaultWorkflowDefinition());
  });

  it("rejects a custom initialState", async () => {
    const row = await seed();
    const def = sevenStage();
    def.initialState = "implement";
    const res = await call(`/workflows/${row.id}`, "PUT", { definition: def });
    expect(res.status).toBe(400);
  });
});
