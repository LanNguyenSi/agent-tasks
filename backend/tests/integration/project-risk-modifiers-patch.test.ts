/**
 * DB-backed end-to-end test for the riskModifiers write path (task 05b5eba8).
 * The project's riskModifiers are configured ONLY through
 * PATCH /projects/:id (no direct database write), then a task whose
 * description triggers the modifier is created through
 * POST /projects/:projectId/tasks. The create response's effective claim
 * threshold must rise by exactly the configured points over the same task
 * created before the PATCH, and fall back after a null clear.
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

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/task-signal.js", () => ({
  emitTaskAvailableSignal: vi.fn().mockResolvedValue(undefined),
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

import { projectRouter } from "../../src/routes/projects.js";
import { taskRouter } from "../../src/routes/tasks.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let projectId: string;
let adminId: string;

const BASE_THRESHOLD = 70;
const AUTH_POINTS = 12;
const AUTH_DESCRIPTION =
  "Add rate limiting to the login endpoint in src/routes/auth.ts to mitigate credential-stuffing attempts.";

function makeApp() {
  const actor: Actor = { type: "human", userId: adminId };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", projectRouter);
  app.route("/", taskRouter);
  return app;
}

function patchProject(body: unknown) {
  return makeApp().request(`/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createTask(description: string) {
  const res = await makeApp().request(`/projects/${projectId}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `Task ${randomUUID()}`, description }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    confidence: { effectiveThreshold: number; triggeredRiskModifiers: string[] };
  };
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
  const teamId = randomUUID();
  adminId = randomUUID();
  projectId = randomUUID();
  await db.user.create({ data: { id: adminId, login: `admin-${adminId}` } });
  await db.team.create({ data: { id: teamId, name: "Risk", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId: adminId, role: "ADMIN" } });
  await db.project.create({
    data: { id: projectId, teamId, name: "Risk", slug: randomUUID(), confidenceThreshold: BASE_THRESHOLD },
  });
});

describe("riskModifiers configured via PATCH /projects/:id", () => {
  it("raises a triggering task's effective threshold by exactly the configured points, and a null clear removes it", async () => {
    const before = await createTask(AUTH_DESCRIPTION);
    expect(before.confidence.effectiveThreshold).toBe(BASE_THRESHOLD);
    expect(before.confidence.triggeredRiskModifiers).toEqual([]);

    const patched = await patchProject({ riskModifiers: { touchesAuth: AUTH_POINTS } });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { project: { riskModifiers: unknown } }).project.riskModifiers).toEqual({
      touchesAuth: AUTH_POINTS,
    });

    const after = await createTask(AUTH_DESCRIPTION);
    expect(after.confidence.triggeredRiskModifiers).toEqual(["touchesAuth"]);
    expect(after.confidence.effectiveThreshold).toBe(BASE_THRESHOLD + AUTH_POINTS);

    // A description that triggers nothing is unaffected by the configured modifier.
    const unrelated = await createTask("Rename a internal helper function for readability.");
    expect(unrelated.confidence.effectiveThreshold).toBe(BASE_THRESHOLD);

    expect((await patchProject({ riskModifiers: null })).status).toBe(200);
    const cleared = await createTask(AUTH_DESCRIPTION);
    expect(cleared.confidence.effectiveThreshold).toBe(BASE_THRESHOLD);
    expect(cleared.confidence.triggeredRiskModifiers).toEqual([]);
  });

  it("rejects an invalid config with 400 and leaves the stored value untouched", async () => {
    expect((await patchProject({ riskModifiers: { touchesAuth: AUTH_POINTS } })).status).toBe(200);
    expect((await patchProject({ riskModifiers: { touchesAuth: 60, touchesDatabase: 41 } })).status).toBe(400);
    expect((await patchProject({ riskModifiers: { touchesAuthh: 5 } })).status).toBe(400);
    const stored = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(stored.riskModifiers).toEqual({ touchesAuth: AUTH_POINTS });
  });
});
