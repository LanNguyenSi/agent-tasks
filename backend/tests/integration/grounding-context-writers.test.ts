import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppVariables } from "../../src/types/hono.js";

const harness = vi.hoisted(() => ({ current: null as (() => PrismaClient) | null }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy({}, {
    get: (_target, property) => {
      const db = harness.current!();
      const value = Reflect.get(db, property);
      return typeof value === "function" ? value.bind(db) : value;
    },
  }),
}));

import { workflowRouter } from "../../src/routes/workflows.js";
import { projectInviteAdminRouter } from "../../src/routes/invites.js";
import { defaultWorkflowDefinition } from "../../src/services/default-workflow.js";
import { findWorkflowTemplate } from "../../src/services/workflow-templates.js";
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { barrier, groundingPostgres } from "../helpers/grounding-postgres.js";
import { testIssuer } from "../helpers/grounding-fixtures.js";

const requestDb = new AsyncLocalStorage<PrismaClient>();
const raceClients: PrismaClient[] = [];
let store: Awaited<ReturnType<typeof groundingPostgres>>;
let projectId: string;
let teamId: string;
let adminId: string;
let memberId: string;
let attempts: GroundingAttemptsService;
let issuer: ReturnType<typeof testIssuer>;
harness.current = () => requestDb.getStore() ?? store.db;

function raceClient() {
  const db = store.connect();
  raceClients.push(db);
  return db;
}

function app(userId = adminId, db = store.db) {
  const mounted = new Hono<{ Variables: AppVariables }>();
  mounted.use("*", async (c, next) => {
    c.set("actor", { type: "human", userId });
    await requestDb.run(db, next);
  });
  mounted.route("/", workflowRouter);
  mounted.route("/", projectInviteAdminRouter);
  return mounted;
}

type Write = { path: string; method: string; body?: unknown; status: number; reason: string };
async function request(write: Write, userId = adminId, db = store.db) {
  return app(userId, db).request(write.path, {
    method: write.method,
    ...(write.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(write.body) }),
  });
}
const definition = () => defaultWorkflowDefinition();
function changedDefinition() {
  const changed = definition();
  changed.states[0]!.agentInstructions = "A changed signed workflow instruction";
  return changed;
}
async function workflow(name: string, isDefault = false) {
  return store.db.workflow.create({ data: { projectId, name, isDefault, definition: definition() as object } });
}
async function receiptTask(name: string, workflowId: string | null, data: Partial<Prisma.TaskUncheckedCreateInput> = {}, actorId = adminId) {
  const task = await store.db.task.create({ data: { projectId, title: name, workflowId, status: "in_progress", claimedByUserId: adminId, claimedAt: new Date(), ...data } });
  // All workflow, status and claim fields are final before challenge issuance and signed receipt ingestion.
  const actor = { type: "human" as const, userId: actorId };
  await attempts.provision({ taskId: task.id, projectId, subjectMode: "TASK_SPEC" });
  const challenge = await attempts.issue(task.id, actor, task.status === "review" ? "approve" : "finish");
  await attempts.ingest(task.id, challenge.attemptId, actor, { id: "session.test", revision: 1 }, issuer.receipt(challenge));
  return { task, attemptId: challenge.attemptId, before: await taskHistory(task.id) };
}
type ReceiptTask = Awaited<ReturnType<typeof receiptTask>>;
async function taskHistory(taskId: string, db = store.db) {
  return {
    task: await db.task.findUniqueOrThrow({ where: { id: taskId } }),
    binding: await db.groundingBinding.findUnique({ where: { taskId } }),
    cohort: await db.groundingCohort.findUnique({ where: { taskId } }),
    attempts: await db.groundingAttempt.findMany({ where: { taskId }, orderBy: { id: "asc" } }),
    receipts: await db.groundingReceipt.findMany({ where: { taskId }, orderBy: { id: "asc" } }),
  };
}
async function history(db = store.db) {
  return {
    projects: await db.project.findMany({ orderBy: { id: "asc" } }),
    workflows: await db.workflow.findMany({ orderBy: { id: "asc" } }),
    tasks: await db.task.findMany({ orderBy: { id: "asc" } }),
    members: await db.projectMember.findMany({ orderBy: { id: "asc" } }),
    teamMembers: await db.teamMember.findMany({ orderBy: { id: "asc" } }),
    bindings: await db.groundingBinding.findMany({ orderBy: { taskId: "asc" } }),
    cohorts: await db.groundingCohort.findMany({ orderBy: { taskId: "asc" } }),
    attempts: await db.groundingAttempt.findMany({ orderBy: { id: "asc" } }),
    receipts: await db.groundingReceipt.findMany({ orderBy: { id: "asc" } }),
    operations: await db.groundingOperation.findMany({ orderBy: { id: "asc" } }),
    finalizations: await db.groundingFinalization.findMany({ orderBy: { id: "asc" } }),
    audits: await db.auditLog.findMany({ orderBy: { id: "asc" } }),
  };
}
async function expectInvalidated(item: ReceiptTask, revision = 2) {
  const after = await taskHistory(item.task.id);
  expect(after.binding).toEqual({ ...item.before.binding, activeAttemptId: null, contextDigest: null, contextRevision: revision });
  expect(after.attempts).toEqual(item.before.attempts.map(attempt => ({ ...attempt, state: "SUPERSEDED" })));
  expect(after.receipts).toEqual(item.before.receipts);
  expect(after.cohort).toEqual(item.before.cohort);
}
async function reserve(taskId: string, state: "RESERVED" | "DISPATCHED") {
  const operation = await store.db.groundingOperation.create({ data: {
    id: randomUUID(), taskId, key: randomUUID(), actorType: "human", actorId: adminId,
    fingerprint: "a".repeat(64), request: { intent: "merge" }, decision: {}, state,
  } });
  await store.db.groundingCohort.update({ where: { taskId }, data: { reservationId: operation.id } });
}

const writers = ["customize", "apply-new", "apply-existing", "reset", "create-default", "update-default", "update-explicit", "promote", "demote", "member-remove"] as const;
type Writer = typeof writers[number];
async function fixture(kind: Writer) {
  const hasDefault = !["customize", "apply-new"].includes(kind);
  const current = hasDefault ? await workflow("Current default", true) : null;
  const target = await workflow("Explicit target");
  const control = await workflow("Unrelated explicit workflow");
  const inherited = await receiptTask("Inherited binding", null);
  const inheritedPeer = await receiptTask("Inherited peer", null);
  const explicit = current ? await receiptTask("Explicit current default", current.id) : null;
  const targetTask = await receiptTask("Explicit target binding", target.id);
  const controlTask = await receiptTask("Unrelated explicit binding", control.id);
  const all = [inherited, inheritedPeer, ...(explicit ? [explicit] : []), targetTask, controlTask];
  let affected: ReceiptTask[] = [inherited, inheritedPeer];
  const prefix = `/projects/${projectId}`;
  let write: Write;
  switch (kind) {
    case "customize": write = { path: `${prefix}/workflow/customize`, method: "POST", status: 201, reason: "workflow_customize_grounding_context" }; break;
    case "apply-new":
    case "apply-existing":
      if (explicit) affected.push(explicit);
      write = { path: `${prefix}/workflow/apply-template/release-ops-no-pr`, method: "POST", status: 201, reason: "workflow_template_apply_grounding_context" }; break;
    case "reset":
      affected.push(explicit!);
      write = { path: `${prefix}/workflow`, method: "DELETE", status: 200, reason: "workflow_reset_grounding_context" }; break;
    case "create-default": write = { path: `${prefix}/workflows`, method: "POST", body: { name: "Replacement default", isDefault: true, definition: changedDefinition() }, status: 201, reason: "workflow_create_grounding_context" }; break;
    case "update-default":
      affected.push(explicit!);
      write = { path: `/workflows/${current!.id}`, method: "PUT", body: { definition: changedDefinition() }, status: 200, reason: "workflow_update_grounding_context" }; break;
    case "update-explicit":
      affected = [targetTask];
      write = { path: `/workflows/${target.id}`, method: "PUT", body: { definition: changedDefinition() }, status: 200, reason: "workflow_update_grounding_context" }; break;
    case "promote": write = { path: `/workflows/${target.id}`, method: "PUT", body: { isDefault: true }, status: 200, reason: "workflow_update_grounding_context" }; break;
    case "demote": write = { path: `/workflows/${current!.id}`, method: "PUT", body: { isDefault: false }, status: 200, reason: "workflow_update_grounding_context" }; break;
    case "member-remove": {
      const work = await receiptTask("Member work claim", null, { claimedByUserId: memberId }, memberId);
      const review = await receiptTask("Member review claim", current!.id, { status: "review", reviewClaimedByUserId: memberId, reviewClaimedAt: new Date() }, memberId);
      const inactiveReview = await receiptTask("Inactive review claim", null, { reviewClaimedByUserId: memberId, reviewClaimedAt: new Date() });
      await store.db.task.create({ data: { projectId, title: "Terminal claim retained", status: "done", claimedByUserId: memberId, claimedAt: new Date() } });
      affected = [work, review];
      all.push(work, review, inactiveReview);
      write = { path: `${prefix}/members/${memberId}`, method: "DELETE", status: 200, reason: "project_member_remove_grounding_context" };
    }
  }
  return { kind, write, affected, unaffected: all.filter(item => !affected.includes(item)), inherited, inheritedPeer, explicit, targetTask, current, target };
}

beforeAll(async () => { store = await groundingPostgres(); }, 60_000);
afterAll(async () => { await store?.close(); });
afterEach(async () => {
  // Each race owns independent sessions, released even when an assertion fails.
  // store.close still owns schema teardown and final cleanup of every client.
  await Promise.all(raceClients.splice(0).map(db => db.$disconnect()));
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("outbound fetch disabled in context writer fixture")));
  await store.db.groundingBinding.updateMany({ data: { activeAttemptId: null } });
  await store.db.groundingCohort.updateMany({ data: { reservationId: null } });
  await store.db.groundingFinalization.deleteMany();
  await store.db.groundingOperation.deleteMany();
  await store.db.auditLog.deleteMany();
  await store.db.groundingReceipt.deleteMany();
  await store.db.groundingAttempt.deleteMany();
  await store.db.groundingCohort.deleteMany();
  await store.db.groundingBinding.deleteMany();
  await store.db.task.deleteMany();
  await store.db.workflow.deleteMany();
  await store.db.project.deleteMany();
  await store.db.teamMember.deleteMany();
  await store.db.team.deleteMany();
  await store.db.user.deleteMany();
  [projectId, teamId, adminId, memberId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await store.db.user.createMany({ data: [{ id: adminId, login: `admin-${adminId}` }, { id: memberId, login: `member-${memberId}` }] });
  await store.db.team.create({ data: { id: teamId, name: "Context team", slug: `team-${teamId}` } });
  await store.db.teamMember.createMany({ data: [{ teamId, userId: adminId, role: "ADMIN" }, { teamId, userId: memberId, role: "HUMAN_MEMBER" }] });
  await store.db.project.create({ data: { id: projectId, teamId, name: "Context writers", slug: `project-${projectId}` } });
  await store.db.projectMember.create({ data: { projectId, userId: memberId, role: "PROJECT_CONTRIBUTOR", invitedById: adminId } });
  issuer = testIssuer([projectId]);
  attempts = new GroundingAttemptsService({ db: store.db, config: { audience: "consumer.test", trust: () => issuer.trust } });
});

describe("mounted indirect context writers with PostgreSQL", () => {
  it.each(writers)("N-06/N-27 %s invalidates exactly its uploaded receipts and preserves unaffected explicit bindings", async kind => {
    const f = await fixture(kind);
    const before = await history();
    const response = await request(f.write);
    expect(response.status).toBe(f.write.status);
    for (const item of f.affected) await expectInvalidated(item);
    for (const item of f.unaffected) expect(await taskHistory(item.task.id)).toEqual(item.before);
    expect(await store.db.auditLog.findMany({ where: { action: "project.grounding.context_mutated" } })).toEqual([
      expect.objectContaining({ projectId, actorId: adminId, payload: { actorType: "human", actorId: adminId, reason: f.write.reason, taskIds: f.affected.map(item => item.task.id).sort() } }),
    ]);
    if (kind === "member-remove") {
      expect(await response.json()).toEqual({ success: true, claimsReleased: 2 });
      expect(await store.db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: memberId } } })).toBeNull();
      for (const item of f.affected) expect(await store.db.task.findUniqueOrThrow({ where: { id: item.task.id } })).toMatchObject({ claimedByUserId: null, claimedAt: null, reviewClaimedByUserId: null, reviewClaimedAt: null });
      expect(await store.db.task.findMany({ where: { status: "done" } })).toEqual(before.tasks.filter(task => task.status === "done"));
      expect(await store.db.workflow.findMany({ orderBy: { id: "asc" } })).toEqual(before.workflows);
    } else {
      const effective = await store.db.workflow.findMany({ where: { projectId, isDefault: true } });
      if (kind === "reset" || kind === "demote") expect(effective).toEqual([]);
      else expect(effective).toHaveLength(1);
      if (kind === "reset") {
        expect(await store.db.workflow.findUnique({ where: { id: f.current!.id } })).toBeNull();
        expect(await store.db.task.findUniqueOrThrow({ where: { id: f.explicit!.task.id } })).toMatchObject({ workflowId: null });
      }
      if (kind.startsWith("apply-")) expect(effective[0]!.definition).toEqual(findWorkflowTemplate("release-ops-no-pr")!.definition);
      if (kind === "customize") expect(effective[0]!.definition).toEqual(definition());
      if (kind === "create-default" || kind === "update-default") expect(effective[0]!.definition).toEqual(changedDefinition());
      if (kind === "promote") expect(effective[0]!.id).toBe(f.target.id);
      if (kind === "update-explicit") expect((await store.db.workflow.findUniqueOrThrow({ where: { id: f.target.id } })).definition).toEqual(changedDefinition());
      expect(await store.db.projectMember.findMany({ orderBy: { id: "asc" } })).toEqual(before.members);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  for (const state of ["RESERVED", "DISPATCHED"] as const) {
    // Exercise each semantic selection arm, including inherited and explicit tasks and both human claims.
    const arms = writers.flatMap(kind => [0, ...( ["apply-existing", "reset", "update-default", "member-remove"].includes(kind) ? [1] : [])].map(arm => ({ kind, arm })));
    it.each(arms)(`N-11 $kind arm $arm rejects ${state} without changing any history`, async ({ kind, arm }) => {
      const f = await fixture(kind);
      const selected = arm === 0 ? f.affected[0]! : f.affected.at(-1)!;
      await reserve(selected.task.id, state);
      const before = await history();
      const response = await request(f.write);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "grounding_finalization_pending" });
      expect(await history()).toEqual(before);
    });
  }

  it.each(writers)("%s rolls back mutation, claim release, revision, attempts and audit when mandatory audit fails", async kind => {
    const f = await fixture(kind);
    const before = await history();
    await store.db.$executeRawUnsafe("CREATE FUNCTION fail_context_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'project.grounding.context_mutated' THEN RAISE EXCEPTION 'test mandatory audit failure'; END IF; RETURN NEW; END $$");
    await store.db.$executeRawUnsafe("CREATE TRIGGER fail_context_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_context_audit()");
    try {
      const response = await request(f.write);
      expect(response.status).toBe(500);
      expect(await history()).toEqual(before);
    } finally {
      await store.db.$executeRawUnsafe("DROP TRIGGER fail_context_audit ON audit_logs");
      await store.db.$executeRawUnsafe("DROP FUNCTION fail_context_audit()");
    }
  });

  it.each(["same-definition", "name-only", "same-default", "nondefault-create", "equal-template"])("preserves active receipts and reservations for %s", async mode => {
    if (mode === "equal-template") {
      const preset = findWorkflowTemplate("release-ops-no-pr")!;
      await store.db.workflow.create({ data: { projectId, name: preset.name, isDefault: true, definition: preset.definition as object } });
    }
    const current = mode === "equal-template" ? await store.db.workflow.findFirstOrThrow({ where: { projectId, isDefault: true } }) : await workflow("Current", true);
    const inherited = await receiptTask("Inherited", null);
    const explicit = await receiptTask("Explicit", current.id);
    await reserve(inherited.task.id, "RESERVED");
    const before = await history();
    const write: Write = mode === "nondefault-create"
      ? { path: `/projects/${projectId}/workflows`, method: "POST", body: { name: "Non-default", isDefault: false, definition: definition() }, status: 201, reason: "" }
      : mode === "equal-template"
        ? { path: `/projects/${projectId}/workflow/apply-template/release-ops-no-pr`, method: "POST", status: 201, reason: "" }
        : { path: `/workflows/${current.id}`, method: "PUT", body: mode === "name-only" ? { name: "Renamed" } : mode === "same-default" ? { isDefault: true } : { definition: definition() }, status: 200, reason: "" };
    expect((await request(write)).status).toBe(write.status);
    const after = await history();
    expect({ ...after, workflows: [], audits: [] }).toEqual({ ...before, workflows: [], audits: [] });
    expect(after.audits.filter(row => row.action === "project.grounding.context_mutated")).toEqual([]);
    expect(after.attempts.every(attempt => attempt.state === "ACTIVE")).toBe(true);
    expect(await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId: explicit.task.id } })).toEqual(explicit.before.binding);
  });
});

async function pid(db: PrismaClient) {
  return (await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
}
async function waitForBlock(waiting: number, blocking: number, observer: PrismaClient) {
  const deadline = Date.now() + 5000;
  do {
    const [row] = await observer.$queryRaw<{ blocked: boolean }[]>`SELECT ${blocking}::int = ANY(pg_blocking_pids(${waiting}::int)) AS blocked`;
    if (row?.blocked) return;
  } while (Date.now() < deadline);
  throw new Error(`Database backend ${waiting} never waited for ${blocking}`);
}

describe("context writers serialize selection and authority", () => {
  it.each(writers.flatMap(kind => ["team", "project"].map(source => ({ kind, source }))))("$kind rejects a $source admin revoked while waiting on the parent lock", async ({ kind, source }) => {
    const f = await fixture(kind);
    if (source === "project") {
      await store.db.teamMember.update({ where: { teamId_userId: { teamId, userId: adminId } }, data: { role: "HUMAN_MEMBER" } });
      await store.db.projectMember.create({ data: { projectId, userId: adminId, role: "PROJECT_ADMIN", invitedById: memberId } });
    }
    const blocker = raceClient();
    const observer = raceClient();
    const writer = raceClient();
    const [blockingPid, waitingPid] = await Promise.all([pid(blocker), pid(writer)]);
    const hold = barrier();
    const held = blocker.$transaction(async db => {
      await db.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
      await hold.wait();
    }, { timeout: 15000 });
    await hold.reached;
    const pending = request(f.write, adminId, writer);
    let expected: Awaited<ReturnType<typeof history>> | undefined;
    let response: Response;
    try {
      await waitForBlock(waitingPid, blockingPid, observer);
      if (source === "team") await observer.teamMember.update({ where: { teamId_userId: { teamId, userId: adminId } }, data: { role: "HUMAN_MEMBER" } });
      else await observer.projectMember.delete({ where: { projectId_userId: { projectId, userId: adminId } } });
      expected = await history(observer);
    } finally {
      hold.release();
      await held;
      response = await pending;
    }
    expect(response.status).toBe(403);
    expect(await history()).toEqual(expected);
  });

  it("N-27 concurrent bulk writers serialize on parent before tasks and select the newly promoted default", async () => {
    const f = await fixture("promote");
    const first = raceClient();
    const second = raceClient();
    const blocker = raceClient();
    const observer = raceClient();
    const [firstPid, secondPid, blockingPid] = await Promise.all([pid(first), pid(second), pid(blocker)]);
    const firstTaskId = f.affected.map(item => item.task.id).sort()[0]!;
    const hold = barrier();
    const held = blocker.$transaction(async db => {
      await db.$queryRaw`SELECT id FROM tasks WHERE id = ${firstTaskId} FOR UPDATE`;
      await hold.wait();
    }, { timeout: 15000 });
    await hold.reached;
    const before = await history(observer);
    const pendingFirst = request(f.write, adminId, first);
    let pendingSecond: Promise<Response> | undefined;
    let firstResponse: Response;
    let secondResponse: Response | undefined;
    try {
      await waitForBlock(firstPid, blockingPid, observer);
      pendingSecond = request({ path: `/projects/${projectId}/workflow/apply-template/release-ops-no-pr`, method: "POST", status: 201, reason: "" }, adminId, second);
      await waitForBlock(secondPid, firstPid, observer);
      expect(await history(observer)).toEqual(before);
    } finally {
      hold.release();
      await held;
      firstResponse = await pendingFirst;
      secondResponse = await pendingSecond;
    }
    expect(firstResponse.status).toBe(200);
    expect(secondResponse?.status).toBe(201);
    await expectInvalidated(f.inherited, 3);
    await expectInvalidated(f.inheritedPeer, 3);
    await expectInvalidated(f.targetTask);
    expect(await taskHistory(f.explicit!.task.id)).toEqual(f.explicit!.before);
    expect(await store.db.workflow.findMany({ where: { projectId, isDefault: true } })).toEqual([
      expect.objectContaining({ id: f.target.id, definition: findWorkflowTemplate("release-ops-no-pr")!.definition }),
    ]);
    const audits = await store.db.auditLog.findMany({ where: { action: "project.grounding.context_mutated" } });
    expect(audits).toHaveLength(2);
    expect(audits.map(row => row.payload)).toEqual(expect.arrayContaining([
      { actorType: "human", actorId: adminId, reason: "workflow_update_grounding_context", taskIds: [f.inherited.task.id, f.inheritedPeer.task.id].sort() },
      { actorType: "human", actorId: adminId, reason: "workflow_template_apply_grounding_context", taskIds: [f.inherited.task.id, f.inheritedPeer.task.id, f.targetTask.task.id].sort() },
    ]));
  });
});
