/**
 * Grounding-enrolled counterpart of legacy-workflow-backlog.test.ts (agent-tasks
 * task ddb2417e): a stored workflow definition with initialState backlog and
 * an edge into backlog must not let the grounded writers put an enrolled task
 * into backlog.
 *
 *   - the mounted POST /abandon (grounding completion service) resets a
 *     claimed task to open, not to the stored initialState;
 *   - the mounted POST /transition along a stored edge into backlog is refused
 *     and leaves the task alone;
 *   - the direct PATCH restore of an abandoned task targets open only, never a
 *     stored initialState of backlog;
 *   - controls: promote of an enrolled backlog task still works, and a valid
 *     custom workflow keeps its own initial state for the grounded abandon.
 */
import { createHash } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { completionStore, completionFixture } from "../helpers/grounding-completion-fixtures.js";
import { ids } from "../helpers/grounding-fixtures.js";
import { createApp } from "../../src/app.js";
import { createGroundingDirectTaskRouter } from "../../src/routes/grounding-direct-tasks.js";
import { createGroundingRemoteTargetGuard } from "../../src/services/grounding-scope.js";
import type { AppVariables } from "../../src/types/hono.js";

const harness = vi.hoisted(() => ({ db: null as PrismaClient | null, wrapper: { start: vi.fn(), getLedgerSummary: vi.fn() } }));
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
vi.mock("../../src/services/grounding-client.js", () => ({ getGroundingClient: () => harness.wrapper }));
import { taskRouter } from "../../src/routes/tasks.js";

const token = "legacy-backlog-grounding-token";
const admin = { type: "human" as const, userId: ids.user, teamId: ids.team };
let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;

const legacyDefinition = {
  initialState: "backlog",
  states: [
    { name: "backlog", label: "Backlog", terminal: false },
    { name: "spec", label: "Spec", terminal: false },
    { name: "implement", label: "Implement", terminal: false },
    { name: "review", label: "Review", terminal: false },
    { name: "done", label: "Done", terminal: true },
  ],
  transitions: [
    { from: "backlog", to: "spec" },
    { from: "spec", to: "backlog", label: "Release" },
    { from: "spec", to: "implement" },
    { from: "implement", to: "review" },
    { from: "review", to: "done" },
  ],
};

async function storeWorkflow(definition: Record<string, unknown>) {
  await store.db.workflow.create({ data: { projectId: f.projectId, name: "stored", isDefault: true, definition: definition as Prisma.InputJsonValue } });
}
const setStatus = (status: string, claimed = true) =>
  store.db.task.update({
    where: { id: f.taskId },
    data: { status, claimedByAgentId: claimed ? ids.agent : null, claimedAt: claimed ? new Date() : null },
  });

function mounted() {
  const scope = { projectIds: new Set([f.projectId]), repos: new Set<string>() };
  return createApp("http://localhost", f.attempts, { db: store.db, service: f.service, scope, remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope }) });
}
function agentPost(endpoint: string, body: unknown = {}) {
  return mounted().fetch(
    new Request(`http://localhost/api/tasks/${f.taskId}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `k-${endpoint}-${Date.now()}`, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
}
function humanPatch(status: string) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", admin);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  const scope = { projectIds: new Set([f.projectId]), repos: new Set<string>() };
  app.route("/api", createGroundingDirectTaskRouter({ db: store.db, service: f.service, scope, remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope }) }));
  app.route("/api", taskRouter);
  return app.request(`/api/tasks/${f.taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "Idempotency-Key": `k-${status}-${Date.now()}` },
    body: JSON.stringify({ status }),
  });
}

beforeAll(async () => {
  store = await completionStore();
  harness.db = store.db;
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { tokenHash: createHash("sha256").update(token).digest("hex") } });
}, 60000);
afterAll(async () => {
  await store?.close();
});
beforeEach(async () => {
  vi.stubEnv("REDIS_URL", "");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("outbound fetch disabled")));
  harness.wrapper.start.mockReset().mockRejectedValue(new Error("wrapper must not run"));
  harness.wrapper.getLedgerSummary.mockReset().mockRejectedValue(new Error("legacy must not run"));
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: ["tasks:transition", "tasks:update", "tasks:claim", "tasks:read"], revokedAt: null } });
  f = await completionFixture(store);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("grounding-enrolled task on a stored legacy workflow definition", () => {
  it("the mounted abandon resets a claimed task to open, not to the stored initialState backlog", async () => {
    await storeWorkflow(legacyDefinition);
    await setStatus("spec");

    const res = await agentPost("abandon");

    expect(res.status).toBe(200);
    const row = await f.task();
    expect(row.status).toBe("open");
    expect(row.claimedByAgentId).toBeNull();
  });

  it("the mounted transition along a stored edge into backlog is refused and the task is untouched", async () => {
    await storeWorkflow(legacyDefinition);
    await setStatus("spec");

    const res = await agentPost("transition", { status: "backlog" });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("bad_state");
    const row = await f.task();
    expect(row.status).toBe("spec");
    expect(row.claimedByAgentId).toBe(ids.agent);
  });

  it("the mounted release (legacy route on an enrolled task) resets to open, not to the stored initialState", async () => {
    await storeWorkflow(legacyDefinition);
    await setStatus("implement");

    const res = await agentPost("release");

    expect(res.status).toBe(200);
    expect((await f.task()).status).toBe("open");
  });

  it("the direct admin restore of an abandoned task to a stored initialState of backlog is refused", async () => {
    await storeWorkflow(legacyDefinition);
    await setStatus("abandoned", false);

    const res = await humanPatch("backlog");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await f.task()).status).toBe("abandoned");
  });

  it("controls: promote of an enrolled backlog task works, and a valid custom workflow keeps its own initial state", async () => {
    await storeWorkflow(legacyDefinition);
    await setStatus("backlog", false);
    expect((await humanPatch("open")).status).toBe(200);
    expect((await f.task()).status).toBe("open");

    await store.db.workflow.deleteMany({ where: { projectId: f.projectId } });
    await storeWorkflow({
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "in_progress", label: "In progress", terminal: false },
        { name: "review", label: "Review", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [{ from: "open", to: "in_progress" }, { from: "in_progress", to: "done" }],
    });
    await setStatus("in_progress");
    const res = await agentPost("abandon");
    expect(res.status).toBe(200);
    expect((await f.task()).status).toBe("open");
  });
});
