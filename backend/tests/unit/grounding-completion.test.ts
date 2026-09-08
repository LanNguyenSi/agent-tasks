import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import * as audit from "../../src/services/audit.js";
import { completionStore, completionFixture, completionActor as actor } from "../helpers/grounding-completion-fixtures.js";
import { ids, epoch } from "../helpers/grounding-fixtures.js";
import { mutateGroundingContext } from "../../src/services/grounding-context-mutation.js";
import { provisionGroundingCohort } from "../../src/services/grounding-cohort.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
beforeAll(async () => { store = await completionStore(); }, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => { f = await completionFixture(store); });

it("uses semantic review and terminal edges, consumes once, and retains author during review", async () => {
  await f.workflow(); await f.evidence();
  const result = await f.service.complete(f.taskId, actor, "finish", { action: "finish", result: "done work" });
  expect(result).toMatchObject({ status: "checking", receiptId: expect.any(String) });
  expect(await f.task()).toMatchObject({ status: "checking", claimedByAgentId: ids.agent, result: "done work" });
  expect((await f.snapshot()).attempts[0].state).toBe("CONSUMED");
  await f.evidence("approve");
  await f.service.complete(f.taskId, actor, "approve", { action: "approve" });
  expect(await f.task()).toMatchObject({ status: "shipped", claimedByAgentId: null, reviewClaimedByAgentId: null });
  expect((await f.snapshot()).audit).toHaveLength(2);
});

it.each(["description", "head", "workflow", "project"])("N-06 completion rejects fresh context drift: %s", async change => {
  await f.evidence();
  if (change === "description") await f.db.task.update({ where: { id: f.taskId }, data: { description: "Changed" } });
  if (change === "head") f.head = "c".repeat(40);
  if (change === "workflow") { await f.workflow(); await f.db.task.update({ where: { id: f.taskId }, data: { status: "in_progress" } }); }
  if (change === "project") await f.db.project.update({ where: { id: f.projectId }, data: { taskTemplate: { changed: true } } });
  const before = await f.snapshot();
  await expect(f.service.complete(f.taskId, actor, "finish", { action: "finish" })).rejects.toBeInstanceOf(Error);
  expect(await f.snapshot()).toEqual(before);
});

it("N-08 expiry during mandatory audit rolls back task, consumption, operation and audit", async () => {
  await f.evidence(); const before = await f.snapshot();
  const real = audit.logGroundingDecision;
  const hook = vi.spyOn(audit, "logGroundingDecision").mockImplementation(async (db, input) => { await real(db, input); f.now = epoch + 900; });
  try { await expect(f.service.complete(f.taskId, actor, "finish", { action: "finish" })).rejects.toMatchObject({ code: "grounding_receipt_stale" }); }
  finally { hook.mockRestore(); }
  expect(await f.snapshot()).toEqual(before);
});

it("N-11 committed retry returns immutable history after claim release and expiry; request/actor/access changes reject", async () => {
  await f.db.task.update({ where: { id: f.taskId }, data: { status: "review" } }); await f.evidence("approve");
  const result = await f.service.complete(f.taskId, actor, "approve", { action: "approve", result: "first" });
  const before = await f.snapshot(); f.now += 10000; f.issuer.trust = [];
  const other = store.connect();
  expect(await f.make(other).complete(f.taskId, actor, "approve", { action: "approve", result: "first" })).toEqual(result);
  expect(await f.snapshot()).toEqual(before);
  await expect(f.service.complete(f.taskId, actor, "approve", { action: "approve", result: "different" })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  await expect(f.service.complete(f.taskId, { type: "human", userId: ids.user }, "approve", { action: "approve", result: "first" })).rejects.toMatchObject({ code: "forbidden" });
  await expect(f.service.complete(f.taskId, { ...actor, teamId: "different", userId: "different" }, "approve", { action: "approve", result: "first" })).rejects.toMatchObject({ code: "forbidden" });
  await expect(f.service.complete(f.taskId, actor, "new", { action: "approve" })).rejects.toMatchObject({ code: "bad_state" });
});

it("mandatory audit database error rolls back every decision write", async () => {
  await f.evidence(); const before = await f.snapshot();
  await f.db.$executeRawUnsafe(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$`);
  await f.db.$executeRawUnsafe(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_audit()`);
  try { await expect(f.service.complete(f.taskId, actor, "finish", { action: "finish" })).rejects.toMatchObject({ code: "grounding_verification_unavailable" }); }
  finally { await f.db.$executeRawUnsafe(`DROP TRIGGER fail_audit ON audit_logs`); await f.db.$executeRawUnsafe(`DROP FUNCTION fail_audit()`); }
  expect(await f.snapshot()).toEqual(before);
});

it("N-17 grounding-only override requires human admin and nonblank reason", async () => {
  await expect(f.service.complete(f.taskId, actor, "override-agent", { action: "finish", overrideReason: "needed" })).rejects.toMatchObject({ code: "forbidden" });
  const human = { type: "human" as const, userId: ids.user };
  await f.db.task.update({ where: { id: f.taskId }, data: { claimedByAgentId: null, claimedByUserId: ids.user } });
  await expect(f.service.complete(f.taskId, human, "blank", { action: "finish", overrideReason: " " })).rejects.toMatchObject({ code: "bad_state" });
  await f.db.teamMember.update({ where: { teamId_userId: { teamId: ids.team, userId: ids.user } }, data: { role: "HUMAN_MEMBER" } });
  try { await expect(f.service.complete(f.taskId, human, "member", { action: "finish", overrideReason: "needed" })).rejects.toMatchObject({ code: "forbidden" }); }
  finally { await f.db.teamMember.update({ where: { teamId_userId: { teamId: ids.team, userId: ids.user } }, data: { role: "ADMIN" } }); }
  await f.service.complete(f.taskId, human, "admin", { action: "finish", overrideReason: " documented reason " });
  const snapshot = await f.snapshot();
  expect(snapshot.task?.status).toBe("review"); expect(snapshot.receipts).toHaveLength(0); expect(snapshot.finalizations).toHaveLength(0);
  expect(snapshot.audit[0]).toMatchObject({ action: "task.grounding.overridden", actorId: ids.user });
  expect(snapshot.audit[0].payload).toMatchObject({ decision: { overrideReason: "documented reason" } });
});

it.each(["scope", "claim", "state", "review", "ci", "foreign", "consent"])("unrelated %s gate remains required including override", async gate => {
  const human = { type: "human" as const, userId: ids.user };
  await f.db.task.update({ where: { id: f.taskId }, data: { claimedByAgentId: null, claimedByUserId: ids.user } });
  if (gate === "claim") await f.db.task.update({ where: { id: f.taskId }, data: { claimedByUserId: null } });
  if (gate === "state") await f.db.task.update({ where: { id: f.taskId }, data: { status: "open" } });
  if (gate === "review") { await f.db.task.update({ where: { id: f.taskId }, data: { status: "review" } }); await f.db.project.update({ where: { id: f.projectId }, data: { requireDistinctReviewer: true } }); }
  if (gate === "ci") { await f.workflow(["ciGreen"]); await f.db.user.update({ where: { id: ids.user }, data: { allowAgentPrCreate: false } }); }
  if (gate === "foreign") await f.db.task.update({ where: { id: f.taskId }, data: { deliverableRepo: "elsewhere/repo" } });
  if (gate === "consent") await f.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } });
  const before = await f.snapshot();
  try {
    if (gate === "scope") await expect(f.service.complete(f.taskId, { ...actor, scopes: [] }, "try", { action: "finish" })).rejects.toMatchObject({ code: "forbidden" });
    else if (["foreign", "consent"].includes(gate)) await expect(f.service.reserveMerge(f.taskId, human, "try", { overrideReason: "grounding only" })).rejects.toBeInstanceOf(Error);
    else await expect(f.service.complete(f.taskId, human, "try", { action: gate === "review" ? "approve" : "finish", overrideReason: "grounding only" })).rejects.toBeInstanceOf(Error);
  } finally { await f.db.user.update({ where: { id: ids.user }, data: { allowAgentPrCreate: true, allowAgentPrMerge: true } }); }
  expect(await f.snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
});

it("N-23 external outage cannot call legacy or OFF, despite metadata/config attempts", async () => {
  await f.evidence(); f.issuer.trust = [];
  await f.db.task.update({ where: { id: f.taskId }, data: { metadata: { debugFlavor: false, groundingSessionId: "fake", pass: true } } });
  const before = await f.snapshot();
  await expect(f.service.complete(f.taskId, actor, "outage", { action: "finish" })).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
  expect(await f.snapshot()).toEqual(before); expect(f.ledger.getLedgerSummary).not.toHaveBeenCalled();
  await expect(provisionGroundingCohort(f.db, { taskId: f.taskId, projectId: f.projectId, cohort: { mode: "OFF", protected: false, provenance: "test", legacySessionId: null, legacyPhase: null } })).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
});

it("explicit OFF/legacy modes do not manufacture receipts; missing enrollment blocks", async () => {
  const off = await completionFixture(store, "OFF"); await off.service.complete(off.taskId, actor, "off", { action: "finish" });
  expect((await off.snapshot()).receipts).toHaveLength(0); expect(off.ledger.getLedgerSummary).not.toHaveBeenCalled();
  const legacy = await completionFixture(store, "LEGACY_LOCAL");
  await legacy.db.task.update({ where: { id: legacy.taskId }, data: { metadata: { groundingSessionId: "fake", groundingPhase: "fake" } } });
  await legacy.service.complete(legacy.taskId, actor, "legacy", { action: "finish" });
  expect(legacy.ledger.getLedgerSummary).toHaveBeenCalledWith("legacy.session"); expect((await legacy.snapshot()).receipts).toHaveLength(0);
  const absent = await completionFixture(store, "OFF"); await absent.db.groundingCohort.delete({ where: { taskId: absent.taskId } });
  await expect(absent.service.complete(absent.taskId, actor, "absent", { action: "finish" })).rejects.toMatchObject({ code: "grounding_not_provisioned" });
});

it.each(["phase", "session", "ledger"])("legacy %s failure never weakens protection", async change => {
  const legacy = await completionFixture(store, "LEGACY_LOCAL");
  if (change === "phase") await legacy.db.groundingCohort.update({ where: { taskId: legacy.taskId }, data: { legacyPhase: "scope-resolution" } });
  if (change === "session") await legacy.db.groundingCohort.update({ where: { taskId: legacy.taskId }, data: { legacySessionId: null } });
  if (change === "ledger") legacy.ledger.getLedgerSummary.mockResolvedValue({ entryCount: 0 });
  await expect(legacy.service.complete(legacy.taskId, actor, "bad", { action: "finish" })).rejects.toBeInstanceOf(Error);
  expect((await legacy.task()).status).toBe("in_progress");
});

it.each(["abandon", "release", "request_changes", "creator_abandon", "reopen"] as const)("N-16 %s is a concrete auditable non-success decision invalidating evidence", async action => {
  await f.evidence();
  let requester: typeof actor | { type: "human"; userId: string } = actor;
  if (action === "request_changes") await f.db.task.update({ where: { id: f.taskId }, data: { status: "review", reviewClaimedByAgentId: ids.agent } });
  if (action === "creator_abandon") await f.db.task.update({ where: { id: f.taskId }, data: { status: "backlog", claimedByAgentId: null } });
  if (action === "reopen") { await f.db.task.update({ where: { id: f.taskId }, data: { status: "abandoned", claimedByAgentId: null } }); requester = { type: "human", userId: ids.user }; }
  await f.service.dispose(f.taskId, requester, action, { action, reason: "non-success" });
  const snapshot = await f.snapshot();
  expect(snapshot.attempts[0].state).toBe("SUPERSEDED"); expect(snapshot.binding?.activeAttemptId).toBeNull(); expect(snapshot.binding?.contextRevision).toBe(2);
  expect(snapshot.audit[0].action).toBe("task.grounding.disposed");
  expect(snapshot.task?.status).toBe(action === "request_changes" ? "in_progress" : action === "creator_abandon" ? "abandoned" : "open");
  if (action === "request_changes") expect(snapshot.task).toMatchObject({ claimedByAgentId: ids.agent, reviewClaimedByAgentId: null });
});

it("N-16 authorized context mutation changes actual rows and invalidates; a thrown mutation fully rolls back", async () => {
  await f.evidence(); const before = await f.snapshot();
  const input = { projectIds: [f.projectId], audit: { actor, reason: "test context change" }, selectAndAuthorize: async (db: Prisma.TransactionClient) => (await db.task.findMany({ where: { projectId: f.projectId } })).map(t => t.id) };
  await expect(mutateGroundingContext(f.db, { ...input, mutate: async db => { await db.task.update({ where: { id: f.taskId }, data: { description: "rollback" } }); throw new Error("rollback"); } })).rejects.toBeInstanceOf(Error);
  expect(await f.snapshot()).toEqual(before);
  await mutateGroundingContext(f.db, { ...input, mutate: async db => { await db.task.update({ where: { id: f.taskId }, data: { description: "new" } }); } });
  expect(await f.task()).toMatchObject({ description: "new" });
  expect((await f.snapshot()).binding).toMatchObject({ contextRevision: 2, activeAttemptId: null, contextDigest: null });
});

it("missing evidence is a required-evidence decision, while storage outage fails unavailable", async () => {
  await expect(f.service.complete(f.taskId, actor, "none", { action: "finish" })).rejects.toMatchObject({ code: "grounding_required" });
  await f.attempts.issue(f.taskId, actor, "finish");
  await expect(f.service.complete(f.taskId, actor, "unissued", { action: "finish" })).rejects.toMatchObject({ code: "grounding_required" });
  const before = await f.snapshot();
  const hook = vi.spyOn(f.db, "$transaction").mockRejectedValueOnce(new Error("storage offline"));
  try { await expect(f.service.complete(f.taskId, actor, "offline", { action: "finish" })).rejects.toMatchObject({ code: "grounding_verification_unavailable" }); }
  finally { hook.mockRestore(); }
  expect(await f.snapshot()).toEqual(before); expect(f.ledger.getLedgerSummary).not.toHaveBeenCalled();
});

it("context audit database failure rolls back the actual mutation and all invalidation", async () => {
  await f.evidence(); const before = await f.snapshot();
  await f.db.$executeRawUnsafe(`CREATE FUNCTION fail_context_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$`);
  await f.db.$executeRawUnsafe(`CREATE TRIGGER fail_context_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_context_audit()`);
  try {
    await expect(mutateGroundingContext(f.db, { projectIds: [f.projectId], audit: { actor, reason: "test" }, selectAndAuthorize: async () => [f.taskId], mutate: async db => {
      await db.task.update({ where: { id: f.taskId }, data: { description: "must roll back" } });
    } })).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
  } finally { await f.db.$executeRawUnsafe(`DROP TRIGGER fail_context_audit ON audit_logs`); await f.db.$executeRawUnsafe(`DROP FUNCTION fail_context_audit()`); }
  expect(await f.snapshot()).toEqual(before);
});
