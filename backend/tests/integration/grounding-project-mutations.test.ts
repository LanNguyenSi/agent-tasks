import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const harness = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy({}, {
    get: (_target, property) => {
      const value = Reflect.get(harness.db!, property);
      return typeof value === "function" ? value.bind(harness.db) : value;
    },
  }),
}));

import { projectRouter } from "../../src/routes/projects.js";
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { barrier, groundingPostgres } from "../helpers/grounding-postgres.js";
import { testIssuer } from "../helpers/grounding-fixtures.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let teamId: string;
let projectId: string;
let taskId: string;
let adminId: string;
let memberId: string;
let attempts: GroundingAttemptsService;
let issuer: ReturnType<typeof testIssuer>;
let uploadDirectory: string;

function app(principal: string | Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", typeof principal === "string" ? { type: "human", userId: principal } : principal);
    await next();
  });
  app.route("/", projectRouter);
  return app;
}

async function uploadReceipt(receiptTaskId = taskId) {
  const actor = { type: "agent" as const, tokenId: "test-agent", teamId, userId: adminId, scopes: ["tasks:transition"] };
  await attempts.provision({ taskId: receiptTaskId, projectId, subjectMode: "TASK_SPEC" });
  const challenge = await attempts.issue(receiptTaskId, actor, "finish");
  await attempts.ingest(receiptTaskId, challenge.attemptId, actor, { id: "session.test", revision: 1 }, issuer.receipt(challenge));
  return challenge.attemptId;
}

async function reserve(reservedTaskId = taskId, state: "RESERVED" | "DISPATCHED" = "RESERVED") {
  const operation = await store.db.groundingOperation.create({ data: { id: randomUUID(), taskId: reservedTaskId, key: randomUUID(), actorType: "agent", actorId: "test-agent", fingerprint: "a".repeat(64), request: {}, decision: {}, state } });
  await store.db.groundingCohort.update({ where: { taskId: reservedTaskId }, data: { reservationId: operation.id } });
}

async function history() {
  return {
    projects: await store.db.project.findMany({ orderBy: { id: "asc" } }),
    tasks: await store.db.task.findMany({ orderBy: { id: "asc" } }),
    bindings: await store.db.groundingBinding.findMany({ orderBy: { taskId: "asc" } }),
    cohorts: await store.db.groundingCohort.findMany({ orderBy: { taskId: "asc" } }),
    attempts: await store.db.groundingAttempt.findMany({ orderBy: { id: "asc" } }),
    receipts: await store.db.groundingReceipt.findMany({ orderBy: { id: "asc" } }),
    operations: await store.db.groundingOperation.findMany({ orderBy: { id: "asc" } }),
    finalizations: await store.db.groundingFinalization.findMany({ orderBy: { id: "asc" } }),
    attachments: await store.db.taskAttachment.findMany({ orderBy: { id: "asc" } }),
    audit: await store.db.auditLog.findMany({ orderBy: { id: "asc" } }),
  };
}

async function attachment(attachmentTaskId = taskId) {
  const filename = `${randomUUID()}.txt`;
  const bytes = Buffer.from("Test-owned project attachment\n");
  const path = join(uploadDirectory, filename);
  await writeFile(path, bytes);
  const row = await store.db.taskAttachment.create({ data: { taskId: attachmentTaskId, name: filename, url: `/uploads/${filename}`, mimeType: "text/plain", sizeBytes: bytes.length, createdByUserId: adminId } });
  return { row, path, bytes };
}

async function expectInvalidated(attemptId: string, invalidatedTaskId = taskId) {
  expect(await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId: invalidatedTaskId } })).toMatchObject({ activeAttemptId: null, contextDigest: null, contextRevision: 2, protected: true });
  expect(await store.db.groundingAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ state: "SUPERSEDED" });
}

async function rejectAudit(write: () => Promise<Response>) {
  await store.db.$executeRawUnsafe("CREATE FUNCTION fail_project_context_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$");
  await store.db.$executeRawUnsafe("CREATE TRIGGER fail_project_context_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_project_context_audit()");
  try {
    expect((await write()).status).toBe(500);
  } finally {
    await store.db.$executeRawUnsafe("DROP TRIGGER fail_project_context_audit ON audit_logs");
    await store.db.$executeRawUnsafe("DROP FUNCTION fail_project_context_audit()");
  }
}

// Observe the database wait itself before changing authority; no timing assumption.
async function waitForParentLock(waitingPid: number, blockingPid: number, observer: PrismaClient) {
  const deadline = Date.now() + 5000;
  do {
    const [row] = await observer.$queryRaw<{ blocked: boolean }[]>`SELECT ${blockingPid}::int = ANY(pg_blocking_pids(${waitingPid}::int)) AS blocked`;
    if (row?.blocked) return;
  } while (Date.now() < deadline);
  throw new Error("PATCH never queued on the held parent lock");
}

async function request(userId: string, body: unknown) {
  return app(userId).request(`/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  store = await groundingPostgres();
  harness.db = store.db;
}, 60_000);
afterAll(async () => { await store?.close(); });
afterEach(async () => {
  await rm(uploadDirectory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  uploadDirectory = await mkdtemp(join(tmpdir(), "grounding-project-uploads-"));
  vi.stubEnv("UPLOAD_DIR", uploadDirectory);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("outbound fetch disabled in grounding project fixture")));
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
  await store.db.project.deleteMany();
  await store.db.teamMember.deleteMany();
  await store.db.agentToken.deleteMany();
  await store.db.team.deleteMany();
  await store.db.user.deleteMany();

  teamId = randomUUID();
  projectId = randomUUID();
  taskId = randomUUID();
  adminId = randomUUID();
  memberId = randomUUID();
  await store.db.user.createMany({ data: [
    { id: adminId, login: `admin-${adminId}` },
    { id: memberId, login: `member-${memberId}` },
  ] });
  await store.db.team.create({ data: { id: teamId, name: "Grounding patch team", slug: `team-${teamId}` } });
  await store.db.teamMember.createMany({ data: [
    { teamId, userId: adminId, role: "ADMIN" },
    { teamId, userId: memberId, role: "HUMAN_MEMBER" },
  ] });
  await store.db.agentToken.create({ data: { id: "test-agent", teamId, createdById: adminId, name: "Test agent", tokenHash: `hash-${projectId}`, scopes: ["tasks:transition"] } });
  await store.db.project.create({ data: { id: projectId, teamId, name: "Grounding patch", slug: `project-${projectId}`, githubRepo: "acme/original" } });
  await store.db.task.create({ data: { id: taskId, projectId, title: "Protected task", status: "in_progress", claimedByAgentId: "test-agent" } });
  issuer = testIssuer([projectId]);
  attempts = new GroundingAttemptsService({ db: store.db, config: { audience: "consumer.test", trust: () => issuer.trust } });
});

describe("grounding project PATCH mutations (PostgreSQL)", () => {
  it.each([
    ["repository", { githubRepo: "acme/changed" }, { githubRepo: "acme/changed" }],
    ["template", { taskTemplate: { fields: { goal: true } } }, { taskTemplate: { fields: { goal: true } } }],
    ["governance", { governanceMode: "AUTONOMOUS" }, { governanceMode: "AUTONOMOUS", soloMode: true, requireDistinctReviewer: false }],
    ["legacy governance", { requireDistinctReviewer: true }, { governanceMode: "REQUIRES_DISTINCT_REVIEWER", soloMode: false, requireDistinctReviewer: true }],
  ])("invalidates uploaded receipts for a %s context change", async (_name, body, updated) => {
    const attemptId = await uploadReceipt();
    const cohort = await store.db.groundingCohort.findUniqueOrThrow({ where: { taskId } });
    expect((await request(adminId, body)).status).toBe(200);
    expect(await store.db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject(updated as object);
    await expectInvalidated(attemptId);
    expect(await store.db.groundingCohort.findUniqueOrThrow({ where: { taskId } })).toEqual(cohort);
    expect(await store.db.auditLog.findFirst({ where: { projectId, action: "project.grounding.context_mutated" } })).toMatchObject({ actorId: adminId, payload: { actorType: "human", actorId: adminId, taskIds: [taskId], reason: "project_patch_grounding_context" } });
  });

  it.each([false, true])("invalidates and audits an actual protection-setting change from %s", async beforeFlag => {
    await store.db.project.update({ where: { id: projectId }, data: { requireGroundingForDebug: beforeFlag } });
    const attemptId = await uploadReceipt();
    const cohort = await store.db.groundingCohort.findUniqueOrThrow({ where: { taskId } });
    const receipt = await store.db.groundingReceipt.findUniqueOrThrow({ where: { attemptId } });
    expect((await request(adminId, { requireGroundingForDebug: !beforeFlag })).status).toBe(200);
    expect(await store.db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ requireGroundingForDebug: !beforeFlag });
    await expectInvalidated(attemptId);
    expect(await store.db.groundingCohort.findUniqueOrThrow({ where: { taskId } })).toEqual(cohort);
    expect(await store.db.groundingReceipt.findUniqueOrThrow({ where: { attemptId } })).toEqual(receipt);
    expect(await store.db.auditLog.findFirst({ where: { projectId, action: "project.grounding.context_mutated" } })).toMatchObject({ actorId: adminId, payload: { actorType: "human", actorId: adminId, taskIds: [taskId], reason: "project_patch_grounding_context" } });
  });

  it.each([false, true])("rolls back setting, invalidation and history if the mandatory audit fails for %s", async beforeFlag => {
    await store.db.project.update({ where: { id: projectId }, data: { requireGroundingForDebug: beforeFlag } });
    await uploadReceipt();
    const before = await history();
    await rejectAudit(() => request(adminId, { requireGroundingForDebug: !beforeFlag }));
    expect(await history()).toEqual(before);
  });

  it.each([false, true])("preserves the active receipt for a same-value protection setting of %s", async flag => {
    await store.db.project.update({ where: { id: projectId }, data: { requireGroundingForDebug: flag } });
    await uploadReceipt();
    const before = await history();
    expect((await request(adminId, { requireGroundingForDebug: flag })).status).toBe(200);
    const after = await history();
    expect({ ...after, projects: [] }).toEqual({ ...before, projects: [] });
    expect(after.projects[0]).toEqual({ ...before.projects[0], updatedAt: after.projects[0]!.updatedAt });
  });

  it.each(["RESERVED", "DISPATCHED"] as const)("blocks every affected task and project write when one of two tasks has a %s operation", async state => {
    const otherTaskId = randomUUID();
    await store.db.task.create({ data: { id: otherTaskId, projectId, title: "Second protected task", status: "in_progress", claimedByAgentId: "test-agent" } });
    await uploadReceipt();
    await uploadReceipt(otherTaskId);
    await reserve([taskId, otherTaskId].sort()[1]!, state);
    const before = await history();
    expect((await request(adminId, { githubRepo: "acme/blocked", requireGroundingForDebug: true })).status).toBe(409);
    expect(await history()).toEqual(before);
  });

  it("invalidates all affected tasks in one admitted mutation", async () => {
    const otherTaskId = randomUUID();
    await store.db.task.create({ data: { id: otherTaskId, projectId, title: "Second protected task", status: "in_progress", claimedByAgentId: "test-agent" } });
    const firstAttempt = await uploadReceipt();
    const secondAttempt = await uploadReceipt(otherTaskId);
    expect((await request(adminId, { githubRepo: "acme/fanout" })).status).toBe(200);
    await expectInvalidated(firstAttempt);
    await expectInvalidated(secondAttempt, otherTaskId);
    expect(await store.db.auditLog.findMany({ where: { projectId, action: "project.grounding.context_mutated" } })).toEqual([expect.objectContaining({ payload: expect.objectContaining({ taskIds: [taskId, otherTaskId].sort() }) })]);
  });

  it("rolls back the project write and invalidation when mandatory context audit fails", async () => {
    await uploadReceipt();
    const before = await history();
    await rejectAudit(() => request(adminId, { githubRepo: "acme/rollback" }));
    expect(await history()).toEqual(before);
  });

  it("denies a non-admin before changing project context", async () => {
    await uploadReceipt();
    const before = await history();
    expect((await request(memberId, { githubRepo: "acme/denied" })).status).toBe(403);
    expect(await history()).toEqual(before);
  });

  it.each([
    ["team", "PATCH", "demote"], ["project", "PATCH", "demote"],
    ["team", "DELETE", "demote"], ["project", "DELETE", "demote"],
    ["team", "PATCH", "remove"], ["project", "PATCH", "remove"],
    ["team", "DELETE", "remove"], ["project", "DELETE", "remove"],
  ] as const)("rechecks %s admin authority while %s waits on the parent lock (%s grant)", async (source, method, revocation) => {
    if (source === "project") {
      await store.db.teamMember.update({ where: { teamId_userId: { teamId, userId: adminId } }, data: { role: "HUMAN_MEMBER" } });
      await store.db.projectMember.create({ data: { projectId, userId: adminId, role: "PROJECT_ADMIN", invitedById: memberId } });
    }
    await uploadReceipt();
    const before = await history();
    const blocker = store.connect();
    const observer = store.connect();
    const hold = barrier();
    const [waiting] = await store.db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    let blockingPid = 0;
    const held = blocker.$transaction(async db => {
      const [row] = await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM projects WHERE id = ${projectId} FOR UPDATE`;
      blockingPid = row!.pid;
      await hold.wait();
    }, { timeout: 10000 });
    await hold.reached;
    const pending = method === "PATCH" ? request(adminId, { githubRepo: "acme/revoked" }) : app(adminId).request(`/projects/${projectId}`, { method });
    let response: Response;
    try {
      await waitForParentLock(waiting!.pid, blockingPid, observer);
      if (source === "team") {
        const where = { teamId_userId: { teamId, userId: adminId } };
        if (revocation === "remove") await observer.teamMember.delete({ where });
        else await observer.teamMember.update({ where, data: { role: "HUMAN_MEMBER" } });
      } else {
        const where = { projectId_userId: { projectId, userId: adminId } };
        if (revocation === "remove") await observer.projectMember.delete({ where });
        else await observer.projectMember.update({ where, data: { role: "PROJECT_VIEWER" } });
      }
    } finally {
      hold.release();
      await held;
      response = await pending;
    }
    expect(response.status).toBe(403);
    expect(await history()).toEqual(before);
  });

  it("preserves normalized repository/template/governance retries and unrelated notification edits", async () => {
    // These writes establish normalized stored context before the receipt is issued.
    expect((await request(adminId, { taskTemplate: { fields: { goal: true } } })).status).toBe(200);
    const attemptId = await uploadReceipt();
    const binding = await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId } });
    const priorAudits = await store.db.auditLog.count({ where: { projectId, action: "project.grounding.context_mutated" } });
    for (const body of [
      { githubRepo: "acme/original" },
      { taskTemplate: { fields: { goal: true } } },
      { governanceMode: "AWAITS_CONFIRMATION" },
      { soloMode: false, requireDistinctReviewer: false },
      { name: "Grounding patch" },
      { notificationWebhookUrl: "https://hooks.example/project" },
    ]) {
      expect((await request(adminId, body)).status).toBe(200);
      expect(await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId } })).toEqual(binding);
      expect(await store.db.groundingAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ state: "ACTIVE" });
      expect(await store.db.auditLog.count({ where: { projectId, action: "project.grounding.context_mutated" } })).toBe(priorAudits);
    }
    expect(await store.db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ governanceMode: "AWAITS_CONFIRMATION", soloMode: false, requireDistinctReviewer: false });
  });
});

describe("grounding project DELETE mutations (PostgreSQL)", () => {
  it.each([null, "RESERVED", "DISPATCHED"] as const)("retains every history row and attachment byte when deletion is denied with operation %s", async state => {
    await uploadReceipt();
    const file = await attachment();
    if (state) await reserve(taskId, state);
    const before = await history();
    const response = await app(adminId).request(`/projects/${projectId}`, { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: state ? "grounding_finalization_pending" : "grounding_history_retained" });
    expect(await history()).toEqual(before);
    expect(await readFile(file.path)).toEqual(file.bytes);
  });

  it.each(["member", "agent"])("denies %s deletion before any row or attachment effects", async principal => {
    await uploadReceipt();
    const file = await attachment();
    const before = await history();
    const actor = principal === "member" ? memberId : { type: "agent" as const, tokenId: "test-agent", teamId, userId: adminId, scopes: ["projects:delete"] };
    const response = await app(actor).request(`/projects/${projectId}`, { method: "DELETE" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden", message: principal === "member" ? "Only project admins can delete projects" : "Agents cannot delete projects" });
    expect(await history()).toEqual(before);
    expect(await readFile(file.path)).toEqual(file.bytes);
  });

  it("physically deletes a fresh unprovisioned project and its children, then reclaims its attachment", async () => {
    const file = await attachment();
    const comment = await store.db.comment.create({ data: { taskId, authorUserId: adminId, content: "Test-owned comment" } });
    const board = await store.db.board.create({ data: { projectId, name: "Test-owned board", config: {} } });
    const member = await store.db.projectMember.create({ data: { projectId, userId: memberId, role: "PROJECT_VIEWER", invitedById: adminId } });
    expect(await store.db.groundingCohort.count()).toBe(0);
    expect(await store.db.groundingBinding.count()).toBe(0);
    const response = await app(adminId).request(`/projects/${projectId}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(await store.db.project.findUnique({ where: { id: projectId } })).toBeNull();
    expect(await store.db.task.findUnique({ where: { id: taskId } })).toBeNull();
    expect(await store.db.taskAttachment.findUnique({ where: { id: file.row.id } })).toBeNull();
    expect(await store.db.comment.findUnique({ where: { id: comment.id } })).toBeNull();
    expect(await store.db.board.findUnique({ where: { id: board.id } })).toBeNull();
    expect(await store.db.projectMember.findUnique({ where: { id: member.id } })).toBeNull();
    await expect(readFile(file.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.db.groundingReceipt.count()).toBe(0);
    expect(await store.db.groundingOperation.count()).toBe(0);
  });
});
