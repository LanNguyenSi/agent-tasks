/**
 * Human "demote" PATCH (open -> backlog) for a grounding-enrolled task
 * (agent-tasks task bf896c1d). The direct-route middleware intercepts the
 * PATCH; the demote follows the REST demote rules: only an open, fully
 * unclaimed task moves, with the audit event task.backlog_demoted and every
 * pending signal acknowledged. The promote of an enrolled backlog task is the
 * control.
 */
import { type PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { completionStore, completionFixture } from "../helpers/grounding-completion-fixtures.js";
import { ids } from "../helpers/grounding-fixtures.js";
import { createGroundingDirectTaskRouter } from "../../src/routes/grounding-direct-tasks.js";
import { createGroundingRemoteTargetGuard } from "../../src/services/grounding-scope.js";
import type { AppVariables } from "../../src/types/hono.js";

const harness = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, p) => {
        const v = Reflect.get(harness.db!, p);
        return typeof v === "function" ? v.bind(harness.db) : v;
      },
    },
  ),
}));
vi.mock("../../src/config/index.js", () => ({
  config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 },
}));
import { taskRouter } from "../../src/routes/tasks.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
const admin = { type: "human" as const, userId: ids.user, teamId: ids.team };

beforeAll(async () => {
  store = await completionStore();
  harness.db = store.db;
}, 60000);
afterAll(async () => {
  await store?.close();
});
beforeEach(async () => {
  vi.stubEnv("REDIS_URL", "");
  f = await completionFixture(store);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function patch(taskId: string, status: string) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", admin);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  const scope = { projectIds: new Set([f.projectId]), repos: new Set<string>() };
  app.route(
    "/api",
    createGroundingDirectTaskRouter({ db: store.db, service: f.service, scope, remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope }) }),
  );
  app.route("/api", taskRouter);
  return app.request(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "Idempotency-Key": `k-${status}-${Date.now()}` },
    body: JSON.stringify({ status }),
  });
}

const CLAIM_MESSAGE = "Task must be open with no work or review claim to move it back to backlog";
const claimColumns = {
  claimedByAgentId: { claimedByAgentId: ids.agent },
  claimedByUserId: { claimedByUserId: ids.user },
  reviewClaimedByAgentId: { reviewClaimedByAgentId: ids.agent },
  reviewClaimedByUserId: { reviewClaimedByUserId: ids.user },
} as const;

async function openUnclaimed() {
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "open", claimedByAgentId: null, claimedAt: null } });
}
async function pendingSignal() {
  return store.db.signal.create({ data: { type: "task_available", taskId: f.taskId, projectId: f.projectId, recipientAgentId: ids.agent, context: {} } });
}

describe("demote of a grounding-enrolled task", () => {
  it("moves an open, unclaimed enrolled task to backlog, audits task.backlog_demoted and acknowledges pending signals", async () => {
    await openUnclaimed();
    const signal = await pendingSignal();
    const res = await patch(f.taskId, "backlog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { status: string } };
    expect(body.task.status).toBe("backlog");
    expect((await f.task()).status).toBe("backlog");
    const audit = await store.db.auditLog.findMany({ where: { taskId: f.taskId, action: "task.backlog_demoted" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({ from: "open", to: "backlog", actorType: "human", via: "patch" });
    expect((await store.db.signal.findUniqueOrThrow({ where: { id: signal.id } })).acknowledgedAt).not.toBeNull();
  });

  it.each(Object.keys(claimColumns) as Array<keyof typeof claimColumns>)("answers 409 with the claim message and changes nothing when %s is set", async column => {
    await openUnclaimed();
    await store.db.task.update({ where: { id: f.taskId }, data: claimColumns[column] });
    const signal = await pendingSignal();
    const res = await patch(f.taskId, "backlog");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toBe(CLAIM_MESSAGE);
    expect((await f.task()).status).toBe("open");
    expect(await store.db.auditLog.count({ where: { taskId: f.taskId, action: "task.backlog_demoted" } })).toBe(0);
    expect((await store.db.signal.findUniqueOrThrow({ where: { id: signal.id } })).acknowledgedAt).toBeNull();
  });

  it("refuses inside the locked write when a claim lands after the route read (service-level race)", async () => {
    await openUnclaimed();
    await store.db.task.update({ where: { id: f.taskId }, data: { claimedByAgentId: ids.agent } });
    const transport = { endpoint: "patch" as const, body: { status: "backlog" } };
    await expect(
      f.service.dispose(f.taskId, admin, "race-key", { action: "transition", route: { kind: "direct", transport, direct: { version: 1, endpoint: "patch", target: "backlog" } } }),
    ).rejects.toMatchObject({ code: "bad_state", status: 409, message: CLAIM_MESSAGE });
    expect((await f.task()).status).toBe("open");
  });

  it.each(["in_progress", "abandoned"])("refuses inside the locked write with the REST text when the locked row is %s and unclaimed (status race)", async from => {
    await store.db.task.update({ where: { id: f.taskId }, data: { status: from, claimedByAgentId: null, claimedAt: null } });
    const signal = await pendingSignal();
    const transport = { endpoint: "patch" as const, body: { status: "backlog" } };
    await expect(
      f.service.dispose(f.taskId, admin, `status-race-${from}`, { action: "transition", route: { kind: "direct", transport, direct: { version: 1, endpoint: "patch", target: "backlog" } } }),
    ).rejects.toMatchObject({ code: "bad_state", status: 409, message: CLAIM_MESSAGE });
    expect((await f.task()).status).toBe(from);
    expect(await store.db.auditLog.count({ where: { taskId: f.taskId, action: "task.backlog_demoted" } })).toBe(0);
    expect((await store.db.signal.findUniqueOrThrow({ where: { id: signal.id } })).acknowledgedAt).toBeNull();
  });

  it.each(["in_progress", "review", "abandoned"])("answers 400 for a demote from %s", async from => {
    await store.db.task.update({ where: { id: f.taskId }, data: { status: from, claimedByAgentId: null, claimedAt: null } });
    const res = await patch(f.taskId, "backlog");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toBe(`Transition from '${from}' to 'backlog' is not allowed; only an open task can be moved back to backlog`);
    expect((await f.task()).status).toBe(from);
  });

  it("control: promote of an enrolled backlog task still works", async () => {
    await store.db.task.update({ where: { id: f.taskId }, data: { status: "backlog", claimedByAgentId: null, claimedAt: null } });
    const res = await patch(f.taskId, "open");
    expect(res.status).toBe(200);
    expect((await f.task()).status).toBe("open");
  });
});
