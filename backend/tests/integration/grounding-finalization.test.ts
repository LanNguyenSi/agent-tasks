import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { completionStore, completionFixture, completionActor as actor } from "../helpers/grounding-completion-fixtures.js";
import { barrier } from "../helpers/grounding-postgres.js";
import { epoch, ids, session } from "../helpers/grounding-fixtures.js";
import { mutateGroundingContext } from "../../src/services/grounding-context-mutation.js";
import * as audit from "../../src/services/audit.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
beforeAll(async () => { store = await completionStore(); }, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => { f = await completionFixture(store); });
async function reserve() { await f.evidence("merge"); return f.service.reserveMerge(f.taskId, actor, "merge"); }

it("N-11 concurrent local consumers commit one operation, one receipt use and one audit across connections", async () => {
  await f.evidence(); const second = f.make(store.connect());
  const results = await Promise.all([f.service.complete(f.taskId, actor, "same", { action: "finish" }), second.complete(f.taskId, actor, "same", { action: "finish" })]);
  expect(results[0]).toEqual(results[1]);
  const snapshot = await f.snapshot(); expect(snapshot.operations).toHaveLength(1); expect(snapshot.finalizations).toHaveLength(1); expect(snapshot.audit).toHaveLength(1);
  const original = snapshot.operations[0];
  await expect(f.db.groundingOperation.create({ data: { ...original, id: randomUUID(), request: original.request as Prisma.InputJsonValue, decision: original.decision as Prisma.InputJsonValue, result: Prisma.JsonNull } })).rejects.toMatchObject({ code: "P2002" });
  const receipt = snapshot.finalizations[0];
  await expect(f.db.groundingFinalization.create({ data: { ...receipt, id: randomUUID(), operationId: null, target: receipt.target as Prisma.InputJsonValue, result: Prisma.JsonNull } })).rejects.toMatchObject({ code: "P2002" });
});

it("N-11 remote dispatch is once despite concurrent duplicates; timeout/restart reads only", async () => {
  await reserve(); const gate = barrier();
  f.merge.mockImplementationOnce(async () => { await gate.wait(); f.proof = { ...f.proof, merged: true, mergeCommitSha: "b".repeat(40) }; throw new Error("response lost"); });
  const first = f.service.dispatchMerge(f.taskId, actor, "merge"); await gate.reached;
  const concurrent = await f.make(store.connect()).dispatchMerge(f.taskId, actor, "merge");
  expect(concurrent).toMatchObject({ pending: true }); expect(f.merge).toHaveBeenCalledTimes(1);
  gate.release(); expect(await first).toMatchObject({ pending: true });
  const restarted = f.make(store.connect()); f.now += 10000; f.issuer.trust = [];
  expect(await restarted.dispatchMerge(f.taskId, actor, "merge")).toMatchObject({ status: "done", mergeCommitSha: "b".repeat(40) });
  expect(f.merge).toHaveBeenCalledTimes(1);
  const snapshot = await f.snapshot(); expect(snapshot.operations[0].state).toBe("COMPLETED"); expect(snapshot.audit).toHaveLength(1); expect(snapshot.cohort?.reservationId).toBeNull(); expect(snapshot.task?.claimedByAgentId).toBeNull();
  const replay = await restarted.reserveMerge(f.taskId, actor, "merge"); expect(replay.result).toMatchObject({ status: "done" });
  expect(await f.snapshot()).toEqual(snapshot);
});

it.each(["expiry", "trust", "head", "claim", "consent", "workflow"])("N-08 dispatch revalidates fresh %s before any remote effect", async change => {
  await reserve();
  if (change === "expiry") f.now = epoch + 900;
  if (change === "trust") f.issuer.trust = [];
  if (change === "head") f.head = "c".repeat(40);
  if (change === "claim") await f.db.task.update({ where: { id: f.taskId }, data: { claimedByAgentId: null } });
  if (change === "consent") await f.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } });
  if (change === "workflow") await f.db.project.update({ where: { id: f.projectId }, data: { taskTemplate: { changed: true } } });
  const before = await f.snapshot();
  try { await expect(f.service.dispatchMerge(f.taskId, actor, "merge")).rejects.toBeInstanceOf(Error); }
  finally { await f.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: true } }); }
  expect(f.merge).not.toHaveBeenCalled(); expect(await f.snapshot()).toEqual(before);
});

it("N-13 remote merge then DB audit failure preserves reservation and recovers original decision after TTL", async () => {
  await reserve(); const real = audit.logGroundingDecision;
  const hook = vi.spyOn(audit, "logGroundingDecision").mockRejectedValueOnce(new Error("database write failed"));
  try { await expect(f.service.dispatchMerge(f.taskId, actor, "merge")).rejects.toMatchObject({ code: "grounding_verification_unavailable" }); }
  finally { hook.mockRestore(); }
  expect(real).toBeTypeOf("function");
  const before = await f.snapshot(); expect(before.task?.status).toBe("in_progress"); expect(before.operations[0].state).toBe("DISPATCHED"); expect(before.audit).toHaveLength(0);
  f.now += 10000; f.issuer.trust = [];
  const result = await f.make(store.connect()).recoverMerge(f.taskId, actor, "merge");
  expect(result).toMatchObject({ status: "done", mergeCommitSha: "b".repeat(40) }); expect(f.merge).toHaveBeenCalledTimes(1);
  const after = await f.snapshot(); expect(after.audit).toHaveLength(1); expect(after.attempts[0].state).toBe("CONSUMED");
  expect(await f.service.recoverMerge(f.taskId, actor, "merge")).toEqual(result); expect(await f.snapshot()).toEqual(after);
});

it.each(["head", "repo", "pr", "open", "mergeCommit"])("N-13 recovery refuses %s proof and keeps reservation", async change => {
  await reserve(); f.merge.mockRejectedValueOnce(new Error("uncertain")); await f.service.dispatchMerge(f.taskId, actor, "merge");
  f.proof = { ...f.proof, merged: true, mergeCommitSha: "b".repeat(40) };
  if (change === "head") f.proof.headSha = "c".repeat(40);
  if (change === "repo") f.proof.repo = "wrong/repo";
  if (change === "pr") f.proof.prNumber = 43;
  if (change === "open") f.proof.merged = false;
  if (change === "mergeCommit") f.proof.mergeCommitSha = null;
  f.now += 10000; const before = await f.snapshot();
  expect(await f.service.recoverMerge(f.taskId, actor, "merge")).toMatchObject({ pending: true });
  expect(await f.snapshot()).toEqual(before); expect(f.merge).toHaveBeenCalledTimes(1);
});

it("N-16 unresolved reservation excludes every disposition, competing operation, C02 issuance/upload and whole context batch", async () => {
  const { challenge, receipt } = await f.evidence("merge"); await f.service.reserveMerge(f.taskId, actor, "merge");
  const before = await f.snapshot();
  for (const action of ["request_changes", "abandon", "release", "creator_abandon", "reopen"] as const) await expect(f.service.dispose(f.taskId, actor, action, { action })).rejects.toMatchObject({ code: "grounding_finalization_pending", status: 409 });
  await expect(f.service.complete(f.taskId, actor, "finish", { action: "finish" })).rejects.toMatchObject({ code: "grounding_finalization_pending" });
  await expect(f.attempts.issue(f.taskId, actor, "merge")).rejects.toMatchObject({ code: "grounding_finalization_pending", status: 409 });
  await expect(f.attempts.ingest(f.taskId, challenge.attemptId, actor, session, receipt)).rejects.toMatchObject({ code: "grounding_finalization_pending", status: 409 });
  const other = await f.db.task.create({ data: { projectId: f.projectId, title: "Other" } });
  const mutate = vi.fn(async (db: Prisma.TransactionClient) => { await db.project.update({ where: { id: f.projectId }, data: { taskTemplate: { new: true } } }); await db.task.updateMany({ where: { projectId: f.projectId }, data: { description: "corrupted" } }); });
  await expect(mutateGroundingContext(f.db, { projectIds: [f.projectId], audit: { actor, reason: "test context change" }, selectAndAuthorize: async db => (await db.task.findMany({ where: { projectId: f.projectId } })).map(t => t.id), mutate })).rejects.toMatchObject({ code: "grounding_finalization_pending" });
  expect(mutate).not.toHaveBeenCalled(); expect(await f.snapshot()).toEqual(before); expect((await f.db.task.findUniqueOrThrow({ where: { id: other.id } })).description).toBeNull();
});

it("context batch and reservation race serializes on shared project; winning mutation makes old evidence unusable", async () => {
  await f.evidence("merge"); const gate = barrier();
  const mutation = mutateGroundingContext(f.db, { projectIds: [f.projectId], audit: { actor, reason: "test context change" }, selectAndAuthorize: async () => [f.taskId], mutate: async db => { await db.task.update({ where: { id: f.taskId }, data: { title: "New title" } }); await gate.wait(); } });
  await gate.reached;
  const reserved = f.make(store.connect()).reserveMerge(f.taskId, actor, "merge");
  const denied = expect(reserved).rejects.toBeInstanceOf(Error); gate.release(); await mutation; await denied;
  expect((await f.snapshot()).operations).toHaveLength(0); expect((await f.task()).title).toBe("New title");
});

it.each(["claim", "spec", "workflow", "policy"])("recovery rejects nonparticipating writer %s drift and retains original decision", async change => {
  await reserve(); f.merge.mockImplementationOnce(async () => { f.proof = { ...f.proof, merged: true, mergeCommitSha: "b".repeat(40) }; throw new Error("lost response"); });
  await f.service.dispatchMerge(f.taskId, actor, "merge");
  if (change === "claim") await f.db.task.update({ where: { id: f.taskId }, data: { claimedByAgentId: null, claimedByUserId: ids.user } });
  if (change === "spec") await f.db.task.update({ where: { id: f.taskId }, data: { description: "different work" } });
  if (change === "workflow") await f.db.project.update({ where: { id: f.projectId }, data: { taskTemplate: { changed: true } } });
  if (change === "policy") await f.db.groundingBinding.update({ where: { taskId: f.taskId }, data: { policySha256: "c".repeat(64) } });
  const before = await f.snapshot();
  await expect(f.service.recoverMerge(f.taskId, actor, "merge")).rejects.toBeInstanceOf(Error);
  expect(await f.snapshot()).toEqual(before); expect(f.merge).toHaveBeenCalledOnce();
});

it.each(["OFF", "LEGACY_LOCAL"] as const)("receipt-free %s remote decision still reserves, dispatches once and recovers", async mode => {
  const other = await completionFixture(store, mode);
  await other.service.reserveMerge(other.taskId, actor, "merge");
  await other.service.dispatchMerge(other.taskId, actor, "merge");
  const snapshot = await other.snapshot();
  expect(snapshot.task?.status).toBe("done"); expect(snapshot.operations[0].state).toBe("COMPLETED");
  expect(snapshot.receipts).toHaveLength(0); expect(snapshot.finalizations).toHaveLength(0); expect(snapshot.audit).toHaveLength(1);
  await other.service.dispatchMerge(other.taskId, actor, "merge"); expect(other.merge).toHaveBeenCalledOnce();
});

it("expired undispatched reservation can be audited-cancelled and replaced by fresh evidence", async () => {
  await reserve(); f.now += 10000;
  await expect(f.service.dispatchMerge(f.taskId, actor, "merge")).rejects.toBeInstanceOf(Error);
  const cancelled = await f.service.cancelMerge(f.taskId, actor, "merge", "expired before dispatch");
  expect(cancelled).toMatchObject({ state: "CANCELLED" });
  const snapshot = await f.snapshot(); expect(snapshot.cohort?.reservationId).toBeNull(); expect(snapshot.attempts[0].state).toBe("SUPERSEDED");
  expect(snapshot.audit[0].action).toBe("task.grounding.cancelled");
  expect(await f.service.cancelMerge(f.taskId, actor, "merge", "expired before dispatch")).toEqual(cancelled); expect(await f.snapshot()).toEqual(snapshot);
  await expect(f.service.cancelMerge(f.taskId, actor, "merge", "different reason")).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  await f.evidence("merge"); await f.service.reserveMerge(f.taskId, actor, "fresh");
  expect(await f.service.dispatchMerge(f.taskId, actor, "fresh")).toMatchObject({ status: "done" }); expect(f.merge).toHaveBeenCalledOnce();
});

it("cancel/dispatch race: durable dispatch winner cannot be cancelled even while provider is pending", async () => {
  await reserve(); const gate = barrier(); f.merge.mockImplementationOnce(async () => { await gate.wait(); throw new Error("uncertain"); });
  const dispatch = f.service.dispatchMerge(f.taskId, actor, "merge"); await gate.reached;
  try { await expect(f.make(store.connect()).cancelMerge(f.taskId, actor, "merge", "cancel race")).rejects.toMatchObject({ code: "grounding_finalization_pending" }); }
  finally { gate.release(); }
  await dispatch; expect((await f.snapshot()).operations[0].state).toBe("DISPATCHED"); expect(f.merge).toHaveBeenCalledOnce();
});

it("cancel/dispatch race: cancellation winning transaction lock prevents every remote effect", async () => {
  await reserve(); const gate = barrier(); const real = audit.logGroundingDecision;
  const hook = vi.spyOn(audit, "logGroundingDecision").mockImplementationOnce(async (db, input) => { await real(db, input); await gate.wait(); });
  const cancel = f.service.cancelMerge(f.taskId, actor, "merge", "cancel first"); await gate.reached;
  const dispatch = f.make(store.connect()).dispatchMerge(f.taskId, actor, "merge"); gate.release();
  try { await cancel; expect(await dispatch).toMatchObject({ state: "CANCELLED" }); }
  finally { hook.mockRestore(); }
  expect(f.merge).not.toHaveBeenCalled(); expect((await f.snapshot()).audit).toHaveLength(1);
});

it("N-16 reserved context batch cannot write either participating task or project", async () => {
  await reserve(); const other = await f.db.task.create({ data: { projectId: f.projectId, title: "Other" } });
  const before = await f.snapshot();
  await expect(mutateGroundingContext(f.db, { projectIds: [f.projectId], audit: { actor, reason: "batch" }, selectAndAuthorize: async db => (await db.task.findMany({ where: { projectId: f.projectId } })).map(t => t.id), mutate: async db => {
    await db.task.updateMany({ where: { projectId: f.projectId }, data: { title: "corrupted" } });
    await db.project.update({ where: { id: f.projectId }, data: { taskTemplate: { corrupted: true } } });
  } })).rejects.toMatchObject({ code: "grounding_finalization_pending" });
  expect(await f.snapshot()).toEqual(before); expect((await f.db.task.findUniqueOrThrow({ where: { id: other.id } })).title).toBe("Other");
  expect((await f.db.project.findUniqueOrThrow({ where: { id: f.projectId } })).taskTemplate).toBeNull();
});

it("cancellation requires originating actor, current access and reason; audit failure retains reservation", async () => {
  await reserve(); const before = await f.snapshot();
  await expect(f.service.cancelMerge(f.taskId, actor, "merge", " ")).rejects.toMatchObject({ code: "bad_state" });
  await expect(f.service.cancelMerge(f.taskId, actor, "merge", null as unknown as string)).rejects.toMatchObject({ code: "bad_state" });
  await expect(f.service.cancelMerge(f.taskId, { type: "human", userId: ids.user }, "merge", "cancel")).rejects.toMatchObject({ code: "forbidden" });
  await expect(f.service.cancelMerge(f.taskId, { ...actor, teamId: "different", userId: "different" }, "merge", "cancel")).rejects.toMatchObject({ code: "forbidden" });
  const hook = vi.spyOn(audit, "logGroundingDecision").mockRejectedValueOnce(new Error("audit failed"));
  try { await expect(f.service.cancelMerge(f.taskId, actor, "merge", "cancel")).rejects.toMatchObject({ code: "grounding_verification_unavailable" }); }
  finally { hook.mockRestore(); }
  expect(await f.snapshot()).toEqual(before);
});
