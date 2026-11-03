/**
 * POST /tasks/:id/advance (task_advance) on a Grounding-provisioned task, in
 * the mounted app against a real database. The Grounding direct route serves
 * it through the Grounding mutation protocol on the transition transport:
 *
 *   - the coding-agent template walks spec -> plan -> implement -> test in
 *     EXTERNAL_V1, OFF and LEGACY_LOCAL, keeping the work claim, without a
 *     receipt (an advance target is never review-like or terminal);
 *   - the response and every refusal (work claim, advance_use_finish,
 *     advance_ambiguous, advance_target_invalid, advance_no_forward_edge,
 *     bad_state) equal the REST handler's answer for an unprovisioned twin;
 *   - the edge's workflow gates and requiredRole hold (409 precondition_failed
 *     naming the edge, a bare 403), with no operation written;
 *   - a missing task, a missing scope and a caller without (write) access get
 *     the REST handler's bodies, whether or not the task is provisioned;
 *   - the claim check and the edge choice run again under the task lock;
 *   - an Idempotency-Key replays the stored response, refuses a different
 *     body, and never crosses between /advance and /transition;
 *   - the audit row names via "task_advance";
 *   - an unprovisioned task still reaches the REST handler.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { completionStore, completionFixture } from "../helpers/grounding-completion-fixtures.js";
import { actor as agentActor, ids } from "../helpers/grounding-fixtures.js";
import { createApp } from "../../src/app.js";
import { createGroundingDirectTaskRouter } from "../../src/routes/grounding-direct-tasks.js";
import { createGroundingRemoteTargetGuard } from "../../src/services/grounding-scope.js";
import { findWorkflowTemplate } from "../../src/services/workflow-templates.js";
import { ADVANCE_WORK_CLAIM_REFUSAL } from "../../src/services/task-advance.js";
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

/* eslint-disable @typescript-eslint/no-explicit-any */
const token = "grounding-direct-advance-token";
const otherAgent = "00000000-0000-4000-8000-0000000000a1";
let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;

const codingAgent = findWorkflowTemplate("coding-agent")!.definition;
const state = (name: string, terminal = false) => ({ name, label: name, terminal });
/** spec forks into two forward work stages, lint and docs. */
const FORK = {
  initialState: "open",
  states: [state("open"), state("spec"), state("lint"), state("docs"), state("review"), state("done", true)],
  transitions: [
    { from: "open", to: "spec" }, { from: "spec", to: "lint" }, { from: "spec", to: "docs" },
    { from: "lint", to: "review" }, { from: "docs", to: "review" }, { from: "review", to: "done" },
  ],
};
/** `b` has only a backward edge and no edge into a review or terminal state. */
const STUCK = {
  initialState: "open",
  states: [state("open"), state("a"), state("b"), state("done", true)],
  transitions: [{ from: "open", to: "b" }, { from: "b", to: "open" }, { from: "a", to: "done" }],
};

async function useWorkflow(definition: unknown) {
  await store.db.workflow.deleteMany({ where: { projectId: f.projectId } });
  await store.db.workflow.create({ data: { projectId: f.projectId, name: "stored", isDefault: true, definition: definition as Prisma.InputJsonValue } });
}
const setTask = (id: string, data: Prisma.TaskUpdateInput) => store.db.task.update({ where: { id }, data });
const claimedBy = (agent: string | null) => ({ claimedByAgentId: agent, claimedAt: agent ? new Date() : null });
/** An unprovisioned task in the same project and state: the REST handler answers it. */
async function twin(status: string, data: Record<string, unknown> = {}) {
  const id = randomUUID();
  await store.db.task.create({
    data: {
      id, projectId: f.projectId, title: "Twin", description: "Unprovisioned", status, createdByAgentId: ids.agent,
      branchName: "branch", prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42", ...claimedBy(ids.agent), ...data,
    },
  });
  return id;
}

function mounted() {
  const scope = { projectIds: new Set([f.projectId]), repos: new Set<string>() };
  return createApp("http://localhost", f.attempts, { db: store.db, service: f.service, scope, remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope }) });
}
async function call(taskId: string, endpoint: "advance" | "transition", body: unknown = {}, key: string | null = `k-${randomUUID()}`) {
  const res = await mounted().fetch(
    new Request(`http://localhost/api/tasks/${taskId}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(key ? { "Idempotency-Key": key } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}
const advance = (taskId: string, body: unknown = {}, key?: string | null) => call(taskId, "advance", body, key);
const operations = (taskId: string) => store.db.groundingOperation.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } });
const transitionAudits = async (taskId: string) =>
  (await store.db.auditLog.findMany({ where: { taskId, action: "task.transitioned" }, orderBy: { createdAt: "asc" } })).map(a => a.payload as Record<string, unknown>);
const withoutTask = ({ task: _task, ...rest }: Record<string, unknown>) => rest;

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
  await useWorkflow(codingAgent);
  await setTask(f.taskId, { status: "spec" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("modes", () => {
  it("EXTERNAL_V1: spec -> plan -> implement -> test through the protocol, keeping the work claim, with no receipt", async () => {
    const plan = await advance(f.taskId);
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toMatchObject({ kind: "work", previousStatus: "spec", targetStatus: "plan", advanceTargets: ["implement"], expectedFinishState: null, effectiveGates: { finish: null }, task: { status: "plan" } });
    const implement = await advance(f.taskId, { to: "implement" });
    expect(implement.status, JSON.stringify(implement.body)).toBe(200);
    expect(implement.body).toMatchObject({ previousStatus: "plan", targetStatus: "implement", advanceTargets: ["test"] });
    const test = await advance(f.taskId);
    expect(test.status, JSON.stringify(test.body)).toBe(200);
    expect(test.body).toMatchObject({ previousStatus: "implement", targetStatus: "test", advanceTargets: [], expectedFinishState: "review", effectiveGates: { finish: ["branchPresent", "prPresent"] } });

    expect(await f.task()).toMatchObject({ status: "test", claimedByAgentId: ids.agent });
    const ops = await operations(f.taskId);
    expect(ops.map(o => [o.state, (o.decision as any).mode, (o.decision as any).to])).toEqual([["COMPLETED", "EXTERNAL_V1", "plan"], ["COMPLETED", "EXTERNAL_V1", "implement"], ["COMPLETED", "EXTERNAL_V1", "test"]]);
    const snapshot = await f.snapshot();
    expect(snapshot.attempts).toEqual([]);
    expect(snapshot.receipts).toEqual([]);
    expect(snapshot.finalizations).toEqual([]);

    // From test the only forward edge leads into review: task_finish's move.
    const finish = await advance(f.taskId);
    expect(finish.status).toBe(409);
    expect(finish.body).toMatchObject({ error: "advance_use_finish", from: "test", finishTarget: "review", choices: [] });
  });

  it.each(["OFF", "LEGACY_LOCAL"] as const)("%s: the advance runs through the protocol without the ledger", async mode => {
    f = await completionFixture(store, mode);
    await useWorkflow(codingAgent);
    await setTask(f.taskId, { status: "spec" });
    const res = await advance(f.taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: "work", previousStatus: "spec", targetStatus: "plan" });
    expect((await f.task()).status).toBe("plan");
    expect((await operations(f.taskId)).map(o => (o.decision as any).mode)).toEqual([mode]);
    expect(f.ledger.getLedgerSummary).not.toHaveBeenCalled();
    expect(harness.wrapper.getLedgerSummary).not.toHaveBeenCalled();
  });

  it("an unprovisioned task still reaches the REST handler: no Grounding operation, and its own replay marker", async () => {
    const plain = await twin("spec");
    const first = await advance(plain, {}, "plain-key");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.targetStatus).toBe("plan");
    const replay = await advance(plain, {}, "plain-key");
    expect(replay.status).toBe(200);
    expect(replay.body._idempotent_replay).toBe(true);
    expect(replay.headers.get("x-idempotent-replay")).toBe("true");
    expect(await operations(plain)).toEqual([]);
    expect((await store.db.task.findUniqueOrThrow({ where: { id: plain } })).status).toBe("plan");
  });
});

describe("the same answer as the REST handler", () => {
  it("the success response carries the same fields and values", async () => {
    const plain = await twin("spec");
    const grounded = await advance(f.taskId);
    const legacy = await advance(plain);
    expect(grounded.status, JSON.stringify(grounded.body)).toBe(200);
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(200);
    expect(Object.keys(grounded.body).sort()).toEqual(Object.keys(legacy.body).sort());
    expect(withoutTask(grounded.body)).toEqual(withoutTask(legacy.body));
    expect(grounded.body.task).toMatchObject({ id: f.taskId, status: "plan", claimedByAgentId: ids.agent });
  });

  it.each([
    { label: "a review target", definition: codingAgent, status: "implement", body: { to: "review" }, error: "advance_use_finish" },
    { label: "a terminal target", definition: codingAgent, status: "test", body: { to: "done" }, error: "advance_use_finish" },
    { label: "the only forward edge leads into review", definition: codingAgent, status: "test", body: {}, error: "advance_use_finish" },
    { label: "a task in the review state", definition: codingAgent, status: "review", body: {}, error: "advance_use_finish" },
    { label: "a backward edge", definition: codingAgent, status: "plan", body: { to: "spec" }, error: "advance_target_invalid" },
    { label: "several forward edges and no `to`", definition: FORK, status: "spec", body: {}, error: "advance_ambiguous" },
    { label: "neither a forward nor a finish edge", definition: STUCK, status: "b", body: {}, error: "advance_no_forward_edge" },
    { label: "the initial state", definition: codingAgent, status: "open", body: {}, error: "bad_state" },
  ])("$label: 409 $error with the REST body, nothing written", async ({ definition, status, body, error }) => {
    await useWorkflow(definition);
    await setTask(f.taskId, { status });
    const plain = await twin(status);
    const before = await f.snapshot();
    const grounded = await advance(f.taskId, body);
    const legacy = await advance(plain, body);
    expect(grounded.status).toBe(409);
    expect(grounded.body.error).toBe(error);
    expect(legacy.status).toBe(409);
    expect(grounded.body).toEqual(legacy.body);
    expect(await f.snapshot()).toEqual(before);
  });

  it.each([
    { label: "an unclaimed task", data: claimedBy(null) },
    { label: "a review claim alone", data: { ...claimedBy(null), reviewClaimedByAgentId: ids.agent, reviewClaimedAt: new Date() } },
  ])("$label: 403 naming task_start, as the REST handler answers", async ({ data }) => {
    await setTask(f.taskId, data);
    const plain = await twin("spec", data);
    const before = await f.snapshot();
    const grounded = await advance(f.taskId);
    const legacy = await advance(plain);
    expect(grounded.status).toBe(403);
    expect(grounded.body).toEqual({ error: "forbidden", message: ADVANCE_WORK_CLAIM_REFUSAL });
    expect(legacy.status).toBe(403);
    expect(grounded.body).toEqual(legacy.body);
    expect(await f.snapshot()).toEqual(before);
  });

  it("an agent token without tasks:transition gets the REST handler's scope refusal, nothing written", async () => {
    await store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: ["tasks:read", "tasks:claim"] } });
    const before = await f.snapshot();
    const res = await advance(f.taskId);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", message: "Missing scope: tasks:transition" });
    expect(await f.snapshot()).toEqual(before);
  });

  it("a malformed `to` is a 400 bad_request, as the REST handler answers, nothing written", async () => {
    const plain = await twin("spec");
    const before = await f.snapshot();
    const grounded = await advance(f.taskId, { to: "Not A State" });
    const legacy = await advance(plain, { to: "Not A State" });
    expect(grounded.status).toBe(400);
    expect(grounded.body.error).toBe("bad_request");
    expect(grounded.body).toEqual(legacy.body);
    expect(await f.snapshot()).toEqual(before);
  });
});

describe("workflow gates and roles on the edge", () => {
  it("plan -> implement without a branch: 409 precondition_failed naming the edge, no operation, nothing written (the REST twin answers 422)", async () => {
    await setTask(f.taskId, { status: "plan", branchName: null });
    const plain = await twin("plan", { branchName: null });
    const before = await f.snapshot();
    const grounded = await advance(f.taskId);
    const legacy = await advance(plain);
    expect(grounded.status).toBe(409);
    expect(grounded.body).toEqual({ error: "precondition_failed", message: "Transition blocked: a workflow gate on plan -> implement is not met (this edge requires branchPresent)" });
    expect(legacy.status).toBe(422);
    expect(legacy.body.failed.map((r: any) => r.rule)).toEqual(["branchPresent"]);
    expect(await operations(f.taskId)).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
  });

  it("an edge whose requiredRole the caller lacks: a bare 403, no operation, nothing written (the REST twin names the role)", async () => {
    await useWorkflow({ ...codingAgent, transitions: codingAgent.transitions.map(t => (t.from === "spec" && t.to === "plan" ? { ...t, requiredRole: "ADMIN" } : t)) });
    const plain = await twin("spec");
    const before = await f.snapshot();
    const grounded = await advance(f.taskId);
    const legacy = await advance(plain);
    expect(grounded.status).toBe(403);
    expect(grounded.body).toEqual({ error: "forbidden" });
    expect(legacy.status).toBe(403);
    expect(legacy.body).toEqual({ error: "forbidden", message: "Requires role: ADMIN" });
    expect(await operations(f.taskId)).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
  });
});

describe("refusals before the enrollment is read keep the REST bodies", () => {
  it("a task that does not exist: 404 Resource not found", async () => {
    const res = await advance(randomUUID());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found", message: "Resource not found" });
  });

  it("an agent token without tasks:transition on a task that does not exist: the scope refusal comes first, as in the REST handler", async () => {
    await store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: ["tasks:read", "tasks:claim"] } });
    const res = await advance(randomUUID());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", message: "Missing scope: tasks:transition" });
  });

  it("an unprovisioned task in another team's project: 403 Access denied to this project, nothing written", async () => {
    const teamId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    await store.db.team.create({ data: { id: teamId, name: "Elsewhere", slug: `elsewhere-${teamId}` } });
    await store.db.project.create({ data: { id: projectId, teamId, name: "Elsewhere", slug: randomUUID() } });
    await store.db.task.create({ data: { id: taskId, projectId, title: "Foreign", status: "spec", createdByAgentId: ids.agent, ...claimedBy(ids.agent) } });
    const res = await advance(taskId);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", message: "Access denied to this project" });
    expect((await store.db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("spec");
  });

  it.each(["provisioned", "unprovisioned"] as const)("a project viewer on a %s task: 403 Requires write access, answered by the Grounding route", async kind => {
    const viewer = randomUUID();
    await store.db.user.create({ data: { id: viewer, login: `viewer-${viewer}` } });
    await store.db.projectMember.create({ data: { projectId: f.projectId, userId: viewer, role: "PROJECT_VIEWER", invitedById: ids.user } });
    const taskId = kind === "provisioned" ? f.taskId : await twin("spec");
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("actor", { type: "human", userId: viewer });
      c.set("groundingRemoteTargetGuard", null);
      await next();
    });
    const scope = { projectIds: new Set([f.projectId]), repos: new Set<string>() };
    app.route("/api", createGroundingDirectTaskRouter({ db: store.db, service: f.service, scope, remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope }) }));
    app.post("/api/tasks/:id/advance", c => c.json({ error: "fell_through" }, 418));
    const res = await app.request(`/api/tasks/${taskId}/advance`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": `k-${randomUUID()}` }, body: "{}" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", message: "Requires write access (PROJECT_VIEWER is read-only)" });
    expect((await store.db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("spec");
  });
});

describe("under the task lock", () => {
  // The route reads the task unlocked; a proxy serves that one read stale, as
  // if another writer changed the row between the read and the lock.
  function staleRead(stale: Record<string, unknown>) {
    let served = false;
    const passthrough = (target: object) => (key: string | symbol) => {
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    };
    const task = new Proxy(store.db.task, {
      get: (target, key) => key === "findUnique"
        ? async (args: Parameters<typeof target.findUnique>[0]) => {
          const row = await target.findUnique(args);
          if (served || !row) return row;
          served = true;
          return { ...row, ...stale };
        }
        : passthrough(target)(key),
    });
    const db = new Proxy(store.db, { get: (target, key) => (key === "task" ? task : passthrough(target)(key)) }) as PrismaClient;
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("actor", agentActor);
      c.set("groundingRemoteTargetGuard", null);
      await next();
    });
    const scope = { projectIds: new Set([f.projectId]), repos: new Set<string>() };
    app.route("/api", createGroundingDirectTaskRouter({ db, service: f.service, scope, remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope }) }));
    return async (body: unknown = {}) => {
      const res = await app.request(`/api/tasks/${f.taskId}/advance`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": `k-${randomUUID()}` }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
  }

  it("a task that moved on before the lock is not moved by the edge chosen from the stale read", async () => {
    // Unlocked it reads spec (advance to plan); locked it is at implement,
    // where implement -> plan is a backward edge an advance never takes.
    await setTask(f.taskId, { status: "implement" });
    const before = await f.snapshot();
    const res = await staleRead({ status: "spec" })();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("bad_state");
    expect(await f.snapshot()).toEqual(before);
  });

  it("a work claim released before the lock refuses with the claim message", async () => {
    await setTask(f.taskId, claimedBy(null));
    const before = await f.snapshot();
    const res = await staleRead({ claimedByAgentId: ids.agent })();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", message: ADVANCE_WORK_CLAIM_REFUSAL });
    expect(await f.snapshot()).toEqual(before);
  });
});

describe("Idempotency-Key", () => {
  it("a same-key retry replays the stored response unchanged and advances once", async () => {
    const first = await advance(f.taskId, {}, "advance-1");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const retry = await advance(f.taskId, {}, "advance-1");
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect((await f.task()).status).toBe("plan");
    expect(await operations(f.taskId)).toHaveLength(1);
    expect(await transitionAudits(f.taskId)).toHaveLength(1);
  });

  it("the replay does not depend on where the task is now: it returns the first move after later ones", async () => {
    const first = await advance(f.taskId, {}, "advance-a");
    expect(first.body.targetStatus).toBe("plan");
    expect((await advance(f.taskId, {}, "advance-b")).body.targetStatus).toBe("implement");
    const retry = await advance(f.taskId, {}, "advance-a");
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect((await f.task()).status).toBe("implement");
  });

  it("the same key with a different body is 409 grounding_operation_conflict", async () => {
    expect((await advance(f.taskId, {}, "advance-2")).status).toBe(200);
    const other = await advance(f.taskId, { to: "plan" }, "advance-2");
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("grounding_operation_conflict");
    expect((await f.task()).status).toBe("plan");
    expect(await operations(f.taskId)).toHaveLength(1);
  });

  it("a key first used by /transition is refused on /advance to the same target, not replayed", async () => {
    const transition = await call(f.taskId, "transition", { status: "plan" }, "shared-1");
    expect(transition.status, JSON.stringify(transition.body)).toBe(200);
    const res = await advance(f.taskId, {}, "shared-1");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("grounding_operation_conflict");
    expect(res.body).not.toHaveProperty("previousStatus");
    expect((await f.task()).status).toBe("plan");
    expect(await operations(f.taskId)).toHaveLength(1);
  });

  it("a key first used by /advance is refused on /transition to the same target, not replayed", async () => {
    const first = await advance(f.taskId, {}, "shared-2");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const res = await call(f.taskId, "transition", { status: "plan" }, "shared-2");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("grounding_operation_conflict");
    expect(res.body).not.toHaveProperty("previousStatus");
    expect((await f.task()).status).toBe("plan");
    expect(await operations(f.taskId)).toHaveLength(1);
  });

  it("a key another caller used is refused with 403 before the claim is looked at", async () => {
    const otherToken = "grounding-direct-advance-other";
    await store.db.agentToken.upsert({
      where: { id: otherAgent },
      create: { id: otherAgent, teamId: ids.team, createdById: ids.user, name: "Other", tokenHash: createHash("sha256").update(otherToken).digest("hex"), scopes: ["tasks:transition", "tasks:read"] },
      update: { revokedAt: null },
    });
    expect((await advance(f.taskId, {}, "mine")).status).toBe(200);
    const res = await mounted().fetch(new Request(`http://localhost/api/tasks/${f.taskId}/advance`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}`, "Idempotency-Key": "mine" }, body: "{}",
    }));
    expect(res.status).toBe(403);
    // The key refusal, not the claim refusal (which names task_start).
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect((await f.task()).status).toBe("plan");
    expect(await operations(f.taskId)).toHaveLength(1);
  });

  it("without a key every call executes and is judged on the state it finds", async () => {
    expect((await advance(f.taskId, {}, null)).body.targetStatus).toBe("plan");
    expect((await advance(f.taskId, {}, null)).body.targetStatus).toBe("implement");
    expect(await operations(f.taskId)).toHaveLength(2);
  });
});

describe("audit", () => {
  it("the grounded advance audits task.transitioned via task_advance; a plain /transition keeps via transition", async () => {
    expect((await advance(f.taskId)).status).toBe(200);
    expect((await call(f.taskId, "transition", { status: "spec" })).status).toBe(200);
    expect(await transitionAudits(f.taskId)).toEqual([
      { from: "spec", to: "plan", actorType: "agent", via: "task_advance" },
      { from: "plan", to: "spec", actorType: "agent", via: "transition" },
    ]);
  });
});
