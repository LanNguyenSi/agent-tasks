/**
 * Real-database test for the backend-hosted `tasks_list` tool with a cursor
 * that names no task (task 2bf1b70a). The tool forwards `cursor` to the real
 * `GET /api/tasks/claimable` route; Prisma's cursor seek on a plain string id
 * that matches no row yields an empty page, which the route reports as
 * `{ tasks: [], nextCursor: null, truncated: false }`. Needs a test database
 * (see `groundingPostgres`).
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
import { mcpRouter, setApp } from "../../src/routes/mcp.js";

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
  app.route("/api/mcp", mcpRouter);
  app.route("/api", taskRouter);
  setApp(app);
  return app;
}

async function callTasksList(app: Hono<{ Variables: AppVariables }>, args: Record<string, unknown>) {
  const res = await app.fetch(
    new Request("http://127.0.0.1/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer good_token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tasks_list", arguments: args },
      }),
    }),
  );
  expect(res.status).toBe(200);
  const raw = await res.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
  const rpc = JSON.parse(dataLine ? dataLine.slice(6) : raw) as {
    result: { content: Array<{ text: string }> };
  };
  return JSON.parse(rpc.result.content[0].text) as {
    tasks: { id: string }[];
    nextCursor: string | null;
    truncated: boolean;
  };
}

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let projectId: string;

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
  await db.team.create({ data: { id: teamId, name: "Cursor", slug: randomUUID() } });
  projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "Cursor", slug: randomUUID() } });
});

describe("hosted tasks_list with a cursor that names no task (task 2bf1b70a)", () => {
  it("returns an empty page with truncated false and nextCursor null, while open tasks exist", async () => {
    const ids = [randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries()) {
      await db.task.create({ data: { id, projectId, title: `Task ${i}`, status: "open" } });
    }
    const app = makeApp();

    // Control: without a cursor the same call sees both open tasks.
    const all = await callTasksList(app, { projectId });
    expect(all.tasks.map((t) => t.id).sort()).toEqual([...ids].sort());

    const unknown = await callTasksList(app, { projectId, cursor: randomUUID() });
    expect(unknown).toEqual({ tasks: [], nextCursor: null, truncated: false });

    const malformed = await callTasksList(app, { projectId, cursor: "not-a-task-id" });
    expect(malformed).toEqual({ tasks: [], nextCursor: null, truncated: false });
  });
});
