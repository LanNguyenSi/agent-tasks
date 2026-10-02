/**
 * Pins the current behaviour of the human "demote" PATCH (open -> backlog) for
 * a grounding-enrolled task (agent-tasks task 7c64e80c): the direct-route
 * middleware intercepts the PATCH and its resolver has no demote case, so the
 * request answers 409 bad_state and the task stays open. Grounded demote is a
 * follow-up; this test makes the limitation explicit and fails loudly when it
 * changes. The promote of an enrolled backlog task is the control.
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

describe("demote of a grounding-enrolled task", () => {
  it("answers 409 bad_state and leaves an open, unclaimed enrolled task open (grounded demote is not supported yet)", async () => {
    await store.db.task.update({ where: { id: f.taskId }, data: { status: "open", claimedByAgentId: null, claimedAt: null } });
    const res = await patch(f.taskId, "backlog");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("bad_state");
    expect((await f.task()).status).toBe("open");
  });

  it("control: promote of an enrolled backlog task still works", async () => {
    await store.db.task.update({ where: { id: f.taskId }, data: { status: "backlog", claimedByAgentId: null, claimedAt: null } });
    const res = await patch(f.taskId, "open");
    expect(res.status).toBe(200);
    expect((await f.task()).status).toBe("open");
  });
});
