/**
 * DB-backed paging test for `GET /projects/:projectId/tasks` (task e36696d7
 * criterion 2, round 2). `project-tasks-browse-filters.test.ts` mocks
 * `prisma.task.findMany` and only inspects the `where`/`take` args it was
 * called with; it cannot show that the take-limit-plus-one probe
 * (`backend/src/routes/tasks.ts`) actually pages a real result set without
 * skipping or repeating a row. This test runs the route against a real
 * PostgreSQL database (via the `groundingPostgres` helper other integration
 * suites already use) and drives it through two pages.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { AgentActor } from "../../src/types/auth.js";
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
  resolveTeamId: vi.fn().mockResolvedValue({ ok: true, teamId: "team-1" }),
  resolveTeamIdErrorBody: vi.fn(),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);
vi.mock("../../src/services/audit.js", () => ({
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

const AGENT: AgentActor = {
  type: "agent",
  tokenId: "agent-token-1",
  teamId: "team-1",
  scopes: ["tasks:read"],
  userId: "user-1",
};

function makeApp() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", AGENT);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

async function getTasks(app: Hono<{ Variables: AppVariables }>, query: string) {
  const res = await app.request(`/projects/${projectId}/tasks?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { tasks: { id: string }[]; nextCursor: string | null };
}

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let projectId: string;
let taskIds: string[];

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
  const teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Paging", slug: randomUUID() } });
  projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "Paging", slug: randomUUID() } });
  taskIds = [];
});

async function seedTasks(count: number) {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    ids.push(id);
    await db.task.create({
      data: {
        id,
        projectId,
        title: `Task ${i + 1}`,
        createdAt: new Date(base + i * 1000),
      },
    });
  }
  taskIds = ids;
  return ids;
}

describe("GET /projects/:projectId/tasks — real-database paging (task e36696d7)", () => {
  it("4 rows, limit 2: page one returns rows 1-2 with nextCursor=row2, page two returns rows 3-4 with nextCursor=null, no row skipped or repeated", async () => {
    const ids = await seedTasks(4);
    const app = makeApp();

    const page1 = await getTasks(app, "limit=2&sort=createdAt:asc");
    expect(page1.tasks.map((t) => t.id)).toEqual([ids[0], ids[1]]);
    expect(page1.nextCursor).toBe(ids[1]);

    const page2 = await getTasks(app, `limit=2&sort=createdAt:asc&cursor=${page1.nextCursor}`);
    expect(page2.tasks.map((t) => t.id)).toEqual([ids[2], ids[3]]);
    expect(page2.nextCursor).toBeNull();

    // Union of both pages is exactly the seeded set, once each.
    expect([...page1.tasks, ...page2.tasks].map((t) => t.id).sort()).toEqual([...ids].sort());
  });

  it("3 rows, limit 3: nextCursor is null on an exactly-full last page", async () => {
    const ids = await seedTasks(3);
    const app = makeApp();

    const page = await getTasks(app, "limit=3&sort=createdAt:asc");
    expect(page.tasks.map((t) => t.id)).toEqual(ids);
    expect(page.nextCursor).toBeNull();
  });
});
