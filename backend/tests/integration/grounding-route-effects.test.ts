import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { completionStore, completionFixture, completionActor as actor } from "../helpers/grounding-completion-fixtures.js";
import { ids } from "../helpers/grounding-fixtures.js";
import type { OperationInput } from "../../src/services/grounding-operations.js";
import * as audit from "../../src/services/audit.js";
import * as checks from "../../src/services/github-checks.js";
import * as reviewGate from "../../src/services/review-gate.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
beforeAll(async () => { store = await completionStore(); }, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => { f = await completionFixture(store); });
afterEach(() => { vi.restoreAllMocks(); });
type RouteKind = NonNullable<OperationInput["route"]>["kind"];
function input(kind: RouteKind, action: OperationInput["action"], remote = false, result?: string): OperationInput {
  return { action, ...(result !== undefined ? { result } : {}), route: { kind, transport: {
    endpoint: kind === "task_merge" ? "merge" : kind === "abandon" ? "abandon" : "finish",
    body: kind === "task_merge" || kind === "abandon" ? {} : { ...(result !== undefined ? { result } : {}), ...(kind !== "work_finish" ? { outcome: action } : {}), ...(remote ? { autoMerge: true } : {}) },
  } } };
}
async function remoteWork(requires: string[] = []) {
  await f.db.project.update({ where: { id: f.projectId }, data: { governanceMode: "AUTONOMOUS" } });
  await f.db.workflow.create({ data: { projectId: f.projectId, name: "Direct terminal", isDefault: true, definition: {
    initialState: "open", states: [{ name: "open", label: "Open", terminal: false }, { name: "in_progress", label: "Work", terminal: false }, { name: "shipped", label: "Shipped", terminal: true }],
    transitions: [{ from: "open", to: "in_progress" }, { from: "in_progress", to: "shipped", requires }],
  } } });
}
async function review(claimed = false) {
  await f.workflow();
  await f.db.project.update({ where: { id: f.projectId }, data: { governanceMode: "AWAITS_CONFIRMATION" } });
  await f.db.task.update({ where: { id: f.taskId }, data: { status: "checking", ...(claimed ? { claimedByAgentId: null, claimedByUserId: ids.user, reviewClaimedByAgentId: ids.agent } : {}) } });
}
async function standaloneReview() {
  await review();
  const workflow = await f.db.workflow.findFirstOrThrow({ where: { projectId: f.projectId } });
  const definition = workflow.definition as { states: { name: string }[]; transitions: { from: string; to: string }[] };
  for (const state of definition.states) if (state.name === "checking") state.name = "review";
  for (const edge of definition.transitions) {
    if (edge.from === "checking") edge.from = "review";
    if (edge.to === "checking") edge.to = "review";
  }
  await f.db.workflow.update({ where: { id: workflow.id }, data: { definition } });
  await f.db.task.update({ where: { id: f.taskId }, data: { status: "review" } });
}
async function all() {
  return { ...await f.snapshot(), signals: await f.db.signal.findMany({ where: { taskId: f.taskId }, orderBy: { id: "asc" } }), comments: await f.db.comment.findMany({ where: { taskId: f.taskId }, orderBy: { id: "asc" } }) };
}

it("N-01 work finish persists original assignee recipients, review comment/audits, and complete immutable response", async () => {
  await f.workflow(); await f.evidence();
  const request = input("work_finish", "finish", false, "Finished");
  const result = await f.service.complete(f.taskId, actor, "work", request);
  expect(result).toMatchObject({ action: "finish", status: "checking", route: { kind: "work", targetStatus: "checking", task: { result: "Finished", claimedByAgent: { id: ids.agent, name: "Test" }, comments: [{ content: expect.stringContaining("Review requested") }], artifacts: [], attachments: [], blocks: [], blockedBy: [] } } });
  const snapshot = await all();
  expect(snapshot.signals).toHaveLength(1);
  expect(snapshot.signals[0]).toMatchObject({ type: "review_needed", recipientUserId: ids.user, recipientAgentId: null, acknowledgedAt: null, context: { taskStatus: "checking", assigneeName: "Test" } });
  expect(snapshot.audit.map(a => a.action)).toEqual(expect.arrayContaining(["task.transitioned", "task.reviewed", "task.grounding.completed"]));
  expect(f.deliverSignal).toHaveBeenCalledTimes(1);
  await f.db.task.update({ where: { id: f.taskId }, data: { title: "Later task title" } });
  const later = await all(); f.now += 10000; f.issuer.trust = [];
  expect((await f.make(store.connect()).lookupRouteOperation(f.taskId, actor, "work", request.route!.transport))?.result).toEqual(result);
  // A later caller cannot change history by selecting another branch using current state.
  expect(await f.service.complete(f.taskId, actor, "work", { ...request, action: "approve", route: { ...request.route!, kind: "self_approve_finish" } })).toEqual(result);
  expect(await all()).toEqual(later); expect(f.deliverSignal).toHaveBeenCalledTimes(1);
  await expect(f.service.lookupRouteOperation(f.taskId, actor, "work", { endpoint: "finish", body: { result: "Different" } })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  await expect(f.service.lookupRouteOperation(f.taskId, { type: "human", userId: ids.user }, "work", request.route!.transport)).rejects.toMatchObject({ code: "forbidden" });
});

it.each(["missing", "wrong", "valid"])("N-07 local review route %s receipt guards all durable effects", async evidence => {
  await review(true);
  if (evidence !== "missing") await f.evidence("approve");
  if (evidence === "wrong") f.head = "c".repeat(40);
  const staleSignal = await f.db.signal.create({ data: { type: "review_needed", taskId: f.taskId, projectId: f.projectId, recipientAgentId: ids.agent, context: {} } });
  const before = await all(); const request = input("review_finish", "approve", false, "Approved");
  if (evidence !== "valid") {
    await expect(f.service.complete(f.taskId, actor, "review", request)).rejects.toBeInstanceOf(Error);
    expect(await all()).toEqual(before); expect(f.deliverSignal).not.toHaveBeenCalled(); return;
  }
  const result = await f.service.complete(f.taskId, actor, "review", request);
  expect(result).toMatchObject({ route: { kind: "review", outcome: "approve", task: { status: "shipped", claimedByUserId: null, reviewClaimedByAgentId: null } } });
  const after = await all();
  expect(after.signals.find(s => s.id === staleSignal.id)?.acknowledgedAt).toBeInstanceOf(Date);
  expect(after.signals.find(s => s.type === "task_approved")).toMatchObject({ recipientUserId: ids.user, acknowledgedAt: null, context: { reviewComment: "Approved" } });
  expect(after.attempts[0].state).toBe("CONSUMED");
});

it.each(["review_finish", "self_approve_finish"] as const)("N-16 %s request changes preserves work claim, result, original recipient and invalidates generation", async kind => {
  await review(kind === "review_finish"); await f.evidence("approve");
  const result = await f.service.dispose(f.taskId, actor, "changes", input(kind, "request_changes", false, "Please fix"));
  expect(result).toMatchObject({ route: { kind: "review", outcome: "request_changes", task: { status: "working", result: "Please fix", reviewClaimedByAgentId: null } } });
  const snapshot = await all();
  expect(snapshot.task).toMatchObject(kind === "review_finish" ? { claimedByUserId: ids.user } : { claimedByAgentId: ids.agent });
  expect(snapshot.signals[0]).toMatchObject({ type: "changes_requested", recipientUserId: kind === "review_finish" ? ids.user : null, recipientAgentId: kind === "self_approve_finish" ? ids.agent : null, acknowledgedAt: null });
  expect(snapshot.binding).toMatchObject({ activeAttemptId: null, contextRevision: 2 }); expect(snapshot.attempts[0].state).toBe("SUPERSEDED");
});

it.each(["signals", "comments", "audit_logs"])("N-13 required %s database failure rolls back task, receipt, signals, comments, and operation; retry commits once", async table => {
  await f.workflow(); await f.evidence(); const before = await all();
  await f.db.$executeRawUnsafe("CREATE FUNCTION fail_route_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test required route effect failure'; END $$");
  await f.db.$executeRawUnsafe(`CREATE TRIGGER fail_route_effect BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_route_effect()`);
  const request = input("work_finish", "finish");
  try { await expect(f.service.complete(f.taskId, actor, "rollback", request)).rejects.toMatchObject({ code: "grounding_verification_unavailable" }); }
  finally { await f.db.$executeRawUnsafe(`DROP TRIGGER fail_route_effect ON ${table}`); await f.db.$executeRawUnsafe("DROP FUNCTION fail_route_effect()"); }
  expect(await all()).toEqual(before); expect(f.deliverSignal).not.toHaveBeenCalled();
  await f.service.complete(f.taskId, actor, "rollback", request);
  expect((await all()).operations).toHaveLength(1); expect(f.deliverSignal).toHaveBeenCalledTimes(1);
});

it("N-13 late required audit failure rolls back terminal acknowledgement and the newly created outcome", async () => {
  await review(true); await f.evidence("approve");
  await f.db.signal.create({ data: { type: "review_needed", taskId: f.taskId, projectId: f.projectId, recipientAgentId: ids.agent, context: {} } });
  const before = await all();
  const hook = vi.spyOn(audit, "logGroundingDecision").mockRejectedValueOnce(new Error("late DB error"));
  try { await expect(f.service.complete(f.taskId, actor, "late", input("review_finish", "approve"))).rejects.toMatchObject({ code: "grounding_verification_unavailable" }); }
  finally { hook.mockRestore(); }
  expect(await all()).toEqual(before); expect(f.deliverSignal).not.toHaveBeenCalled();
});

it.each(["work_finish", "review_finish", "self_approve_finish", "task_merge"] as const)("N-09/N-11 %s remote reservation persists semantic receipt and replays installed effects after restart", async kind => {
  const action = kind === "work_finish" ? "finish" : kind === "task_merge" ? "merge" : "approve";
  if (kind === "work_finish") await remoteWork(); else if (kind === "task_merge") await standaloneReview(); else await review(kind === "review_finish");
  await f.evidence(action);
  const request = input(kind, action, true, kind === "task_merge" ? undefined : "Saved outcome");
  await f.service.reserveMerge(f.taskId, actor, "remote", { ...request, action });
  const reserved = await all();
  expect(reserved.finalizations[0].target).toMatchObject({ action, to: "shipped" });
  expect(reserved.operations[0].decision).toMatchObject({ routePlan: { version: 1, kind, action, remote: true, patch: { status: "shipped" } } });
  expect(reserved.signals).toHaveLength(0); expect(reserved.comments).toHaveLength(0); expect(f.deliverSignal).not.toHaveBeenCalled();
  f.merge.mockImplementationOnce(async () => { f.proof = { ...f.proof, merged: true, mergeCommitSha: "b".repeat(40) }; throw new Error("lost reply"); });
  expect(await f.service.dispatchMerge(f.taskId, actor, "remote")).toMatchObject({ pending: true });
  // Fresh service with no callback or request must interpret the original durable plan.
  f.now += 10000; f.issuer.trust = [];
  const afterReservationHuman = await f.db.user.create({ data: { id: randomUUID(), login: randomUUID() } });
  await f.db.teamMember.create({ data: { teamId: ids.team, userId: afterReservationHuman.id, role: "ADMIN" } });
  const result = await f.make(store.connect()).recoverMerge(f.taskId, actor, "remote");
  expect(result).toMatchObject({ action, status: "shipped", route: { task: { status: "shipped" } } });
  const snapshot = await all();
  expect(snapshot.operations[0].state).toBe("COMPLETED"); expect(f.merge).toHaveBeenCalledOnce();
  expect(snapshot.signals.some(s => s.recipientUserId === afterReservationHuman.id)).toBe(false);
  expect(snapshot.audit.some(a => a.action === (kind === "task_merge" ? "task.merged" : "task.auto_merged"))).toBe(true);
  const deliveries = f.deliverSignal.mock.calls.length;
  expect(await f.make(store.connect()).dispatchMerge(f.taskId, actor, "remote")).toEqual(result);
  expect(await all()).toEqual(snapshot); expect(f.deliverSignal).toHaveBeenCalledTimes(deliveries);
  await expect(f.service.reserveMerge(f.taskId, actor, "new-key", { ...request, action })).rejects.toMatchObject({ code: "bad_state" });
});

it.each(["finish", "approve"] as const)("N-09 remote semantic %s enforces self-merge and exact CI head at reservation and dispatch", async action => {
  if (action === "finish") await remoteWork(["ciGreen", "prMerged"]);
  else { await review(); const workflow = await f.db.workflow.findFirstOrThrow({ where: { projectId: f.projectId } }); const definition = workflow.definition as { transitions: { from: string; to: string; requires?: string[] }[] }; definition.transitions.find(e => e.to === "shipped")!.requires = ["ciGreen", "prMerged"]; await f.db.workflow.update({ where: { id: workflow.id }, data: { definition } }); }
  const ci = vi.spyOn(checks, "fetchCheckRunStatus").mockImplementation(async () => ({ state: "success", sha: f.head, total: 1, successful: 1, failing: 0, pending: 0 }));
  await f.evidence(action);
  const request = input(action === "finish" ? "work_finish" : "self_approve_finish", action, true);
  const gate = vi.spyOn(reviewGate, "checkSelfMergeGate").mockReturnValueOnce({ allowed: false, reason: "self_merge_blocked" });
  await expect(f.service.reserveMerge(f.taskId, actor, "gates", { ...request, action })).rejects.toMatchObject({ code: "forbidden" });
  gate.mockRestore();
  ci.mockResolvedValueOnce({ state: "success", sha: "c".repeat(40), total: 1, successful: 1, failing: 0, pending: 0 });
  await expect(f.service.reserveMerge(f.taskId, actor, "gates", { ...request, action })).rejects.toMatchObject({ code: "precondition_failed" });
  await f.service.reserveMerge(f.taskId, actor, "gates", { ...request, action });
  const before = await all();
  const gateAgain = vi.spyOn(reviewGate, "checkSelfMergeGate").mockReturnValueOnce({ allowed: false, reason: "self_merge_blocked" });
  await expect(f.service.dispatchMerge(f.taskId, actor, "gates")).rejects.toMatchObject({ code: "forbidden" }); gateAgain.mockRestore();
  ci.mockResolvedValueOnce({ state: "success", sha: "c".repeat(40), total: 1, successful: 1, failing: 0, pending: 0 });
  await expect(f.service.dispatchMerge(f.taskId, actor, "gates")).rejects.toMatchObject({ code: "precondition_failed" });
  expect(await all()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
  expect(await f.service.dispatchMerge(f.taskId, actor, "gates")).toMatchObject({ status: "shipped", action });
});

it("N-12 remote finish never forces a nonterminal finish target to done", async () => {
  await f.db.project.update({ where: { id: f.projectId }, data: { governanceMode: "AUTONOMOUS" } });
  await f.evidence("finish"); const before = await all();
  await expect(f.service.reserveMerge(f.taskId, actor, "nonterminal", { ...input("work_finish", "finish", true), action: "finish" })).rejects.toMatchObject({ code: "bad_state" });
  expect(await all()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
});

it("N-01 provisioned inline PR must exactly match the receipt's authoritative task PR", async () => {
  await f.evidence(); const before = await all(); const request = input("work_finish", "finish");
  request.route!.transport.body.prUrl = "https://github.com/acme/repo/pull/99";
  await expect(f.service.complete(f.taskId, actor, "pr", request)).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
  expect(await all()).toEqual(before);
  request.route!.transport.body.prUrl = "https://github.com/acme/repo/pull/42";
  expect(await f.service.complete(f.taskId, actor, "pr", request)).toMatchObject({ status: "review" });
});

it("N-13 remote merge plus late route failure recovers all persisted effects exactly once after expiry", async () => {
  await review(true); await f.evidence("approve");
  const request = input("review_finish", "approve", true, "Original persisted review");
  await f.service.reserveMerge(f.taskId, actor, "late-remote", { ...request, action: "approve" });
  const hook = vi.spyOn(audit, "logGroundingDecision").mockRejectedValueOnce(new Error("late transactional failure"));
  try { await expect(f.service.dispatchMerge(f.taskId, actor, "late-remote")).rejects.toMatchObject({ code: "grounding_verification_unavailable" }); }
  finally { hook.mockRestore(); }
  const failed = await all();
  expect(failed.task?.status).toBe("checking"); expect(failed.operations[0].state).toBe("DISPATCHED");
  expect(failed.signals).toHaveLength(0); expect(failed.audit).toHaveLength(0); expect(f.deliverSignal).not.toHaveBeenCalled();
  f.now += 10000; f.issuer.trust = [];
  f.deliverSignal.mockImplementation(async () => {
    const committed = await f.snapshot();
    expect(committed.operations[0].state).toBe("COMPLETED"); expect(committed.attempts[0].state).toBe("CONSUMED");
  });
  const result = await f.make(store.connect()).recoverMerge(f.taskId, actor, "late-remote");
  await Promise.all(f.deliverSignal.mock.results.map(r => r.value));
  expect(result).toMatchObject({ route: { outcome: "approve", task: { result: "Original persisted review" } } });
  const committed = await all();
  expect(committed.signals.filter(s => s.type === "task_approved")).toHaveLength(1);
  expect(f.merge).toHaveBeenCalledOnce();
  const deliveries = f.deliverSignal.mock.calls.length;
  await f.service.recoverMerge(f.taskId, actor, "late-remote");
  expect(await all()).toEqual(committed); expect(f.deliverSignal).toHaveBeenCalledTimes(deliveries);
});

it("transport cannot supply a patch/effect or contradict the semantic operation data", async () => {
  await f.evidence(); const before = await all();
  const request = input("work_finish", "finish", false, "Canonical result");
  await expect(f.service.complete(f.taskId, actor, "transport", { ...request, result: "Different server request" })).rejects.toMatchObject({ code: "bad_state" });
  request.route!.transport.body.signals = [{ recipientUserId: ids.user, type: "task_approved" }];
  await expect(f.service.complete(f.taskId, actor, "transport", request)).rejects.toMatchObject({ code: "bad_state" });
  expect(await all()).toEqual(before); expect(f.deliverSignal).not.toHaveBeenCalled();
});

it.each([true, false])("task merge persists observed alreadyMerged=%s through late failure and restart", async alreadyMerged => {
  await standaloneReview(); await f.evidence("merge");
  if (alreadyMerged) f.proof = { ...f.proof, merged: true, mergeCommitSha: "b".repeat(40) };
  await f.service.reserveMerge(f.taskId, actor, "observed", { ...input("task_merge", "merge", true), action: "merge" });
  const hook = vi.spyOn(audit, "logGroundingDecision").mockRejectedValueOnce(new Error("lost commit"));
  try { await expect(f.service.dispatchMerge(f.taskId, actor, "observed")).rejects.toMatchObject({ code: "grounding_verification_unavailable" }); }
  finally { hook.mockRestore(); }
  const dispatched = await f.snapshot();
  expect(dispatched.operations[0]).toMatchObject({ state: "DISPATCHED", decision: { routePlan: { alreadyMerged } } });
  expect(f.merge).toHaveBeenCalledTimes(alreadyMerged ? 0 : 1);
  f.now += 10000; f.issuer.trust = [];
  const result = await f.make(store.connect()).recoverMerge(f.taskId, actor, "observed");
  expect(result).toMatchObject({ route: { merged: true, alreadyMerged, sha: "b".repeat(40) } });
  expect((await f.snapshot()).audit.find(a => a.action === "task.merged")?.payload).toMatchObject({ alreadyMerged });
  expect(await f.service.dispatchMerge(f.taskId, actor, "observed")).toEqual(result);
  expect(f.merge).toHaveBeenCalledTimes(alreadyMerged ? 0 : 1);
});

it.each(["unavailable", "head", "missing-sha"])("task merge rejects %s pre-dispatch observation without dispatch or remote mutation", async failure => {
  await standaloneReview(); await f.evidence("merge");
  await f.service.reserveMerge(f.taskId, actor, "observation-error", { ...input("task_merge", "merge", true), action: "merge" });
  if (failure === "unavailable") f.read.mockRejectedValueOnce(new Error("provider unavailable"));
  if (failure === "head") f.proof = { ...f.proof, headSha: "c".repeat(40) };
  if (failure === "missing-sha") f.proof = { ...f.proof, merged: true, mergeCommitSha: null };
  const before = await all();
  await expect(f.service.dispatchMerge(f.taskId, actor, "observation-error")).rejects.toBeInstanceOf(Error);
  expect(await all()).toEqual(before); expect(f.merge).not.toHaveBeenCalled(); expect(f.deliverSignal).not.toHaveBeenCalled();
});

it("N-16 abandon preserves its release-only signal semantics even for a stale terminal claim", async () => {
  await f.evidence();
  await f.db.task.update({ where: { id: f.taskId }, data: { status: "done" } });
  const old = await f.db.signal.create({ data: { type: "task_approved", taskId: f.taskId, projectId: f.projectId, recipientAgentId: ids.agent, context: {} } });
  const result = await f.service.dispose(f.taskId, actor, "abandon", input("abandon", "abandon"));
  expect(result).toMatchObject({ route: { task: { status: "done", claimedByAgentId: null } } });
  const after = await all();
  expect(after.signals).toHaveLength(1); expect(after.signals[0]).toMatchObject({ id: old.id, acknowledgedAt: null });
  expect(after.audit.some(a => a.action === "task.released")).toBe(true);
  expect(after.binding).toMatchObject({ contextRevision: 2, activeAttemptId: null });
});
