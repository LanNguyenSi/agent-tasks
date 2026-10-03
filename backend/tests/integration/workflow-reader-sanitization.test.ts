import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
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

import { workflowRouter } from "../../src/routes/workflows.js";
import { defaultWorkflowDefinition, type WorkflowDefinitionShape } from "../../src/services/default-workflow.js";

const legacy: WorkflowDefinitionShape = {
  initialState: "backlog",
  states: [
    { name: "backlog", label: "Backlog", terminal: false },
    { name: "spec", label: "Spec", terminal: false },
    { name: "review", label: "Review", terminal: false },
    { name: "done", label: "Done", terminal: true },
  ],
  transitions: [
    { from: "backlog", to: "spec", label: "Start scoping", requires: ["branchPresent"], requiredRole: "admin" },
    { from: "backlog", to: "review", label: "Fast track" },
    { from: "backlog", to: "done", label: "Close parked" },
    { from: "spec", to: "backlog", label: "Release" },
    { from: "spec", to: "review", label: "Submit" },
    { from: "review", to: "done", label: "Approve" },
  ],
};
const sanitized: WorkflowDefinitionShape = {
  initialState: "open",
  states: [...legacy.states.slice(1), { name: "open", label: "Open", terminal: false }],
  transitions: [
    { from: "open", to: "spec", label: "Start scoping", requires: ["branchPresent"], requiredRole: "admin" },
    { from: "spec", to: "review", label: "Submit" },
    { from: "review", to: "done", label: "Approve" },
  ],
};
let store: Awaited<ReturnType<typeof groundingPostgres>> | undefined;
let userId: string;
let projectId: string;
let app: Hono<{ Variables: AppVariables }>;

beforeAll(async () => {
  store = await groundingPostgres();
  shared.db = store.db;
}, 60_000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => {
  userId = randomUUID();
  const teamId = randomUUID();
  projectId = randomUUID();
  await shared.db!.user.create({ data: { id: userId, login: `reader-${userId}` } });
  await shared.db!.team.create({ data: { id: teamId, name: "Readers", slug: teamId } });
  await shared.db!.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  await shared.db!.project.create({ data: { id: projectId, teamId, name: "Legacy", slug: projectId } });
  app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", { type: "human", userId });
    await next();
  });
  app.route("/", workflowRouter);
});

async function workflow(definition: WorkflowDefinitionShape) {
  return shared.db!.workflow.create({ data: { projectId, name: "Stored", isDefault: true, definition: definition as object } });
}
async function validate(id: string, from: string, to: string, actorRole = "admin") {
  const response = await app.request(`/workflows/${id}/validate-transition`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, to, actorRole }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("stored workflow readers", () => {
  it("returns the sanitized legacy view without changing the stored definition", async () => {
    const stored = await workflow(legacy);
    const response = await app.request(`/projects/${projectId}/effective-workflow`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: "custom", workflowId: stored.id, definition: sanitized });
    expect((await shared.db!.workflow.findUniqueOrThrow({ where: { id: stored.id } })).definition).toEqual(legacy);
  });

  it("validates the remapped start edge and retains its required role", async () => {
    const stored = await workflow(legacy);
    expect(await validate(stored.id, "open", "spec")).toEqual({ valid: true });
    expect(await validate(stored.id, "open", "spec", "member")).toEqual({ valid: false, reason: "Requires role: admin" });
  });

  it.each([["spec", "backlog"], ["backlog", "spec"], ["backlog", "review"], ["backlog", "done"], ["open", "review"], ["open", "done"]])(
    "rejects a removed or unsafe legacy edge %s → %s", async (from, to) => {
      const stored = await workflow(legacy);
      expect(await validate(stored.id, from!, to!)).toEqual({ valid: false, reason: `No transition defined from '${from}' to '${to}'` });
    },
  );

  it("keeps both readers unchanged for valid stored definitions", async () => {
    const definition = defaultWorkflowDefinition();
    const stored = await workflow(definition);
    const response = await app.request(`/projects/${projectId}/effective-workflow`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: "custom", workflowId: stored.id, definition });
    expect(await validate(stored.id, "open", "in_progress", "any")).toEqual({ valid: true });
    expect(await validate(stored.id, "open", "done", "any")).toEqual({ valid: false, reason: "No transition defined from 'open' to 'done'" });
  });

  it("keeps the built-in default response when no custom workflow exists", async () => {
    const response = await app.request(`/projects/${projectId}/effective-workflow`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: "default", workflowId: null, definition: defaultWorkflowDefinition() });
  });
});
