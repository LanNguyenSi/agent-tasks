/**
 * DB-backed test for the `?q=` task search LIKE-wildcard escaping. The search
 * builds Prisma `contains` clauses, which are passed through to SQL LIKE
 * without escaping, so an unescaped `%` or `_` in the query acts as a
 * wildcard (a search for `a_b` also finds `axb`). `escapeLikePattern`
 * (lib/like-pattern.ts) escapes the value first; this test drives the task
 * search route (`GET /teams/:teamId/tasks?q=...`, backend/src/routes/tasks.ts)
 * against a real PostgreSQL database and asserts `%`, `_` and the backslash
 * match literally, and case-insensitively, in title, description and
 * externalRef.
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

async function search(query: string) {
  const app = makeApp();
  const res = await app.request(`/teams/${teamId}/tasks?q=${encodeURIComponent(query)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tasks: { title: string }[] };
  return body.tasks.map((t) => t.title).sort();
}

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let projectId: string;
let teamId: string;

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
  // One fresh team per test: the route lists tasks across every project of
  // the resolved team, so each test needs its own team to stay isolated
  // from the rows its predecessors seeded.
  teamId = randomUUID();
  accessMocks.resolveTeamId.mockResolvedValue({ ok: true, teamId });
  await db.team.create({ data: { id: teamId, name: "LikeEscape", slug: randomUUID() } });
  projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "LikeEscape", slug: randomUUID() } });
  await db.task.create({ data: { id: randomUUID(), projectId, title: "alpha_beta" } });
  await db.task.create({ data: { id: randomUUID(), projectId, title: "alphaXbeta" } });
  await db.task.create({ data: { id: randomUUID(), projectId, title: "back\\slash" } });
  await db.task.create({ data: { id: randomUUID(), projectId, title: "backslash" } });
  await db.task.create({ data: { id: randomUUID(), projectId, title: "cost 50%" } });
  await db.task.create({ data: { id: randomUUID(), projectId, title: "cost 500" } });
  await db.task.create({ data: { id: randomUUID(), projectId, title: "ref-holder", externalRef: "ref_1" } });
  await db.task.create({ data: { id: randomUUID(), projectId, title: "ref-neighbour", externalRef: "refX1" } });
  await db.task.create({ data: { id: randomUUID(), projectId, title: "desc-holder", description: "under_score" } });
  await db.task.create({ data: { id: randomUUID(), projectId, title: "desc-neighbour", description: "underXscore" } });
});

describe("GET /teams/:teamId/tasks: LIKE wildcards in q match literally", () => {
  it("q=alpha_beta returns only the task titled alpha_beta, not alphaXbeta", async () => {
    expect(await search("alpha_beta")).toEqual(["alpha_beta"]);
  });

  it("q=50% returns only the task titled cost 50%, not cost 500", async () => {
    expect(await search("50%")).toEqual(["cost 50%"]);
  });

  it("a plain query without wildcards still matches every task containing it", async () => {
    expect(await search("alpha")).toEqual(["alphaXbeta", "alpha_beta"]);
  });

  it("a backslash in q matches literally: q=back\\slash returns only back\\slash, not backslash", async () => {
    expect(await search("back\\slash")).toEqual(["back\\slash"]);
  });

  it("an escaped query stays case-insensitive: q=ALPHA_beta returns only alpha_beta, not alphaXbeta", async () => {
    expect(await search("ALPHA_beta")).toEqual(["alpha_beta"]);
  });

  it("externalRef match escapes wildcards too: q=ref_1 returns only ref_1", async () => {
    expect(await search("ref_1")).toEqual(["ref-holder"]);
  });

  it("description match escapes wildcards too: q=under_score returns only under_score", async () => {
    expect(await search("under_score")).toEqual(["desc-holder"]);
  });
});
