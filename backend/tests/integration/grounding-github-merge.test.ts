import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { completionActor as actor, completionStore, completionFixture } from "../helpers/grounding-completion-fixtures.js";
import { githubGroupFixture } from "../helpers/grounding-github-fixtures.js";
import { barrier } from "../helpers/grounding-postgres.js";
import { ids, epoch } from "../helpers/grounding-fixtures.js";
import * as audit from "../../src/services/audit.js";
import { GroundingGithubMergeService } from "../../src/services/grounding-github-merge.js";
import { defaultWorkflowDefinition } from "../../src/services/default-workflow.js";
import { _clearCheckCache } from "../../src/services/github-checks.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof githubGroupFixture>>;
beforeAll(async () => { store = await completionStore(); }, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => { vi.stubEnv("REDIS_URL", ""); f = await githubGroupFixture(store); });
afterEach(async () => { await _clearCheckCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function reserve() { await f.evidence(); return f.reserve(); }
async function uncertain() { await reserve(); f.seed.merge.mockRejectedValueOnce(new Error("response lost")); expect(await f.dispatch()).toMatchObject({ pending: true }); }

it("GROUP invalid second protected peer rolls back the whole reservation before any remote merge", async () => {
  await f.seed.evidence("merge");
  const before = await f.snapshot();
  await expect(f.reserve()).rejects.toMatchObject({ code: "grounding_required" });
  expect(await f.snapshot()).toEqual(before);
  expect(f.seed.merge).not.toHaveBeenCalled();
});

it("GROUP one shared merge applies only seed effects and consumes guard receipt without status, claims or signal effects", async () => {
  for (const task of [f.seed, f.peer]) await store.db.signal.create({ data: { taskId: task.taskId, projectId: task.projectId, type: "review_needed", recipientAgentId: ids.agent, context: {} } });
  const peerBefore = await f.peer.task();
  await reserve();
  const before = await f.snapshot();
  expect(before.group?.members).toHaveLength(2);
  expect(before.seed.cohort?.reservationId).toBe(before.seed.operations[0].id);
  expect(before.peer.cohort?.reservationId).toBe(before.peer.operations[0].id);
  const result = await f.dispatch();
  expect(result).toMatchObject({ status: "done", route: { merged: true, sha: "b".repeat(40), message: "Pull request successfully merged", task: { id: f.seed.taskId, status: "done" } } });
  expect((result as { route: unknown }).route).toEqual({ merged: true, sha: "b".repeat(40), message: "Pull request successfully merged", task: { id: f.seed.taskId, status: "done" } });
  const after = await f.snapshot();
  expect(after.peer.task).toEqual(peerBefore);
  expect(after.peer.operations[0].result).toMatchObject({ role: "GUARD", freshAttemptRequired: true, status: "review" });
  expect(after.peer.attempts[0].state).toBe("CONSUMED");
  expect(after.peer.binding?.activeAttemptId).toBeNull();
  expect(after.peer.audit.map(row => row.action)).toEqual(["task.grounding.merge_guard_consumed"]);
  expect(after.peer.cohort?.reservationId).toBeNull();
  expect(after.seed.task?.claimedByAgentId).toBeNull();
  expect(after.signals.find(row => row.taskId === f.peer.taskId)?.acknowledgedAt).toBeNull();
  expect(after.signals.find(row => row.taskId === f.seed.taskId && row.type === "review_needed")?.acknowledgedAt).not.toBeNull();
  expect(after.signals.filter(row => row.taskId === f.peer.taskId)).toEqual(before.signals.filter(row => row.taskId === f.peer.taskId));
  expect(after.signals.filter(row => row.taskId === f.seed.taskId && row.type === "self_merge_notice")).toHaveLength(1);
  expect(after.fence?.ownerId).toBeNull();
  expect(f.seed.merge).toHaveBeenCalledExactlyOnceWith({ repo: f.repo, prNumber: 42, headSha: f.seed.head, method: "squash" }, "test-only");
  expect(await f.recover()).toEqual(result);
  expect(await f.dispatch()).toEqual(result);
  expect(await f.snapshot()).toEqual(after);
  await expect(f.peer.service.complete(f.peer.taskId, actor, "later", { action: "approve" })).rejects.toMatchObject({ code: "grounding_required" });
});

it("GROUP case-insensitive peers preserve exact signed context bytes", async () => {
  const mixedRepo = f.repo.toUpperCase();
  await store.db.project.update({ where: { id: f.peer.projectId }, data: { githubRepo: mixedRepo } });
  await store.db.task.update({ where: { id: f.peer.taskId }, data: { prUrl: `https://github.com/${mixedRepo}/pull/42` } });
  await reserve();
  const before = await f.snapshot();
  const bytes = before.peer.attempts[0].contextBytes;
  expect(bytes.toString()).toContain(mixedRepo);
  await f.dispatch();
  const after = await f.snapshot();
  expect(after.peer.attempts[0].contextBytes).toEqual(bytes);
  expect(after.group?.repo).toBe(f.repo);
  expect(after.peer.operations[0].repo).toBe(mixedRepo);
});

it.each(["missing_url", "wrong_url", "foreign_override", "missing_cohort", "missing_number", "wrong_number_suffix", "foreign_url_suffix"])("GROUP %s protected peer is rejected instead of omitted", async change => {
  await f.seed.evidence("merge");
  if (change === "missing_url") await store.db.task.update({ where: { id: f.peer.taskId }, data: { prUrl: null } });
  if (change === "wrong_url") await store.db.task.update({ where: { id: f.peer.taskId }, data: { prUrl: "https://github.com/wrong/repo/pull/42" } });
  if (change === "foreign_override") {
    await store.db.project.update({ where: { id: f.peer.projectId }, data: { githubRepo: "other/repo" } });
    await store.db.task.update({ where: { id: f.peer.taskId }, data: { deliverableRepo: f.repo } });
    await f.peer.evidence("merge");
  }
  if (change === "missing_cohort") await store.db.groundingCohort.delete({ where: { taskId: f.peer.taskId } });
  if (change === "missing_number") await store.db.task.update({ where: { id: f.peer.taskId }, data: { prNumber: null, prUrl: `https://github.com/${f.repo}/pull/42/` } });
  if (change === "wrong_number_suffix") await store.db.task.update({ where: { id: f.peer.taskId }, data: { prNumber: 4, prUrl: `https://github.com/${f.repo}/pull/42?tab=files` } });
  if (change === "foreign_url_suffix") {
    await store.db.project.update({ where: { id: f.peer.projectId }, data: { githubRepo: "other/repo" } });
    await store.db.task.update({ where: { id: f.peer.taskId }, data: { prNumber: null, prUrl: `https://github.com/${f.repo}/pull/42#files` } });
  }
  const before = await f.snapshot();
  await expect(f.reserve()).rejects.toBeInstanceOf(Error);
  expect(await f.snapshot()).toEqual(before);
  expect(f.seed.merge).not.toHaveBeenCalled();
});

it("GROUP another exact PR in the same repository is not a participant", async () => {
  await store.db.task.update({ where: { id: f.peer.taskId }, data: { prNumber: 4, prUrl: `https://github.com/${f.repo}/pull/4` } });
  await f.seed.evidence("merge");
  await f.reserve();
  expect((await f.snapshot()).group?.members).toHaveLength(1);
  await f.dispatch();
  expect((await f.peer.task()).status).toBe("review");
});

it("GROUP repository fence prevents cross-project and foreign-repository membership from joining", async () => {
  const project = await store.db.project.create({ data: { teamId: ids.team, name: "Other", slug: randomUUID(), githubRepo: "other/repo" } });
  await reserve();
  for (const data of [
    { projectId: f.peer.projectId, title: "New cross-project peer", prNumber: 42, prUrl: `https://github.com/${f.repo}/pull/42` },
    { projectId: project.id, title: "New foreign peer", deliverableRepo: f.repo, prNumber: 42, prUrl: `https://github.com/${f.repo}/pull/42` },
  ]) await expect(store.connect().task.create({ data })).rejects.toBeInstanceOf(Error);
  expect(await store.db.task.count({ where: { projectId: project.id } })).toBe(0);
  expect((await f.snapshot()).group?.members).toHaveLength(2);
});

it("GROUP concurrent dispatches across connections issue exactly one remote merge", async () => {
  await reserve(); const gate = barrier();
  f.seed.merge.mockImplementationOnce(async () => { await gate.wait(); f.seed.proof = { ...f.seed.proof, merged: true, mergeCommitSha: "b".repeat(40) }; });
  const first = f.dispatch(); await gate.reached;
  try {
    expect(await f.make(store.connect()).dispatchMerge(f.seed.taskId, actor, "group")).toMatchObject({ pending: true });
    expect(f.seed.merge).toHaveBeenCalledTimes(1);
  } finally { gate.release(); }
  expect(await first).toMatchObject({ status: "done" });
  expect(f.seed.merge).toHaveBeenCalledTimes(1);
});

it("GROUP dispatch CAS miss rolls back child dispatch writes and issues no remote write", async () => {
  await reserve(); const before = await f.snapshot();
  const client = store.connect().$extends({ query: { groundingGithubMergeGroup: { async updateMany({ args, query }) {
    if (args.data.state === "DISPATCHED") return { count: 0 };
    return query(args);
  } } } });
  await expect(f.make(client as unknown as typeof store.db).dispatchMerge(f.seed.taskId, actor, "group")).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
  expect(await f.snapshot()).toEqual(before);
  expect(f.seed.merge).not.toHaveBeenCalled();
});

it("GROUP final awaited dispatch write crossing TTL rolls back every child and never merges", async () => {
  await reserve(); const before = await f.snapshot();
  const client = store.connect().$extends({ query: { groundingGithubMergeGroup: { async updateMany({ args, query }) {
    const result = await query(args);
    if (args.data.state === "DISPATCHED") f.seed.now = epoch + 900;
    return result;
  } } } });
  await expect(f.make(client as unknown as typeof store.db).dispatchMerge(f.seed.taskId, actor, "group")).rejects.toMatchObject({ code: "grounding_finalization_pending" });
  expect(await f.snapshot()).toEqual(before);
  expect(f.seed.merge).not.toHaveBeenCalled();
});

it("GROUP remote success and local audit failure roll back both members; restart recovers once after TTL", async () => {
  await reserve();
  const hook = vi.spyOn(audit, "logGroundingDecision").mockRejectedValueOnce(new Error("DB failed"));
  try { await expect(f.dispatch()).rejects.toMatchObject({ code: "grounding_verification_unavailable" }); }
  finally { hook.mockRestore(); }
  const pending = await f.snapshot();
  expect(pending.group?.state).toBe("DISPATCHED");
  expect(pending.seed.task?.status).toBe("review");
  expect(pending.peer.task?.status).toBe("review");
  expect(pending.seed.audit).toHaveLength(0); expect(pending.peer.audit).toHaveLength(0);
  expect(pending.seed.attempts[0].state).toBe("ACTIVE"); expect(pending.peer.attempts[0].state).toBe("ACTIVE");
  expect(pending.fence?.ownerId).toBe(pending.group?.id);
  f.seed.now += 10000; f.issuer.trust = [];
  expect(await f.make(store.connect()).recoverMerge(f.seed.taskId, actor, "group")).toMatchObject({ status: "done" });
  const completed = await f.snapshot();
  expect(completed.peer.task).toEqual(pending.peer.task);
  expect(await f.recover()).toMatchObject({ status: "done" });
  expect(await f.snapshot()).toEqual(completed);
  expect(f.seed.merge).toHaveBeenCalledTimes(1);
});

it.each(["head", "repo", "pr", "open", "sha"])("GROUP recovery rejects wrong %s proof and retains every reservation", async change => {
  await uncertain();
  f.seed.proof = { ...f.seed.proof, merged: true, mergeCommitSha: "b".repeat(40) };
  if (change === "head") f.seed.proof.headSha = "c".repeat(40);
  if (change === "repo") f.seed.proof.repo = "wrong/repo";
  if (change === "pr") f.seed.proof.prNumber = 43;
  if (change === "open") f.seed.proof.merged = false;
  if (change === "sha") f.seed.proof.mergeCommitSha = null;
  const before = await f.snapshot();
  expect(await f.recover()).toMatchObject({ pending: true });
  const after = await f.snapshot();
  // Ownership assertions advance only the fence version.
  expect({ ...after, fence: before.fence }).toEqual(before);
  expect(after.fence?.ownerId).toBe(before.fence?.ownerId);
  expect(f.seed.merge).toHaveBeenCalledTimes(1);
});

it("GROUP exact already-merged proof suppresses the remote write", async () => {
  await store.db.task.update({ where: { id: f.seed.taskId }, data: { autoMergeSha: "d".repeat(40) } });
  await reserve();
  f.seed.proof = { ...f.seed.proof, merged: true, mergeCommitSha: "b".repeat(40) };
  expect(await f.dispatch()).toMatchObject({ route: { message: "Already merged", sha: "b".repeat(40) } });
  expect(f.seed.merge).not.toHaveBeenCalled();
});

it("GROUP naked autoMergeSha cannot authorize local completion or suppress the exact merge", async () => {
  await store.db.task.update({ where: { id: f.seed.taskId }, data: { autoMergeSha: "b".repeat(40) } });
  await reserve();
  f.seed.merge.mockRejectedValueOnce(new Error("no proof"));
  expect(await f.dispatch()).toMatchObject({ pending: true });
  expect(await f.recover()).toMatchObject({ pending: true });
  expect((await f.snapshot()).seed.task?.status).toBe("review");
  expect(f.seed.merge).toHaveBeenCalledTimes(1);
});

it.each(["expiry", "peer_trust", "head", "consent", "authority"])("GROUP fresh %s is revalidated for every member before dispatch", async change => {
  await reserve();
  if (change === "expiry") f.seed.now = epoch + 900;
  if (change === "peer_trust") f.issuer.trust[0].projectIds = [f.seed.projectId];
  if (change === "head") f.seed.head = "c".repeat(40);
  if (change === "consent") await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } });
  if (change === "authority") await store.db.agentToken.update({ where: { id: ids.agent }, data: { revokedAt: new Date() } });
  const before = await f.snapshot();
  try { await expect(f.dispatch()).rejects.toBeInstanceOf(Error); }
  finally {
    await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: true } });
    await store.db.agentToken.update({ where: { id: ids.agent }, data: { revokedAt: null } });
  }
  expect(await f.snapshot()).toEqual(before);
  expect(f.seed.merge).not.toHaveBeenCalled();
});

it("GROUP peer CI failure is evaluated through the original completion gate", async () => {
  const definition = defaultWorkflowDefinition();
  for (const edge of definition.transitions) edge.requires = ["ciGreen"];
  await store.db.workflow.create({ data: { projectId: f.peer.projectId, name: "Peer CI", isDefault: true, definition: definition as unknown as Prisma.InputJsonValue } });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).includes("/check-runs")
    ? Response.json({ total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] })
    : Response.json({ head: { sha: f.seed.head }, state: "open", merged: false })));
  await f.evidence();
  const before = await f.snapshot();
  await expect(f.reserve()).rejects.toMatchObject({ code: "precondition_failed" });
  expect(await f.snapshot()).toEqual(before);
  expect(f.seed.merge).not.toHaveBeenCalled();
});

it("GROUP changed actor, body and URL identity cannot replay the original operation", async () => {
  await reserve();
  await expect(f.service.dispatchMerge(f.seed.taskId, { type: "human", userId: ids.user }, "group")).rejects.toMatchObject({ code: "forbidden" });
  await expect(f.service.reserveMerge(f.seed.taskId, actor, "group", { action: "merge", method: "merge" })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  await expect(f.service.reserveMerge(f.seed.taskId, actor, "group", { ...f.request, action: "merge", method: "merge" })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  const transport = f.request.route!.transport;
  for (const change of [{ merge_method: "merge" }, { prNumber: 43 }, { owner: "other" }]) await expect(f.service.lookupGroupOperation(f.seed.taskId, actor, "group", { ...transport, body: { ...transport.body, ...change } })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  expect(await f.service.lookupGroupOperation(f.seed.taskId, actor, "group", transport)).toMatchObject({ state: "RESERVED" });
  expect(f.seed.merge).not.toHaveBeenCalled();
});

it.each(["authority", "delegation"])("GROUP revoked current %s blocks historical recovery without another merge", async change => {
  await uncertain(); f.seed.proof = { ...f.seed.proof, merged: true, mergeCommitSha: "b".repeat(40) };
  if (change === "authority") await store.db.agentToken.update({ where: { id: ids.agent }, data: { revokedAt: new Date() } });
  else await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } });
  const before = await f.snapshot();
  try { await expect(f.recover()).rejects.toMatchObject({ code: "forbidden" }); }
  finally { await store.db.agentToken.update({ where: { id: ids.agent }, data: { revokedAt: null } }); await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: true } }); }
  expect(await f.snapshot()).toEqual(before);
  expect(f.seed.merge).toHaveBeenCalledTimes(1);
});

it("GROUP cancel reserved group invalidates evidence, releases all reservations and preserves task effects", async () => {
  await reserve(); const before = await f.snapshot(); f.seed.now += 10000;
  expect(await f.service.cancelMerge(f.seed.taskId, actor, "group", "expired")).toMatchObject({ state: "CANCELLED" });
  const after = await f.snapshot();
  expect(after.seed.task).toEqual(before.seed.task); expect(after.peer.task).toEqual(before.peer.task);
  expect(after.seed.cohort?.reservationId).toBeNull(); expect(after.peer.cohort?.reservationId).toBeNull();
  expect(after.seed.attempts[0].state).toBe("SUPERSEDED"); expect(after.peer.attempts[0].state).toBe("SUPERSEDED");
  expect(after.fence?.ownerId).toBeNull();
  expect(await f.service.cancelMerge(f.seed.taskId, actor, "group", "expired")).toEqual(after.group?.result);
  await expect(f.service.cancelMerge(f.seed.taskId, actor, "group", "different")).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  expect(await f.dispatch()).toMatchObject({ state: "CANCELLED" });
  expect(f.seed.merge).not.toHaveBeenCalled();
});

it("GROUP cancel refuses dispatched group with uncertain remote result", async () => {
  await uncertain(); const before = await f.snapshot();
  await expect(f.service.cancelMerge(f.seed.taskId, actor, "group", "cancel")).rejects.toMatchObject({ code: "grounding_finalization_pending" });
  expect(await f.snapshot()).toEqual(before);
});

it("GROUP unprovisioned seed with protected peer fails closed and admission never claims authorization", async () => {
  const task = await store.db.task.create({ data: { projectId: f.seed.projectId, title: "Legacy", status: "review", prNumber: 42, prUrl: `https://github.com/${f.repo}/pull/42` } });
  expect(await f.service.protectedMergeParticipants(task.id, actor)).toEqual({ seedProvisioned: false, taskIds: expect.arrayContaining([f.seed.taskId, f.peer.taskId]) });
  await expect(f.service.reserveMerge(task.id, actor, "legacy")).rejects.toMatchObject({ code: "grounding_not_provisioned" });
  expect(f.seed.merge).not.toHaveBeenCalled();
  expect(await store.db.groundingGithubMergeGroup.count({ where: { seedTaskId: task.id } })).toBe(0);
});

it("GROUP old single-task reservation cannot dispatch; already-dispatched legacy operation recovers without another merge", async () => {
  const old = await completionFixture(store);
  await old.evidence("merge"); await old.service.reserveMerge(old.taskId, actor, "old");
  const configured = new GroundingGithubMergeService({ db: store.db, config: { audience: "consumer.test", trust: () => old.issuer.trust }, now: () => old.now, headProvider: old.headProvider, mergeProvider: { merge: old.merge, read: old.read } });
  await expect(configured.dispatchMerge(old.taskId, actor, "old")).rejects.toMatchObject({ code: "grounding_finalization_pending" });
  expect(old.merge).not.toHaveBeenCalled();
  old.merge.mockRejectedValueOnce(new Error("response lost"));
  await old.service.dispatchMerge(old.taskId, actor, "old");
  old.proof = { ...old.proof, merged: true, mergeCommitSha: "b".repeat(40) }; old.now += 10000;
  expect(await configured.dispatchMerge(old.taskId, actor, "old")).toMatchObject({ status: "done" });
  expect(old.merge).toHaveBeenCalledTimes(1);
});
