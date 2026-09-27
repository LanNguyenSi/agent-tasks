import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { completionStore, completionFixture, completionActor } from "../helpers/grounding-completion-fixtures.js";
import { ids } from "../helpers/grounding-fixtures.js";
import { GroundingMigrationService, type GroundingMigrationRequest } from "../../src/services/grounding-migration.js";
import { createGroundingMigrationRouter } from "../../src/routes/grounding-migration.js";
import type { Actor } from "../../src/types/auth.js";
import type { AppVariables } from "../../src/types/hono.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
const admin: Actor = { type: "human", userId: ids.user };
const hold: GroundingMigrationRequest = { action: "hold", key: "hold", reason: "Investigate compatibility", expectedRevision: 0 };
const pin: GroundingMigrationRequest = { action: "pin_legacy", key: "pin", reason: "Repair pinned reference", expectedRevision: 1, sessionId: "legacy.pinned", phase: "complete" };
const migrate: GroundingMigrationRequest = { action: "migrate_external", key: "migrate", reason: "Approved external enrollment", expectedRevision: 1, subjectMode: "CODE_HEAD" };
const resume: GroundingMigrationRequest = { action: "resume", key: "resume", reason: "Readiness reviewed", expectedRevision: 2 };
const service = (db = store.db) => new GroundingMigrationService({ db, config: { audience: "consumer.test", trust: () => f.issuer.trust }, legacyClient: f.ledger });
async function unprovisioned() { return store.db.task.create({ data: { projectId: f.projectId, title: "Historical", metadata: { groundingSessionId: "metadata-is-not-authority", custom: 1 }, status: "in_progress" } }); }
async function history(taskId: string) {
  return { state: await store.db.groundingMigrationState.findUnique({ where: { taskId } }), commands: await store.db.groundingMigrationCommand.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } }), audits: await store.db.auditLog.findMany({ where: { taskId, action: "task.grounding.migration" }, orderBy: { createdAt: "asc" } }) };
}
beforeAll(async () => { store = await completionStore(); }, 60000);
afterAll(async () => { await store?.close(); });
beforeEach(async () => { f = await completionFixture(store); });

it("requires live human administrative membership including for exact retries", async () => {
  await expect(service().execute(f.taskId, completionActor, hold)).rejects.toMatchObject({ code: "forbidden" });
  for (const role of ["HUMAN_MEMBER", "REVIEWER"] as const) {
    await store.db.teamMember.update({ where: { teamId_userId: { teamId: ids.team, userId: ids.user } }, data: { role } });
    await expect(service().execute(f.taskId, admin, hold)).rejects.toMatchObject({ code: "forbidden" });
  }
  await store.db.teamMember.update({ where: { teamId_userId: { teamId: ids.team, userId: ids.user } }, data: { role: "ADMIN" } });
  await service().execute(f.taskId, admin, hold);
  await store.db.teamMember.delete({ where: { teamId_userId: { teamId: ids.team, userId: ids.user } } });
  try { await expect(service().execute(f.taskId, admin, hold)).rejects.toMatchObject({ code: "forbidden" }); }
  finally { await store.db.teamMember.create({ data: { teamId: ids.team, userId: ids.user, role: "ADMIN" } }); }
  expect((await history(f.taskId)).commands).toHaveLength(1);
});

it("accepts project admins and rejects contributor/viewer/foreign humans", async () => {
  const user = await store.db.user.create({ data: { login: randomUUID() } });
  const actor: Actor = { type: "human", userId: user.id };
  await expect(service().execute(f.taskId, actor, hold)).rejects.toMatchObject({ code: "forbidden" });
  for (const role of ["PROJECT_VIEWER", "PROJECT_CONTRIBUTOR", "PROJECT_ADMIN"] as const) {
    await store.db.projectMember.upsert({ where: { projectId_userId: { projectId: f.projectId, userId: user.id } }, create: { projectId: f.projectId, userId: user.id, invitedById: ids.user, role }, update: { role } });
    if (role === "PROJECT_ADMIN") expect(await service().execute(f.taskId, actor, hold)).toMatchObject({ held: true });
    else await expect(service().execute(f.taskId, actor, hold)).rejects.toMatchObject({ code: "forbidden" });
  }
  await expect(service().execute(f.taskId, admin, hold)).rejects.toMatchObject({ code: "grounding_operation_conflict" });
});

it("audits before/after and exact requests, invalidates attempts, and preserves all evidence", async () => {
  await f.evidence(); const before = await f.snapshot();
  const result = await service().execute(f.taskId, admin, hold);
  const held = await f.snapshot();
  expect(held.task).toEqual(before.task); expect(held.cohort).toEqual(before.cohort); expect(held.receipts).toEqual(before.receipts);
  expect(held.attempts[0].state).toBe("SUPERSEDED"); expect(held.binding).toMatchObject({ activeAttemptId: null, contextDigest: null, contextRevision: before.binding!.contextRevision + 1 });
  expect(await service().execute(f.taskId, admin, hold)).toEqual(result);
  const h = await history(f.taskId); expect(h.commands).toHaveLength(1); expect(h.audits).toHaveLength(1);
  expect(h.commands[0]).toMatchObject({ actorId: ids.user, request: hold, before: { state: null }, after: { state: { held: true, revision: 1 } } });
  expect(h.audits[0].payload).toMatchObject({ reason: hold.reason, before: h.commands[0].before, after: h.commands[0].after });
  for (const changed of [{ ...hold, reason: `${hold.reason} ` }, { ...hold, expectedRevision: 1 }, { ...hold, key: "stale" }]) await expect(service().execute(f.taskId, admin, changed)).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  expect(await history(f.taskId)).toEqual(h);
});

it("concurrent identical commands commit once; divergent same-revision commands conflict", async () => {
  const results = await Promise.all([service().execute(f.taskId, admin, hold), service(store.connect()).execute(f.taskId, admin, hold)]);
  expect(results[0]).toEqual(results[1]); expect((await history(f.taskId)).commands).toHaveLength(1);
  const commands = [{ ...migrate, key: "a" }, { ...migrate, key: "b" }];
  const attempts = await Promise.allSettled(commands.map(command => service(store.connect()).execute(f.taskId, admin, command)));
  expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect((await history(f.taskId)).state?.revision).toBe(2);
});

it.each(["UNPROVISIONED", "LEGACY_LOCAL", "OFF"] as const)("migrates %s only while held and retains task metadata", async mode => {
  const task = mode === "UNPROVISIONED" ? await unprovisioned() : await (async () => { f = await completionFixture(store, mode); return f.task(); })();
  await expect(service().execute(task.id, admin, { ...migrate, expectedRevision: 0 })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  await service().execute(task.id, admin, hold);
  await service().execute(task.id, admin, migrate);
  expect((await history(task.id)).state).toMatchObject({ held: true, revision: 2 });
  expect(await store.db.groundingCohort.findUnique({ where: { taskId: task.id } })).toMatchObject({ mode: "EXTERNAL_V1", protected: true });
  expect(await service().execute(task.id, admin, resume)).toMatchObject({ held: false, revision: 3 });
  expect(await store.db.task.findUnique({ where: { id: task.id } })).toEqual(task);
  expect(await service().execute(task.id, admin, hold)).toMatchObject({ held: true, revision: 1 });
  expect((await history(task.id)).state?.held).toBe(false);
});

it("pins explicit legacy data and only resumes after backend ledger readiness", async () => {
  const task = await unprovisioned();
  await service().execute(task.id, admin, hold); await service().execute(task.id, admin, pin);
  for (const count of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    f.ledger.getLedgerSummary.mockResolvedValueOnce({ entryCount: count });
    await expect(service().execute(task.id, admin, resume)).rejects.toMatchObject({ code: "grounding_operation_conflict" });
    expect((await history(task.id)).state?.held).toBe(true);
  }
  f.ledger.getLedgerSummary.mockRejectedValueOnce(new Error("local ledger unavailable"));
  await expect(service().execute(task.id, admin, resume)).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
  expect(await service().execute(task.id, admin, resume)).toMatchObject({ held: false });
  expect(f.ledger.getLedgerSummary).toHaveBeenLastCalledWith("legacy.pinned");
});

it("repairs malformed legacy references while held and rejects early phases and OFF resume", async () => {
  f = await completionFixture(store, "LEGACY_LOCAL");
  await store.db.groundingCohort.update({ where: { taskId: f.taskId }, data: { legacySessionId: "bad session", legacyPhase: "nonsense" } });
  await service().execute(f.taskId, admin, hold);
  await expect(service().execute(f.taskId, admin, { ...resume, expectedRevision: 1 })).rejects.toBeInstanceOf(Error);
  await service().execute(f.taskId, admin, { ...pin, phase: "evidence-collection" });
  await expect(service().execute(f.taskId, admin, resume)).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  await service().execute(f.taskId, admin, { ...pin, key: "repair", expectedRevision: 2, phase: "claim-evaluation" });
  expect(await service().execute(f.taskId, admin, { ...resume, expectedRevision: 3 })).toMatchObject({ held: false });
  f = await completionFixture(store, "OFF"); await service().execute(f.taskId, admin, hold);
  await expect(service().execute(f.taskId, admin, { ...resume, expectedRevision: 1 })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  await expect(service().execute(f.taskId, admin, pin)).rejects.toMatchObject({ code: "grounding_operation_conflict" });
});

it("external rollback never converts history or relaxes current trust and policy", async () => {
  await f.evidence(); const completed = await f.service.complete(f.taskId, completionActor, "finish", { action: "finish" });
  const old = await f.snapshot(); await service().execute(f.taskId, admin, hold);
  const held = await f.snapshot();
  expect(await f.service.complete(f.taskId, completionActor, "finish", { action: "finish" })).toEqual(completed);
  expect(await f.snapshot()).toEqual(held);
  await expect(service().execute(f.taskId, admin, pin)).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  f.issuer.trust = [];
  await expect(service().execute(f.taskId, admin, migrate)).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
  await expect(service().execute(f.taskId, admin, { ...resume, expectedRevision: 1 })).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
  const after = await f.snapshot();
  expect(after.receipts).toEqual(old.receipts); expect(after.operations).toEqual(old.operations); expect(after.finalizations).toEqual(old.finalizations); expect(after.attempts).toEqual(old.attempts);
  await expect(store.db.task.delete({ where: { id: f.taskId } })).rejects.toThrow();
  await expect(store.db.project.delete({ where: { id: f.projectId } })).rejects.toThrow();
});

it.each(["done", "abandoned", "unknown", "merge_sha", "operation", "create_operation", "group_seed", "group_member", "finalization", "reservation"])("refuses unsafe %s with no partial effects", async kind => {
  if (["done", "abandoned", "unknown"].includes(kind)) await store.db.task.update({ where: { id: f.taskId }, data: { status: kind } });
  if (kind === "merge_sha") await store.db.task.update({ where: { id: f.taskId }, data: { autoMergeSha: "a".repeat(40) } });
  if (kind === "create_operation") await store.db.groundingGithubCreateOperation.create({ data: { id: randomUUID(), taskId: f.taskId, projectId: f.projectId, key: "orphan", actorId: ids.agent, actorUserId: ids.user, actorTeamId: ids.team, fingerprint: "x", request: {}, delegateUserId: ids.user, state: "DISPATCHED" } });
  if (kind === "group_seed" || kind === "group_member") {
    const seed = kind === "group_seed" ? f.taskId : (await unprovisioned()).id;
    const group = await store.db.groundingGithubMergeGroup.create({ data: { id: randomUUID(), seedTaskId: seed, key: "orphan", actorId: ids.user, actorType: "human", fingerprint: "x", request: {}, repo: "acme/repo", dispatchRepo: "acme/repo", prNumber: 42, headSha: "a".repeat(40), mergeMethod: "squash", state: "DISPATCHED" } });
    if (kind === "group_member") {
      const operation = await store.db.groundingOperation.create({ data: { taskId: f.taskId, key: "orphan", actorId: ids.user, actorType: "human", fingerprint: "x", request: {}, decision: {}, state: "COMPLETED" } });
      await store.db.groundingGithubMergeMember.create({ data: { groupId: group.id, taskId: f.taskId, operationId: operation.id, role: "GUARD" } });
    }
  }
  if (kind === "operation") await store.db.groundingOperation.create({ data: { taskId: f.taskId, key: "orphan", actorId: ids.user, actorType: "human", fingerprint: "x", request: {}, decision: {}, state: "DISPATCHED" } });
  if (kind === "finalization" || kind === "reservation") { await f.evidence("merge"); await f.service.reserveMerge(f.taskId, completionActor, "remote"); if (kind === "finalization") { await store.db.groundingCohort.update({ where: { taskId: f.taskId }, data: { reservationId: null } }); await store.db.groundingOperation.updateMany({ where: { taskId: f.taskId }, data: { state: "CANCELLED" } }); } }
  const before = await f.snapshot(); await expect(service().execute(f.taskId, admin, hold)).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  expect(await f.snapshot()).toEqual(before); expect((await history(f.taskId)).state).toBeNull();
});

it("rolls back hold, invalidation and command on mandatory audit failure", async () => {
  await f.evidence(); const before = await f.snapshot();
  await store.db.$executeRawUnsafe(`CREATE FUNCTION reject_migration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'task.grounding.migration' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await store.db.$executeRawUnsafe('CREATE TRIGGER reject_migration_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_migration_audit()');
  try { await expect(service().execute(f.taskId, admin, hold)).rejects.toMatchObject({ code: "grounding_verification_unavailable" }); }
  finally { await store.db.$executeRawUnsafe('DROP TRIGGER reject_migration_audit ON audit_logs'); await store.db.$executeRawUnsafe('DROP FUNCTION reject_migration_audit()'); }
  expect(await f.snapshot()).toEqual(before); expect((await history(f.taskId)).state).toBeNull(); expect((await history(f.taskId)).commands).toHaveLength(0);
  await service().execute(f.taskId, admin, hold);
  await expect(store.db.groundingMigrationCommand.updateMany({ where: { taskId: f.taskId }, data: { actorId: "altered" } })).rejects.toThrow();
  await expect(store.db.groundingMigrationCommand.deleteMany({ where: { taskId: f.taskId } })).rejects.toThrow();
});

it("HTTP keeps administration dormant, human-only and strictly bounded with exact retries", async () => {
  const route = (actor?: Actor, configured = true) => { const app = new Hono<{ Variables: AppVariables }>(); if (actor) app.use("*", async (c, next) => { c.set("actor", actor); await next(); }); return app.route("/api", createGroundingMigrationRouter(configured ? service() : undefined)); };
  const request = (body: unknown = hold) => new Request(`http://test/api/tasks/${f.taskId}/grounding-migration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await route().fetch(request())).status).toBe(401);
  expect((await route(completionActor).fetch(request())).status).toBe(403);
  expect((await route(admin, false).fetch(request())).status).toBe(503);
  for (const body of [{ ...hold, extra: true }, { ...hold, action: "OFF" }, { ...hold, reason: " " }, { ...hold, expectedRevision: -1 }, { ...hold, reason: "x".repeat(20000) }]) expect((await route(admin).fetch(request(body))).status).toBe(400);
  const first = await route(admin).fetch(request()); expect(first.status).toBe(200);
  expect(await (await route(admin).fetch(request())).json()).toEqual(await first.json());
});


it("external resume rejects audience and policy drift and an incompatible subject conversion", async () => {
  await service().execute(f.taskId, admin, hold);
  await expect(service().execute(f.taskId, admin, { ...migrate, subjectMode: "TASK_SPEC" })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  const binding = await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId: f.taskId } });
  for (const patch of [{ audience: "wrong" }, { policyRevision: "wrong" }, { policySha256: "c".repeat(64) }, { protected: false }]) {
    await store.db.groundingBinding.update({ where: { taskId: f.taskId }, data: patch });
    await expect(service().execute(f.taskId, admin, { ...resume, expectedRevision: 1 })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
    await store.db.groundingBinding.update({ where: { taskId: f.taskId }, data: { audience: binding.audience, policyRevision: binding.policyRevision, policySha256: binding.policySha256, protected: binding.protected } });
  }
  expect(await service().execute(f.taskId, admin, { ...resume, expectedRevision: 1 })).toMatchObject({ held: false });
});
