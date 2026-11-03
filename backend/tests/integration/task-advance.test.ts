/**
 * POST /tasks/:id/advance (the v2 `task_advance` verb) against a real
 * database: which edge it takes, what it refuses, and that it reuses the
 * finish route's gates, compare-and-swap and audit. The coding-agent template
 * flow itself lives in coding-agent-template-e2e.test.ts; this file pins the
 * verb's own rules on small custom definitions and on the built-in four-state
 * workflow.
 *
 * Forward means the target is listed later in the definition's states than the
 * current state. A review-like or terminal target is always task_finish's move.
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

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
  resolveTeamId: vi.fn().mockResolvedValue({ ok: true, teamId: "team-1" }),
  resolveTeamIdErrorBody: vi.fn(),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);

const audit = vi.hoisted(() => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/audit.js")>()),
  logAuditEvent: audit.logAuditEvent,
}));
const signals = vi.hoisted(() => ({
  emitReviewSignal: vi.fn().mockResolvedValue(undefined),
  emitChangesRequestedSignal: vi.fn().mockResolvedValue(undefined),
  emitTaskApprovedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/review-signal.js", () => signals);
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
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));
// A hook into the gate evaluation: a test can run a write between the gate
// and the status write (a concurrent writer) to exercise the compare-and-swap.
const gateHook = vi.hoisted(() => ({ during: null as null | (() => Promise<void>) }));
vi.mock("../../src/services/transition-rules.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/services/transition-rules.js")>();
  return {
    ...original,
    evaluateTransitionRules: async (...args: Parameters<typeof original.evaluateTransitionRules>) => {
      if (gateHook.during) await gateHook.during();
      return original.evaluateTransitionRules(...args);
    },
  };
});

import { taskRouter } from "../../src/routes/tasks.js";

const JSON_HEADERS = { "content-type": "application/json" };

/* eslint-disable @typescript-eslint/no-explicit-any */
let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let projectId: string;
let authorId: string;
let otherId: string;
let author: Actor;
let other: Actor;

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}
async function post(actor: Actor, path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await makeApp(actor).request(path, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}
const advance = (actor: Actor, taskId: string, body: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  post(actor, `/tasks/${taskId}/advance`, body, headers);

const row = (id: string) => db.task.findUniqueOrThrow({ where: { id } });
const advanceAudits = () =>
  audit.logAuditEvent.mock.calls
    .map(([event]) => event as { action: string; payload: Record<string, unknown> })
    .filter((e) => e.action === "task.transitioned" && e.payload.via === "task_advance");

async function seedUser() {
  const id = randomUUID();
  await db.user.create({ data: { id, login: `u-${id}` } });
  return id;
}

/** A task in `status`, work-claimed by the author, optionally pinned to its own workflow definition. */
async function seedTask(status: string, definition?: unknown, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  let workflowId: string | null = null;
  if (definition !== undefined) {
    workflowId = randomUUID();
    await db.workflow.create({ data: { id: workflowId, projectId, name: `wf-${workflowId.slice(0, 8)}`, isDefault: false, definition: definition as never } });
  }
  await db.task.create({
    data: {
      id, projectId, title: "Advance", description: "Seeded.", status, createdByUserId: authorId,
      claimedByUserId: authorId, claimedAt: new Date(), workflowId, ...overrides,
    },
  });
  return id;
}

const state = (name: string, terminal = false) => ({ name, label: name, terminal });

/** open -> spec -> plan -> build -> review -> done, plan gated on a branch, with backward and release edges. */
const PIPELINE = {
  initialState: "open",
  states: [state("open"), state("spec"), state("plan"), state("build"), state("review"), state("done", true)],
  transitions: [
    { from: "open", to: "spec" },
    { from: "spec", to: "plan" },
    { from: "spec", to: "open" },
    { from: "plan", to: "build", requires: ["branchPresent"] },
    { from: "plan", to: "spec" },
    { from: "build", to: "review", requires: ["branchPresent", "prPresent"] },
    { from: "build", to: "plan" },
    { from: "review", to: "done" },
    { from: "review", to: "build" },
  ],
};

/** spec forks into two forward work stages, lint and docs. */
const FORK = {
  initialState: "open",
  states: [state("open"), state("spec"), state("lint"), state("docs"), state("review"), state("done", true)],
  transitions: [
    { from: "open", to: "spec" },
    { from: "spec", to: "lint" },
    { from: "spec", to: "docs" },
    { from: "lint", to: "review" },
    { from: "docs", to: "review" },
    { from: "review", to: "done" },
  ],
};

/** `b` has only a backward edge and no edge into a review or terminal state. */
const STUCK = {
  initialState: "open",
  states: [state("open"), state("a"), state("b"), state("done", true)],
  transitions: [
    { from: "open", to: "b" },
    { from: "b", to: "open" },
    { from: "a", to: "done" },
  ],
};

/** A review state listed before the work state: in_progress -> review is not a forward move. */
const REVIEW_FIRST = {
  initialState: "open",
  states: [state("open"), state("review"), state("in_progress"), state("done", true)],
  transitions: [
    { from: "open", to: "in_progress" },
    { from: "in_progress", to: "review" },
    { from: "review", to: "done" },
  ],
};

/** The initial state `open` is listed after the work stage `spec`, and `spec` has an edge back to it. */
const OPEN_LATE = {
  initialState: "open",
  states: [state("spec"), state("open"), state("review"), state("done", true)],
  transitions: [
    { from: "open", to: "spec" },
    { from: "spec", to: "open" },
    { from: "review", to: "done" },
  ],
};

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
  gateHook.during = null;
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);
  authorId = await seedUser();
  otherId = await seedUser();
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Advance", slug: randomUUID() } });
  for (const userId of [authorId, otherId]) await db.teamMember.create({ data: { teamId, userId, role: "HUMAN_MEMBER" } });
  accessMocks.resolveTeamId.mockResolvedValue({ ok: true, teamId });
  projectId = randomUUID();
  await db.project.create({
    data: { id: projectId, teamId, name: "P", slug: randomUUID(), githubRepo: "acme/thing", governanceMode: "AWAITS_CONFIRMATION" },
  });
  author = { type: "human", userId: authorId, teamId };
  other = { type: "human", userId: otherId, teamId };
});

describe("target selection", () => {
  it("without `to`, takes the single forward edge to a work stage, keeps the work claim and audits via task_advance", async () => {
    const taskId = await seedTask("spec", PIPELINE);
    const res = await advance(author, taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: "work", previousStatus: "spec", targetStatus: "plan", advanceTargets: ["build"], expectedFinishState: null, effectiveGates: { finish: null } });
    expect(await row(taskId)).toMatchObject({ status: "plan", claimedByUserId: authorId });
    expect(advanceAudits().map((e) => e.payload)).toEqual([{ from: "spec", to: "plan", actorType: "human", via: "task_advance" }]);
    expect(signals.emitReviewSignal).not.toHaveBeenCalled();
  });

  it("previews the finish from the stage it reached: build -> review with its gates", async () => {
    const taskId = await seedTask("plan", PIPELINE, { branchName: "feat/x" });
    const res = await advance(author, taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ targetStatus: "build", expectedFinishState: "review", effectiveGates: { finish: ["branchPresent", "prPresent"] }, advanceTargets: [] });
  });

  it("several forward edges and no `to`: 409 advance_ambiguous listing the choices, nothing written", async () => {
    const taskId = await seedTask("spec", FORK);
    const res = await advance(author, taskId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "advance_ambiguous", from: "spec", choices: ["lint", "docs"] });
    expect(res.body.message).toContain("'lint', 'docs'");
    expect((await row(taskId)).status).toBe("spec");
    expect(advanceAudits()).toEqual([]);
  });

  it.each(["lint", "docs"])("several forward edges and `to: %s`: the requested edge wins", async (to) => {
    const taskId = await seedTask("spec", FORK);
    const res = await advance(author, taskId, { to });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.targetStatus).toBe(to);
    expect((await row(taskId)).status).toBe(to);
  });

  it("a single forward edge and a matching `to`: takes it", async () => {
    const taskId = await seedTask("spec", PIPELINE);
    const res = await advance(author, taskId, { to: "plan" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await row(taskId)).status).toBe("plan");
  });

  it.each([
    { to: "open", label: "a backward edge (the release edge)" },
    { to: "build", label: "a later stage without a direct edge" },
    { to: "nonexistent", label: "a state the workflow does not have" },
    { to: "spec", label: "the current state" },
  ])("`to` naming $label: 409 advance_target_invalid with the real choices", async ({ to }) => {
    const taskId = await seedTask("spec", PIPELINE);
    const res = await advance(author, taskId, { to });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "advance_target_invalid", from: "spec", requested: to, choices: ["plan"] });
    expect((await row(taskId)).status).toBe("spec");
  });

  it("a malformed `to` is a 400 before anything is looked up", async () => {
    const taskId = await seedTask("spec", PIPELINE);
    const res = await advance(author, taskId, { to: "Not A State" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    expect((await row(taskId)).status).toBe("spec");
  });
});

describe("review and terminal targets are task_finish's", () => {
  it.each([
    { to: "review", kind: "review" },
    { to: "done", kind: "terminal" },
  ])("`to: $to` from `build` is refused with 409 advance_use_finish pointing at task_finish", async ({ to, kind }) => {
    const taskId = await seedTask("build", PIPELINE);
    const res = await advance(author, taskId, { to });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "advance_use_finish", from: "build", requested: to, finishTarget: "review", choices: [] });
    expect(res.body.message).toContain(`is a ${kind} state`);
    expect(res.body.message).toContain("Call task_finish, which moves the task from 'build' to 'review'.");
    expect((await row(taskId)).status).toBe("build");
  });

  it("no `to` from a stage whose only forward edge leads into review: 409 advance_use_finish naming the finish target", async () => {
    const taskId = await seedTask("build", PIPELINE);
    const res = await advance(author, taskId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "advance_use_finish", from: "build", finishTarget: "review", choices: [] });
    expect(res.body).not.toHaveProperty("requested");
  });

  it("a review target from a stage that cannot finish either says so and lists the advance targets", async () => {
    const taskId = await seedTask("spec", PIPELINE);
    const res = await advance(author, taskId, { to: "review" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "advance_use_finish", finishTarget: null, choices: ["plan"] });
    expect(res.body.message).toContain("task_finish has no edge from 'spec' either.");
    expect(res.body.message).toContain("task_advance can move it to 'plan'.");
  });

  it("a task sitting in a review state (work claim kept after the finish) is refused: the review is decided by task_finish", async () => {
    const taskId = await seedTask("review", PIPELINE);
    const res = await advance(author, taskId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "advance_use_finish", from: "review" });
    expect(res.body.message).toContain("review state 'review'");
    expect((await row(taskId)).status).toBe("review");
  });

  it("a forward edge into a review state listed earlier is not forward: finish is still offered", async () => {
    const taskId = await seedTask("in_progress", REVIEW_FIRST);
    const res = await advance(author, taskId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "advance_use_finish", finishTarget: "review", choices: [] });
  });

  it("a stage with neither a forward edge nor a finish edge: 409 advance_no_forward_edge", async () => {
    const taskId = await seedTask("b", STUCK);
    const res = await advance(author, taskId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "advance_no_forward_edge", from: "b", choices: [] });
    expect((await row(taskId)).status).toBe("b");
  });

  it.each([{}, { to: "open" }])("a definition that lists the initial state after the work stage never lets advance move a task there (%j)", async (body) => {
    const taskId = await seedTask("spec", OPEN_LATE);
    const res = await advance(author, taskId, body);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("to" in body ? "advance_target_invalid" : "advance_no_forward_edge");
    expect(res.body.choices).toEqual([]);
    expect(await row(taskId)).toMatchObject({ status: "spec", claimedByUserId: authorId });
  });

  it.each(["open", "done"])("a task in the %s state (initial or terminal) is a 409 bad_state", async (status) => {
    const taskId = await seedTask(status, PIPELINE);
    const res = await advance(author, taskId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("bad_state");
    expect(res.body.message).toContain(`got '${status}'`);
  });
});

describe("the built-in four-state workflow is unchanged", () => {
  it("start previews the finish exactly as before and sends no advanceTargets", async () => {
    const taskId = randomUUID();
    await db.task.create({ data: { id: taskId, projectId, title: "Four", description: "Seeded.", status: "open", createdByUserId: otherId } });
    const res = await post(author, `/tasks/${taskId}/start`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.expectedFinishState).toBe("review");
    expect(res.body.effectiveGates).toEqual({ finish: ["branchPresent", "prPresent"] });
    expect(res.body).not.toHaveProperty("advanceTargets");
  });

  it("advance from in_progress has no forward work stage: 409 advance_use_finish naming review", async () => {
    const taskId = await seedTask("in_progress");
    const res = await advance(author, taskId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "advance_use_finish", from: "in_progress", finishTarget: "review", choices: [] });
    expect((await row(taskId)).status).toBe("in_progress");
  });

  it.each(["review", "done"])("advance from in_progress with `to: %s` is refused the same way", async (to) => {
    const taskId = await seedTask("in_progress");
    const res = await advance(author, taskId, { to });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "advance_use_finish", requested: to, finishTarget: "review" });
  });
});

describe("claims, scopes and access", () => {
  it("a caller without the work claim gets 403 naming task_start, and nothing moves", async () => {
    const taskId = await seedTask("spec", PIPELINE);
    const res = await advance(other, taskId);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/do not hold the work claim/);
    expect(res.body.message).toContain("task_start");
    expect((await row(taskId)).status).toBe("spec");
  });

  it("a review claim alone does not advance a task", async () => {
    const taskId = await seedTask("spec", PIPELINE, { reviewClaimedByUserId: otherId, reviewClaimedAt: new Date() });
    const res = await advance(other, taskId);
    expect(res.status).toBe(403);
    expect((await row(taskId)).status).toBe("spec");
  });

  it("an agent token holding the work claim advances; one without tasks:transition gets 403", async () => {
    const tokenId = randomUUID();
    await db.agentToken.create({ data: { id: tokenId, teamId, createdById: authorId, name: "agent", tokenHash: tokenId, scopes: ["tasks:read"] } });
    const taskId = await seedTask("spec", PIPELINE, { claimedByUserId: null, claimedByAgentId: tokenId });
    const unscoped = await advance({ type: "agent", tokenId, teamId, userId: authorId, scopes: ["tasks:read"] } as Actor, taskId);
    expect(unscoped.status).toBe(403);
    expect(unscoped.body.message).toBe("Missing scope: tasks:transition");
    const scoped = await advance({ type: "agent", tokenId, teamId, userId: authorId, scopes: ["tasks:read", "tasks:transition"] } as Actor, taskId);
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    expect(await row(taskId)).toMatchObject({ status: "plan", claimedByAgentId: tokenId });
  });

  it("a caller without project write access gets 403", async () => {
    const taskId = await seedTask("spec", PIPELINE);
    accessMocks.requireProjectWrite.mockResolvedValueOnce(false);
    const res = await advance(author, taskId);
    expect(res.status).toBe(403);
    expect((await row(taskId)).status).toBe("spec");
  });

  it("an unknown task is a 404", async () => {
    const res = await advance(author, randomUUID());
    expect(res.status).toBe(404);
  });

  // A Grounding-provisioned task never reaches this handler in the mounted
  // app: the Grounding direct route in front of it serves the advance
  // (grounding-direct-advance.test.ts).
});

describe("gates and the status write are the finish route's", () => {
  it("plan -> build answers 422 precondition_failed without a branch, then passes once it is recorded", async () => {
    const taskId = await seedTask("plan", PIPELINE);
    const blocked = await advance(author, taskId);
    expect(blocked.status).toBe(422);
    expect(blocked.body).toMatchObject({ error: "precondition_failed", canForce: false });
    expect(blocked.body.failed.map((f: { rule: string }) => f.rule)).toEqual(["branchPresent"]);
    expect((await row(taskId)).status).toBe("plan");

    await db.task.update({ where: { id: taskId }, data: { branchName: "feat/x" } });
    const passed = await advance(author, taskId);
    expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    expect((await row(taskId)).status).toBe("build");
  });

  it("an edge whose requiredRole the caller lacks is a 403", async () => {
    const gated = { ...PIPELINE, transitions: PIPELINE.transitions.map((t) => (t.from === "spec" && t.to === "plan" ? { ...t, requiredRole: "ADMIN" } : t)) };
    const taskId = await seedTask("spec", gated);
    accessMocks.hasProjectRole.mockResolvedValueOnce(false);
    const res = await advance(author, taskId);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Requires role: ADMIN");
    expect((await row(taskId)).status).toBe("spec");
  });

  it("a write that lands between the gate and the status write makes the compare-and-swap refuse with 409", async () => {
    const taskId = await seedTask("plan", PIPELINE, { branchName: "feat/x" });
    gateHook.during = async () => {
      gateHook.during = null;
      await db.task.update({ where: { id: taskId }, data: { statusVersion: { increment: 1 } } });
    };
    const res = await advance(author, taskId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
    expect((await row(taskId)).status).toBe("plan");
    expect(advanceAudits()).toEqual([]);
  });
});

describe("Idempotency-Key", () => {
  it("a retry with the same key replays the stored response instead of advancing again", async () => {
    const taskId = await seedTask("plan", PIPELINE, { branchName: "feat/x" });
    const first = await advance(author, taskId, {}, { "Idempotency-Key": "advance-1" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.targetStatus).toBe("build");
    const retry = await advance(author, taskId, {}, { "Idempotency-Key": "advance-1" });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ targetStatus: "build", _idempotent_replay: true });
    expect(retry.headers.get("x-idempotent-replay")).toBe("true");
    expect(first.headers.get("x-idempotent-replay")).toBeNull();
    expect((await row(taskId)).status).toBe("build");
    expect(advanceAudits()).toHaveLength(1);
  });

  it("without a key every call executes: a second call is judged on the new state", async () => {
    const taskId = await seedTask("spec", PIPELINE, { branchName: "feat/x" });
    expect((await advance(author, taskId)).body.targetStatus).toBe("plan");
    expect((await advance(author, taskId)).body.targetStatus).toBe("build");
    expect(advanceAudits()).toHaveLength(2);
  });

  it("the same key with a different payload is a 409 conflict and moves nothing", async () => {
    const taskId = await seedTask("spec", FORK);
    expect((await advance(author, taskId, { to: "lint" }, { "Idempotency-Key": "advance-2" })).status).toBe(200);
    const other = await seedTask("spec", FORK);
    const reused = await advance(author, other, { to: "docs" }, { "Idempotency-Key": "advance-2" });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("conflict");
    expect((await row(other)).status).toBe("spec");
  });

  it("the same key and the same empty body on another task is a 409 conflict: the task is part of the hash", async () => {
    const first = await seedTask("spec", PIPELINE);
    const second = await seedTask("spec", PIPELINE);
    expect((await advance(author, first, {}, { "Idempotency-Key": "advance-4" })).status).toBe(200);
    const reused = await advance(author, second, {}, { "Idempotency-Key": "advance-4" });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("conflict");
    expect((await row(second)).status).toBe("spec");
    expect(advanceAudits()).toHaveLength(1);
  });

  it("another caller reusing the key on the same task is a 409 conflict, not a success-shaped replay", async () => {
    const taskId = await seedTask("spec", PIPELINE);
    expect((await advance(author, taskId, {}, { "Idempotency-Key": "advance-5" })).status).toBe(200);
    const reused = await advance(other, taskId, {}, { "Idempotency-Key": "advance-5" });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("conflict");
    expect(reused.body).not.toHaveProperty("_idempotent_replay");
    // The original caller's retry still replays.
    const retry = await advance(author, taskId, {}, { "Idempotency-Key": "advance-5" });
    expect(retry.body).toMatchObject({ _idempotent_replay: true });
  });

  it("an agent token and a human with the same id value are different callers", async () => {
    const taskId = await seedTask("spec", PIPELINE);
    expect((await advance(author, taskId, {}, { "Idempotency-Key": "advance-6" })).status).toBe(200);
    const agent = { type: "agent", tokenId: authorId, teamId, userId: authorId, scopes: ["tasks:transition"] } as Actor;
    const reused = await advance(agent, taskId, {}, { "Idempotency-Key": "advance-6" });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("conflict");
  });

  it("the same caller, task and key with a different `to` is a 409 conflict: the requested edge is part of the hash", async () => {
    const taskId = await seedTask("spec", FORK);
    expect((await advance(author, taskId, { to: "lint" }, { "Idempotency-Key": "advance-7" })).status).toBe(200);
    const reused = await advance(author, taskId, { to: "docs" }, { "Idempotency-Key": "advance-7" });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("conflict");
    expect(reused.body).not.toHaveProperty("_idempotent_replay");
    expect((await row(taskId)).status).toBe("lint");
  });

  it("two agent tokens of the same owner are different callers: the second reusing the key gets a 409, not a replay", async () => {
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    for (const id of [tokenA, tokenB]) {
      await db.agentToken.create({ data: { id, teamId, createdById: authorId, name: `agent-${id.slice(0, 8)}`, tokenHash: id, scopes: ["tasks:transition"] } });
    }
    const taskId = await seedTask("spec", PIPELINE, { claimedByUserId: null, claimedByAgentId: tokenA });
    const asToken = (tokenId: string) => ({ type: "agent", tokenId, teamId, userId: authorId, scopes: ["tasks:transition"] }) as Actor;
    const first = await advance(asToken(tokenA), taskId, {}, { "Idempotency-Key": "advance-8" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const reused = await advance(asToken(tokenB), taskId, {}, { "Idempotency-Key": "advance-8" });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("conflict");
    expect(reused.body).not.toHaveProperty("_idempotent_replay");
    expect(reused.headers.get("X-Idempotent-Replay")).toBeNull();
    expect((await row(taskId)).status).toBe("plan");
  });

  it("a refused advance is not stored: the same key retries for real", async () => {
    const taskId = await seedTask("plan", PIPELINE);
    expect((await advance(author, taskId, {}, { "Idempotency-Key": "advance-3" })).status).toBe(422);
    await db.task.update({ where: { id: taskId }, data: { branchName: "feat/x" } });
    const retry = await advance(author, taskId, {}, { "Idempotency-Key": "advance-3" });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).not.toHaveProperty("_idempotent_replay");
    expect((await row(taskId)).status).toBe("build");
  });

  it("an Idempotency-Key outside the operation-key format is a 400", async () => {
    const taskId = await seedTask("spec", PIPELINE);
    const res = await advance(author, taskId, {}, { "Idempotency-Key": "has space" });
    expect(res.status).toBe(400);
    expect((await row(taskId)).status).toBe("spec");
  });
});
