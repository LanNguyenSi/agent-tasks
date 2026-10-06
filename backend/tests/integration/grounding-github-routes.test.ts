import { createHash, createHmac, randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
const harness = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get: (_target, property) => { const value = Reflect.get(harness.db!, property); return typeof value === "function" ? value.bind(harness.db) : value; } }) }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("../../src/services/confidence-telemetry.js", () => ({ recordBounceBack: vi.fn(), recordTerminalSnapshot: vi.fn(), recordClarification: vi.fn(), recordAbandonDisposition: vi.fn(), clearDisposition: vi.fn() }));
import { createApp } from "../../src/app.js";
import { GroundingGithubMergeService } from "../../src/services/grounding-github-merge.js";
import { GroundingFinalizationService } from "../../src/services/grounding-finalization.js";
import { GroundingGithubCreateService } from "../../src/services/grounding-github-create.js";
import { githubCreateCorrelationMarker, type GroundingGithubCreateProvider } from "../../src/services/grounding-github-create-provider.js";
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { createGroundingRemoteTargetGuard, type GroundingEnforcedScope } from "../../src/services/grounding-scope.js";
import { completionFixture, completionStore, completionActor } from "../helpers/grounding-completion-fixtures.js";
import { ids, session } from "../helpers/grounding-fixtures.js";
import * as audit from "../../src/services/audit.js";
import { GroundingReceiptVerificationError } from "../../src/services/grounding-receipt.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
let repo: string;
const token = "configured-github-route-test";
const actor = { ...completionActor, scopes: [...completionActor.scopes, "github:pr_create"] };
// An agent of another team with every route scope but no access to any fixture project.
const foreign = { user: randomUUID(), team: randomUUID(), agent: randomUUID(), token: "foreign-team-github-route-test" };
beforeAll(async () => {
  store = await completionStore(); harness.db = store.db;
  await store.db.user.create({ data: { id: foreign.user, login: "foreign", githubAccessToken: "test-only", githubConnectedAt: new Date(), allowAgentPrCreate: true, allowAgentPrMerge: true } });
  await store.db.team.create({ data: { id: foreign.team, name: "Foreign", slug: `foreign-${foreign.team}` } });
  await store.db.teamMember.create({ data: { teamId: foreign.team, userId: foreign.user, role: "ADMIN" } });
  await store.db.agentToken.create({ data: { id: foreign.agent, teamId: foreign.team, createdById: foreign.user, name: "Foreign", tokenHash: createHash("sha256").update(foreign.token).digest("hex"), scopes: actor.scopes } });
}, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => {
  vi.stubEnv("REDIS_URL", ""); vi.stubEnv("GITHUB_WEBHOOK_SECRET", "configured-test-secret");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("external HTTP disabled")));
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { tokenHash: createHash("sha256").update(token).digest("hex"), scopes: actor.scopes, revokedAt: null } });
  await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrCreate: true, allowAgentPrMerge: true } });
  f = await completionFixture(store, "EXTERNAL_V1", deps => new GroundingGithubMergeService(deps));
  repo = `routes_${randomUUID().replaceAll("-", "")}`;
  await store.db.project.update({ where: { id: f.projectId }, data: { githubRepo: `acme/${repo}` } });
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "review", prUrl: `https://github.com/acme/${repo}/pull/42` } });
  f.proof.repo = `acme/${repo}`;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
// f.projectId/its repo is the file's default "enforced" project throughout: the
// same shape the runtime would derive from a creationPolicy naming it. Tests
// that need an unscoped task pass an explicit narrower/empty scope instead.
const defaultScope = (): GroundingEnforcedScope => ({ projectIds: new Set([f.projectId]), repos: new Set([`acme/${repo}`]) });
const emptyScope: GroundingEnforcedScope = { projectIds: new Set(), repos: new Set() };
const app = (service = f.service, githubCreate?: GroundingGithubCreateService, scope: GroundingEnforcedScope = defaultScope()) => createApp("", f.attempts, { db: store.db, service, githubCreate, scope, remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope }) });
function request(body: unknown = {}, path = "/api/github/pull-requests/42/merge", key: string | null = "route-operation", auth: string | null = token) {
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(key === null ? {} : { "Idempotency-Key": key }), ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }) }, body: JSON.stringify(body) });
}
const mergeBody = () => ({ taskId: f.taskId, owner: "acme", repo });
/** A genuinely unscoped, unrelated task/project: no shared repo or project id
 * with the default enforced scope, and no protected/EXTERNAL_V1/held peer. */
async function unscopedTask() {
  const u = await completionFixture(store);
  await store.db.groundingBinding.delete({ where: { taskId: u.taskId } });
  await store.db.groundingCohort.delete({ where: { taskId: u.taskId } });
  const ownRepo = `other-org/${randomUUID().replaceAll("-", "")}`;
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: ownRepo } });
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "in_progress", prNumber: 99, prUrl: `https://github.com/${ownRepo}/pull/99` } });
  return Object.assign(u, { ownRepo });
}
/** A protected/EXTERNAL_V1 peer living at its own, otherwise-unscoped repo. */
async function protectedPeerElsewhere() {
  const g = await completionFixture(store);
  const peerRepo = `guardian/${randomUUID().replaceAll("-", "")}`;
  await store.db.project.update({ where: { id: g.projectId }, data: { githubRepo: peerRepo } });
  await store.db.task.update({ where: { id: g.taskId }, data: { status: "review", prNumber: 7, prUrl: `https://github.com/${peerRepo}/pull/7` } });
  return { peerRepo, prNumber: 7, taskId: g.taskId };
}
async function peer() {
  const p = await completionFixture(store);
  f.issuer.trust[0] = { ...f.issuer.trust[0], projectIds: [...f.issuer.trust[0].projectIds, p.projectId] }; p.issuer = f.issuer;
  await store.db.project.update({ where: { id: p.projectId }, data: { githubRepo: `ACME/${repo.toUpperCase()}` } });
  await store.db.task.update({ where: { id: p.taskId }, data: { status: "review", claimedByAgentId: null, claimedByUserId: ids.user, reviewClaimedByAgentId: ids.agent, prUrl: `https://github.com/ACME/${repo.toUpperCase()}/pull/42` } });
  return p;
}

it.each(["missing", "wrong", "valid"])("N12/N15 direct mounted merge checks cross-project peer %s receipt", async evidence => {
  const p = await peer(); await f.evidence("merge");
  if (evidence !== "missing") await p.evidence("merge");
  if (evidence === "wrong") {
    const binding = await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId: p.taskId } });
    await store.db.groundingBinding.update({ where: { taskId: p.taskId }, data: { contextRevision: binding.contextRevision + 1 } });
  }
  const before = await p.task(); const a = app(); const response = await a.fetch(request(mergeBody()));
  if (evidence !== "valid") {
    expect(response.status).toBe(409); expect(f.merge).not.toHaveBeenCalled(); expect((await f.task()).status).toBe("review");
    expect(await store.db.groundingGithubMergeGroup.count({ where: { seedTaskId: f.taskId } })).toBe(0);
  } else {
    expect(response.status).toBe(200);
    const body = await response.json(); expect(body).toEqual({ merged: true, sha: "b".repeat(40), message: "Pull request successfully merged", task: { id: f.taskId, status: "done" } });
    const retry = await a.fetch(request({ ...mergeBody(), idempotencyKey: "route-operation", merge_method: "squash" }));
    expect(retry.status).toBe(200); expect(await retry.json()).toEqual(body); expect(retry.headers.get("X-Idempotent-Replay")).toBe("true"); expect(f.merge).toHaveBeenCalledOnce();
    expect(await store.db.groundingGithubMergeMember.count({ where: { group: { seedTaskId: f.taskId } } })).toBe(2);
  }
  const after = await p.task(); expect(after).toMatchObject({ status: before.status, claimedByUserId: before.claimedByUserId, reviewClaimedByAgentId: before.reviewClaimedByAgentId });
  expect(await store.db.signal.count({ where: { taskId: p.taskId } })).toBe(0);
});

it.each(["0", "-1", "42x", "4.2", "042", "2147483648"])("rejects complete invalid PR parameter %s before dispatch", async number => {
  const result = await app().fetch(request(mergeBody(), `/api/github/pull-requests/${number}/merge`));
  expect(result.status).toBe(400); expect(f.merge).not.toHaveBeenCalled();
});
it.each(["repo", "number", "key", "head"])("N11/N12 direct identity %s cannot alter the authoritative binding", async field => {
  await f.evidence("merge"); const before = await f.snapshot();
  const body = { ...mergeBody(), ...(field === "repo" ? { repo: "foreign" } : {}), ...(field === "key" ? { idempotencyKey: "different" } : {}) };
  if (field === "head") f.head = "c".repeat(40);
  const result = await app().fetch(request(body, `/api/github/pull-requests/${field === "number" ? 43 : 42}/merge`));
  expect(result.status).toBe(409); expect(await f.snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
});
it("requires durable key and current authenticated scope before effects", async () => {
  const a = app(); expect((await a.fetch(request(mergeBody(), undefined, null))).status).toBe(400);
  expect((await a.fetch(request(mergeBody(), undefined, "key", null))).status).toBe(401);
  await f.evidence("merge"); await store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: ["github:pr_merge"] } });
  expect((await a.fetch(request(mergeBody()))).status).toBe(403); expect(f.merge).not.toHaveBeenCalled();
});
it("N11 concurrent same-key route calls commit one group and send one merge", async () => {
  await f.evidence("merge"); const a = app(); const b = app(f.make(store.connect()));
  const responses = await Promise.all([a.fetch(request(mergeBody())), b.fetch(request(mergeBody()))]);
  // The losing request may see one transient serialization failure, answered
  // with the documented retryable 503; the other one wins.
  const unavailable = responses.filter(r => r.status === 503);
  expect(unavailable.length).toBeLessThanOrEqual(1);
  for (const r of unavailable) expect(await r.json()).toEqual({ error: "grounding_verification_unavailable", message: "Retry with the same Idempotency-Key and unchanged request to resolve the durable operation." });
  expect(responses.filter(r => [200, 202].includes(r.status)).length).toBe(responses.length - unavailable.length);
  // A same-key retry converges on the one committed group and merge.
  expect((await a.fetch(request(mergeBody()))).status).toBe(200); expect(f.merge).toHaveBeenCalledOnce();
  expect(await store.db.groundingGithubMergeGroup.count({ where: { seedTaskId: f.taskId } })).toBe(1);
  expect((await a.fetch(request({ ...mergeBody(), merge_method: "merge" }))).status).toBe(409);
});
it.each(["timeout", "database"])("N13 direct remote-success/%s recovery preserves response and performs no second write", async failure => {
  await f.evidence("merge"); const p = await peer(); await p.evidence("merge");
  let hook: ReturnType<typeof vi.spyOn> | undefined;
  if (failure === "timeout") f.merge.mockImplementationOnce(async () => { f.proof = { ...f.proof, merged: true, mergeCommitSha: "b".repeat(40) }; throw new Error("lost response"); });
  else hook = vi.spyOn(audit, "logGroundingDecision").mockRejectedValueOnce(new Error("local commit failure"));
  const first = await app().fetch(request(mergeBody())); hook?.mockRestore(); expect(first.status).toBe(202); expect(await first.json()).toEqual({ state: "DISPATCHED", pending: true });
  expect((await f.task()).status).toBe("review"); f.now += 10000; f.issuer.trust = []; p.issuer.trust = [];
  const a = app(f.make(store.connect())); const result = await a.fetch(request(mergeBody())); expect(result.status).toBe(200); const saved = await result.json();
  expect(await (await a.fetch(request(mergeBody()))).json()).toEqual(saved); expect(f.merge).toHaveBeenCalledOnce(); expect((await p.task()).status).toBe("review");
  await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } });
  expect((await a.fetch(request(mergeBody()))).status).toBe(403);
});
it("N13 ambiguous head proof remains pending; bare autoMergeSha never grants fresh direct authority", async () => {
  await f.evidence("merge"); f.merge.mockRejectedValueOnce(new Error("uncertain"));
  expect((await app().fetch(request(mergeBody()))).status).toBe(202);
  f.proof = { ...f.proof, merged: true, headSha: "c".repeat(40), mergeCommitSha: "b".repeat(40) };
  expect((await app().fetch(request(mergeBody()))).status).toBe(202); expect((await f.task()).status).toBe("review"); expect(f.merge).toHaveBeenCalledOnce();
});
it.each(["attempts-only", "no-service", "base-only"])("incomplete %s configuration closes every GitHub writer", async kind => {
  const base = new GroundingFinalizationService({ db: store.db, config: { audience: "consumer.test", trust: () => f.issuer.trust }, headProvider: f.headProvider, mergeProvider: { merge: f.merge, read: f.read } });
  const a = kind === "attempts-only" ? createApp("", f.attempts) : createApp("", f.attempts, kind === "base-only" ? { db: store.db, service: base, scope: defaultScope(), remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope: defaultScope() }) } : { db: store.db });
  await f.evidence("merge");
  expect((await a.fetch(request(mergeBody()))).status).toBe(503);
  expect((await a.fetch(request({}, `/api/tasks/${f.taskId}/merge`))).status).toBe(503);
  expect((await a.fetch(request({ outcome: "approve", autoMerge: true }, `/api/tasks/${f.taskId}/finish`))).status).toBe(503);
  expect((await a.fetch(request({ ...mergeBody(), head: "branch", title: "Create" }, "/api/github/pull-requests"))).status).toBe(503);
  expect(f.merge).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it.each(["direct", "task", "work", "review", "self"])("D018 configured unprovisioned %s remote merge rejects before external action", async kind => {
  await store.db.groundingBinding.delete({ where: { taskId: f.taskId } }); await store.db.groundingCohort.delete({ where: { taskId: f.taskId } });
  if (kind === "work") await store.db.task.update({ where: { id: f.taskId }, data: { status: "in_progress" } });
  if (kind === "review") await store.db.task.update({ where: { id: f.taskId }, data: { claimedByAgentId: null, reviewClaimedByAgentId: ids.agent } });
  const path = kind === "direct" ? "/api/github/pull-requests/42/merge" : `/api/tasks/${f.taskId}/${kind === "task" ? "merge" : "finish"}`;
  const body = kind === "direct" ? mergeBody() : kind === "task" ? {} : { autoMerge: true, ...(kind === "work" ? {} : { outcome: "approve" }) };
  const before = await f.task(); const result = await app().fetch(request(body, path));
  expect(result.status).toBe(409); expect(await result.json()).toEqual({ error: "grounding_enrollment_required" }); expect(await f.task()).toEqual(before); expect(f.merge).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
});
const fetchCalls = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
it("an unscoped unprotected task reaches the legacy handlers on all three remote paths without an Idempotency-Key", async () => {
  const u = await unscopedTask();
  const a = app(f.service, undefined, emptyScope);
  const taskMergeResult = await a.fetch(request({}, `/api/tasks/${u.taskId}/merge`, null));
  expect(taskMergeResult.status).toBe(409); expect(await taskMergeResult.json()).toMatchObject({ error: "bad_state" });
  const finishResult = await a.fetch(request({ autoMerge: true }, `/api/tasks/${u.taskId}/finish`, null));
  expect(finishResult.status).toBe(403); expect(await finishResult.json()).toMatchObject({ error: "autonomous_mode_required" });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  // A done task passes the legacy status gates, so the legacy merge reaches
  // GitHub: at the project repository and the task's own PR, not the path PR
  // or the body owner/repo.
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "done" } });
  const mergeResult = await a.fetch(request({ taskId: u.taskId, owner: "acme", repo: "irrelevant" }, "/api/github/pull-requests/1/merge", null));
  expect(mergeResult.status).toBe(502); expect(await mergeResult.json()).toMatchObject({ error: "github_error", message: "GitHub API unreachable: external HTTP disabled" });
  expect(fetchCalls()).toEqual([`https://api.github.com/repos/${u.ownRepo}/pulls/99/merge`]);
  expect(await store.db.groundingBinding.findUnique({ where: { taskId: u.taskId } })).toBeNull();
  expect(await store.db.groundingCohort.findUnique({ where: { taskId: u.taskId } })).toBeNull();
  expect(await store.db.groundingOperation.count({ where: { taskId: u.taskId } })).toBe(0);
});
// A review-claimed task in an AUTONOMOUS project passes the legacy status,
// review and self-merge gates of the GitHub merge, task merge and review
// finish, so each request reaches its effect boundary.
async function reviewClaimed(taskId: string, projectId: string) {
  await store.db.task.update({ where: { id: taskId }, data: { status: "review", claimedByAgentId: null, claimedByUserId: null, reviewClaimedByAgentId: ids.agent } });
  await store.db.project.update({ where: { id: projectId }, data: { governanceMode: "AUTONOMOUS" } });
}
const refusalBody = (error: string) => ({ error, message: expect.any(String) });
it("an unscoped task whose repo equals an enforced project's repo is refused at the effect boundary on all three paths", async () => {
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: `acme/${repo}` } });
  await store.db.task.update({ where: { id: u.taskId }, data: { prNumber: 55, prUrl: `https://github.com/acme/${repo}/pull/55` } });
  await reviewClaimed(u.taskId, u.projectId);
  const a = app();
  const before = await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } });
  const mergeResult = await a.fetch(request({ taskId: u.taskId, owner: "acme", repo }, "/api/github/pull-requests/55/merge", null));
  expect(mergeResult.status).toBe(409); expect(await mergeResult.json()).toEqual(refusalBody("grounding_enrollment_required"));
  const taskMergeResult = await a.fetch(request({}, `/api/tasks/${u.taskId}/merge`, null));
  expect(taskMergeResult.status).toBe(409); expect(await taskMergeResult.json()).toEqual(refusalBody("grounding_enrollment_required"));
  const finishResult = await a.fetch(request({ outcome: "approve", autoMerge: true }, `/api/tasks/${u.taskId}/finish`, null));
  expect(finishResult.status).toBe(409); expect(await finishResult.json()).toEqual(refusalBody("grounding_enrollment_required"));
  expect(await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } })).toEqual(before);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("an unscoped task sharing a PR with a protected peer is refused at the effect boundary on all three paths", async () => {
  const peer = await protectedPeerElsewhere();
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: peer.peerRepo } });
  await store.db.task.update({ where: { id: u.taskId }, data: { prNumber: peer.prNumber, prUrl: `https://github.com/${peer.peerRepo}/pull/${peer.prNumber}` } });
  await reviewClaimed(u.taskId, u.projectId);
  const a = app(f.service, undefined, emptyScope);
  const before = await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } });
  const mergeResult = await a.fetch(request({ taskId: u.taskId, owner: peer.peerRepo.split("/")[0]!, repo: peer.peerRepo.split("/")[1]! }, `/api/github/pull-requests/${peer.prNumber}/merge`, null));
  expect(mergeResult.status).toBe(409); expect(await mergeResult.json()).toEqual(refusalBody("grounding_enrollment_required"));
  const taskMergeResult = await a.fetch(request({}, `/api/tasks/${u.taskId}/merge`, null));
  expect(taskMergeResult.status).toBe(409); expect(await taskMergeResult.json()).toEqual(refusalBody("grounding_enrollment_required"));
  const finishResult = await a.fetch(request({ outcome: "approve", autoMerge: true }, `/api/tasks/${u.taskId}/finish`, null));
  expect(finishResult.status).toBe(409); expect(await finishResult.json()).toEqual(refusalBody("grounding_enrollment_required"));
  expect(await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } })).toEqual(before);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("a legacy gate that refuses first answers as in the unconfigured application, before the effect boundary", async () => {
  // An in-progress task fails the legacy status gates of the GitHub and task
  // merges, and a non-AUTONOMOUS project fails the work-finish autoMerge gate,
  // even though the task's repository is an enforced one.
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: `acme/${repo}` } });
  for (const [body, path] of [
    [{ taskId: u.taskId, owner: "acme", repo }, "/api/github/pull-requests/99/merge"],
    [{}, `/api/tasks/${u.taskId}/merge`],
    [{ autoMerge: true }, `/api/tasks/${u.taskId}/finish`],
  ] as const) {
    const result = await sameAsUnconfigured(target => target.fetch(request(body, path, null)));
    expect(result.configured).toEqual(result.unconfigured);
    expect([403, 409]).toContain(result.configured.status);
    expect(result.configured.body).not.toMatchObject({ error: expect.stringMatching(/^grounding_/) });
    expect(result.configuredCalls).toEqual([]);
  }
});
it("a held unscoped task still rejects regardless of scope", async () => {
  const u = await unscopedTask();
  await store.db.groundingMigrationState.create({ data: { taskId: u.taskId, projectId: u.projectId, held: true, revision: 1 } });
  const a = app(f.service, undefined, emptyScope);
  const result = await a.fetch(request({}, `/api/tasks/${u.taskId}/merge`, null));
  expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ error: "grounding_task_held" });
});

// Targets the legacy handler acts on that differ from the ones the request
// names. Each one must be guarded before any GitHub call.
async function unscopedAt(projectRepo: string, prNumber: number | null, status = "done") {
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: projectRepo } });
  await store.db.task.update({ where: { id: u.taskId }, data: { status, prNumber, prUrl: prNumber === null ? null : `https://github.com/${projectRepo}/pull/${prNumber}` } });
  return u;
}
// A router refusal carries only the error; a refusal at a legacy handler's
// effect boundary carries a message too.
async function expectEnrollmentRequired(response: Response) {
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "grounding_enrollment_required" });
  expect(globalThis.fetch).not.toHaveBeenCalled();
}
it("github merge naming another path PR is guarded when the task's own PR is a protected peer's", async () => {
  const peer = await protectedPeerElsewhere();
  const u = await unscopedAt(peer.peerRepo, peer.prNumber);
  const [owner, name] = peer.peerRepo.split("/");
  await expectEnrollmentRequired(await app(f.service, undefined, emptyScope).fetch(request({ taskId: u.taskId, owner, repo: name }, "/api/github/pull-requests/1/merge", null)));
});
it("github merge with a decoy body repo is guarded when the path PR is a protected peer's in the project repo", async () => {
  const peer = await protectedPeerElsewhere();
  const u = await unscopedAt(peer.peerRepo, null);
  await expectEnrollmentRequired(await app(f.service, undefined, emptyScope).fetch(request({ taskId: u.taskId, owner: "decoy", repo: "decoy" }, `/api/github/pull-requests/${peer.prNumber}/merge`, null)));
});
it("github merge with a decoy body repo is guarded when the project repo is an enforced repository", async () => {
  const u = await unscopedAt(`acme/${repo}`, null);
  await expectEnrollmentRequired(await app().fetch(request({ taskId: u.taskId, owner: "decoy", repo: "decoy" }, "/api/github/pull-requests/55/merge", null)));
});
it("finish autoMerge is guarded when the body PR URL names a protected peer's PR", async () => {
  const peer = await protectedPeerElsewhere();
  const u = await unscopedAt(peer.peerRepo, 99, "in_progress");
  await store.db.project.update({ where: { id: u.projectId }, data: { governanceMode: "AUTONOMOUS" } });
  await expectEnrollmentRequired(await app(f.service, undefined, emptyScope).fetch(request({ autoMerge: true, prUrl: `https://github.com/${peer.peerRepo}/pull/${peer.prNumber}` }, `/api/tasks/${u.taskId}/finish`, null)));
});
it("github merge naming another path PR is guarded when the task's own PR is a held peer's", async () => {
  const h = await completionFixture(store);
  await store.db.groundingBinding.delete({ where: { taskId: h.taskId } });
  await store.db.groundingCohort.delete({ where: { taskId: h.taskId } });
  const heldRepo = `held/${randomUUID().replaceAll("-", "")}`;
  await store.db.project.update({ where: { id: h.projectId }, data: { githubRepo: heldRepo } });
  await store.db.task.update({ where: { id: h.taskId }, data: { status: "review", prNumber: 8, prUrl: `https://github.com/${heldRepo}/pull/8` } });
  await store.db.groundingMigrationState.create({ data: { taskId: h.taskId, projectId: h.projectId, held: true, revision: 1 } });
  const u = await unscopedAt(heldRepo, 8);
  const [owner, name] = heldRepo.split("/");
  await expectEnrollmentRequired(await app(f.service, undefined, emptyScope).fetch(request({ taskId: u.taskId, owner, repo: name }, "/api/github/pull-requests/2/merge", null)));
});
it("an enforced project without a GitHub repository still rejects on every remote path", async () => {
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: null } });
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "done", prNumber: 3, prUrl: null } });
  const a = app(f.service, undefined, { projectIds: new Set([u.projectId]), repos: new Set() });
  await expectEnrollmentRequired(await a.fetch(request({}, `/api/tasks/${u.taskId}/merge`, null)));
  await expectEnrollmentRequired(await a.fetch(request({ taskId: u.taskId, owner: "elsewhere", repo: "unrelated" }, "/api/github/pull-requests/3/merge", null)));
});
// The legacy merger derives its repository from the project alone, so a task
// whose project has none is refused by the legacy handler itself, before any
// GitHub call, whatever its PR URL names.
it("a task without a project repository gets the legacy merger's own refusal even when its PR URL names an enforced repository", async () => {
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: null } });
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "done", deliverableRepo: null, prNumber: 55, prUrl: `https://github.com/acme/${repo}/pull/55` } });
  const configured = await app().fetch(request({}, `/api/tasks/${u.taskId}/merge`, null));
  const unconfigured = await createApp("").fetch(request({}, `/api/tasks/${u.taskId}/merge`, null));
  const answer = { status: configured.status, body: await configured.json() };
  expect(answer).toEqual({ status: unconfigured.status, body: await unconfigured.json() });
  expect(answer).toMatchObject({ status: 502, body: { error: "github_error" } });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("a peer whose PR is recorded only in its PR URL still guards the shared PR", async () => {
  const peer = await protectedPeerElsewhere();
  await store.db.task.update({ where: { id: peer.taskId }, data: { prNumber: null } });
  const u = await unscopedAt(peer.peerRepo, peer.prNumber);
  await expectEnrollmentRequired(await app(f.service, undefined, emptyScope).fetch(request({}, `/api/tasks/${u.taskId}/merge`, null)));
});

// PR creation outside the enforced scope belongs to the legacy creator.
function legacyCreateResponse(ownRepo: string, number = 5) {
  return vi.fn(async () => Response.json({ number, html_url: `https://github.com/${ownRepo}/pull/${number}`, title: "Create" }, { status: 201 }));
}
it("a keyless create inside the enforced scope requires a key and one outside it reaches the legacy creator", async () => {
  const inside = await unscopedTask();
  const [insideOwner, insideName] = inside.ownRepo.split("/");
  const scoped = await app(f.service, undefined, { projectIds: new Set([inside.projectId]), repos: new Set() }).fetch(request({ taskId: inside.taskId, owner: insideOwner, repo: insideName, head: "feature", title: "Create" }, "/api/github/pull-requests", null));
  expect(scoped.status).toBe(400); expect(await scoped.json()).toMatchObject({ error: "grounding_operation_key_required" });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  const outside = await unscopedTask();
  const [owner, name] = outside.ownRepo.split("/");
  vi.stubGlobal("fetch", legacyCreateResponse(outside.ownRepo));
  const legacy = await app(f.service, undefined, emptyScope).fetch(request({ taskId: outside.taskId, owner, repo: name, head: "feature", title: "Create" }, "/api/github/pull-requests", null));
  expect(legacy.status).toBe(201);
  expect(await legacy.json()).toEqual({ pullRequest: { number: 5, url: `https://github.com/${outside.ownRepo}/pull/5`, title: "Create" }, task: { id: outside.taskId, branchName: "feature", prUrl: `https://github.com/${outside.ownRepo}/pull/5`, prNumber: 5 } });
  expect(fetchCalls()).toEqual([`https://api.github.com/repos/${outside.ownRepo}/pulls`]);
  expect(await store.db.groundingGithubCreateOperation.count({ where: { taskId: outside.taskId } })).toBe(0);
});
it("a keyed create for an unscoped task reaches the legacy creator, which records the header key", async () => {
  const u = await unscopedTask();
  const [owner, name] = u.ownRepo.split("/");
  vi.stubGlobal("fetch", legacyCreateResponse(u.ownRepo));
  const a = app(f.service, new GroundingGithubCreateService({ db: store.db }), emptyScope);
  const body = { taskId: u.taskId, owner, repo: name, head: "feature", title: "Create" };
  const first = await a.fetch(request(body, "/api/github/pull-requests", "mcp-generated-key"));
  expect(first.status).toBe(201); expect(first.headers.get("X-Idempotent-Replay")).toBeNull();
  expect(await store.db.toolInvocation.findUnique({ where: { projectId_verb_idempotencyKey: { projectId: u.projectId, verb: "pull_requests_create", idempotencyKey: "mcp-generated-key" } } })).toMatchObject({ statusCode: 201 });
  const retry = await a.fetch(request(body, "/api/github/pull-requests", "mcp-generated-key"));
  expect(retry.status).toBe(201); expect(retry.headers.get("X-Idempotent-Replay")).toBe("true");
  expect(fetchCalls()).toEqual([`https://api.github.com/repos/${u.ownRepo}/pulls`]);
  expect(await store.db.groundingGithubCreateOperation.count({ where: { taskId: u.taskId } })).toBe(0);
  expect(await store.db.groundingGithubFenceIntent.count({ where: { taskId: u.taskId } })).toBe(0);
});
it("a failed keyed legacy create for an unscoped task leaves no owned fence and sibling writes succeed", async () => {
  const u = await unscopedTask();
  const sibling = await store.db.task.create({ data: { projectId: u.projectId, title: "Unrelated sibling", status: "open" } });
  const [owner, name] = u.ownRepo.split("/");
  const a = app(f.service, new GroundingGithubCreateService({ db: store.db }), emptyScope);
  const result = await a.fetch(request({ taskId: u.taskId, owner, repo: name, head: "feature", title: "Create" }, "/api/github/pull-requests", "mcp-generated-key"));
  expect(result.status).toBe(500);
  expect(fetchCalls()).toEqual([`https://api.github.com/repos/${u.ownRepo}/pulls`]);
  expect(await store.db.groundingGithubCreateOperation.count({ where: { taskId: u.taskId } })).toBe(0);
  expect(await store.db.groundingGithubFenceIntent.count({ where: { taskId: u.taskId } })).toBe(0);
  expect(await store.db.groundingGithubRepositoryFence.findUnique({ where: { repo: u.ownRepo } })).toMatchObject({ ownerId: null });
  await store.db.task.update({ where: { id: sibling.id }, data: { title: "Sibling edit" } });
  expect(await store.db.task.findUniqueOrThrow({ where: { id: sibling.id } })).toMatchObject({ title: "Sibling edit" });
});
// "k/+=" is a valid create key that the merge key format rejects, so the
// history lookup must use the create key format.
it.each(["mcp-generated-key", "k/+="])("a keyed create with durable create history under key %s keeps using the grouped create service", async historyKey => {
  const u = await unscopedTask();
  const [owner, name] = u.ownRepo.split("/");
  const a = app(f.service, new GroundingGithubCreateService({ db: store.db }), emptyScope);
  const body = { taskId: u.taskId, owner, repo: name, head: "feature", title: "Create" };
  const intent = await store.db.groundingGithubFenceIntent.create({ data: { id: randomUUID(), repo: u.ownRepo, kind: "PR_CREATE", taskId: u.taskId, state: "COMPLETED" } });
  await store.db.groundingGithubCreateOperation.create({ data: { id: intent.id, taskId: u.taskId, projectId: u.projectId, key: historyKey, actorId: ids.agent, actorUserId: ids.user, actorTeamId: ids.team, fingerprint: "0".repeat(64), request: { owner, repo: name, head: "feature", base: "main", title: "Create" }, delegateUserId: ids.user, state: "COMPLETED" } });
  const result = await a.fetch(request(body, "/api/github/pull-requests", historyKey));
  expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ error: "grounding_operation_conflict" });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("configured unrelated unprovisioned local finish preserves compatibility", async () => {
  await store.db.groundingBinding.delete({ where: { taskId: f.taskId } }); await store.db.groundingCohort.delete({ where: { taskId: f.taskId } });
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "in_progress", metadata: { debugFlavor: false } } });
  const result = await app().fetch(request({}, `/api/tasks/${f.taskId}/finish`, null)); expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ kind: "work", targetStatus: "review" });
  await vi.waitFor(async () => expect(await store.db.comment.count({ where: { taskId: f.taskId } })).toBe(1)); expect(f.merge).not.toHaveBeenCalled();
});

function createFixture() {
  const raw = { number: 43, html_url: `https://github.com/acme/${repo}/pull/43`, title: "Create", head: { label: "acme:new", ref: "new", sha: f.head, repo: { full_name: `acme/${repo}`, owner: { login: "acme" } } }, base: { ref: "main", repo: { full_name: `acme/${repo}` } } };
  const proof = (operationId: string) => ({ ...structuredClone(raw), body: `\n\n${githubCreateCorrelationMarker(operationId)}` });
  const create = vi.fn<GroundingGithubCreateProvider["create"]>(async (_request, _token, operationId) => proof(operationId));
  const read = vi.fn<GroundingGithubCreateProvider["read"]>(async (_request, _token, operationId) => ({ complete: true, pullRequests: [proof(operationId)] }));
  const service = new GroundingGithubCreateService({ db: store.db, provider: { create, read } });
  return { raw, create, read, a: app(f.service, service), body: { ...mergeBody(), title: "Create", head: "new" } };
}
it.each([true, false])("N27 configured create with enrolled=%s binds once; retry returns historical201 without POST", async enrolled => {
  if (enrolled) await f.evidence("merge");
  else { await store.db.groundingBinding.delete({ where: { taskId: f.taskId } }); await store.db.groundingCohort.delete({ where: { taskId: f.taskId } }); }
  const before = await f.snapshot(); const c = createFixture();
  const first = await c.a.fetch(request(c.body, "/api/github/pull-requests")); expect(first.status).toBe(201); const saved = await first.json();
  expect(saved).toEqual({ pullRequest: { number: 43, url: c.raw.html_url, title: "Create" }, task: { id: f.taskId, branchName: "new", prUrl: c.raw.html_url, prNumber: 43 } });
  const after = await f.snapshot();
  if (enrolled) { expect(after.binding?.contextRevision).toBe(before.binding!.contextRevision + 1); expect(after.binding?.activeAttemptId).toBeNull(); expect(after.attempts[0].state).toBe("SUPERSEDED"); }
  else { expect(after.binding).toBeNull(); expect(after.cohort).toBeNull(); }
  expect(after.task).toMatchObject({ status: before.task!.status, claimedByAgentId: before.task!.claimedByAgentId });
  const retry = await c.a.fetch(request({ ...c.body, idempotencyKey: "route-operation" }, "/api/github/pull-requests", null)); expect(retry.status).toBe(201); expect(await retry.json()).toEqual(saved); expect(retry.headers.get("X-Idempotent-Replay")).toBe("true");
  expect(await f.snapshot()).toEqual(after); expect(c.create).toHaveBeenCalledOnce();
});
it("N27 mounted create collides with committed merge reservation before POST", async () => {
  await f.evidence("merge"); f.merge.mockRejectedValueOnce(new Error("pending")); expect((await app().fetch(request(mergeBody()))).status).toBe(202);
  const c = createFixture(); const before = await f.snapshot(); const result = await c.a.fetch(request(c.body, "/api/github/pull-requests", "create"));
  expect(result.status).toBe(409); expect(c.create).not.toHaveBeenCalled(); expect(await f.snapshot()).toEqual(before);
});
it("configured create durable202 recovers by read and rejects changed key payload", async () => {
  const c = createFixture(); c.create.mockRejectedValueOnce(new Error("uncertain"));
  const first = await c.a.fetch(request(c.body, "/api/github/pull-requests")); expect(first.status).toBe(202); expect(await first.json()).toMatchObject({ error: "grounding_github_create_pending", state: "DISPATCHED" });
  expect((await c.a.fetch(request({ ...c.body, head: "other" }, "/api/github/pull-requests"))).status).toBe(409);
  expect((await c.a.fetch(request(c.body, "/api/github/pull-requests"))).status).toBe(201); expect(c.create).toHaveBeenCalledOnce(); expect(c.read).toHaveBeenCalledOnce();
});
it("N14 createApp wires signature-verified webhook observation without completion effects", async () => {
  const body = JSON.stringify({ action: "closed", repository: { full_name: `acme/${repo}` }, pull_request: { number: 42, html_url: `https://github.com/acme/${repo}/pull/42`, title: "PR", state: "closed", merged: true, head: { sha: f.head, ref: "branch" } } });
  const delivery = randomUUID(); const send = (signature: string) => app().request("/api/webhooks/github", { method: "POST", body, headers: { "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": delivery, "X-Hub-Signature-256": signature } });
  expect((await send("bad")).status).toBe(401); expect(await store.db.groundingGithubWebhookDelivery.count({ where: { deliveryId: delivery } })).toBe(0);
  const signature = `sha256=${createHmac("sha256", "configured-test-secret").update(body).digest("hex")}`;
  expect((await send(signature)).status).toBe(200); expect((await send(signature)).status).toBe(200);
  expect((await f.task()).status).toBe("review"); expect(await store.db.groundingGithubObservation.count({ where: { taskId: f.taskId } })).toBe(1); expect(f.merge).not.toHaveBeenCalled();
});
it("ST1-M1 grouped mounted default head accepts canonical GitHub casing without changing context bytes", async () => {
  const storedRepo = `Acme/${repo.toUpperCase()}`;
  await store.db.project.update({ where: { id: f.projectId }, data: { githubRepo: storedRepo } });
  await store.db.task.update({ where: { id: f.taskId }, data: { prUrl: `https://github.com/${storedRepo}/pull/42` } });
  const fetcher = vi.fn(async () => Response.json({ number: 42, html_url: `https://github.com/acme/${repo}/pull/42`, base: { repo: { full_name: `acme/${repo}` } }, head: { sha: f.head } })); vi.stubGlobal("fetch", fetcher);
  const deps = { db: store.db, config: { audience: "consumer.test", trust: () => f.issuer.trust }, now: () => f.now };
  const attempts = new GroundingAttemptsService(deps); const challenge = await attempts.issue(f.taskId, actor, "merge");
  await attempts.ingest(f.taskId, challenge.attemptId, actor, session, f.issuer.receipt(challenge));
  const before = await store.db.groundingAttempt.findUniqueOrThrow({ where: { id: challenge.attemptId } });
  expect(JSON.parse(before.contextBytes.toString()).deliverable.repo).toBe(storedRepo);
  f.proof.repo = storedRepo;
  const service = new GroundingGithubMergeService({ ...deps, mergeProvider: { merge: f.merge, read: f.read }, deliverSignal: f.deliverSignal });
  const result = await createApp("", attempts, { db: store.db, service, scope: defaultScope(), remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope: defaultScope() }) }).fetch(request(mergeBody())); expect(result.status).toBe(200); expect(f.merge).toHaveBeenCalledOnce();
  expect((await store.db.groundingAttempt.findUniqueOrThrow({ where: { id: challenge.attemptId } })).contextBytes).toEqual(before.contextBytes); expect(fetcher).toHaveBeenCalled();
});

it.each([true, false])("unprovisioned bodyless abandon preserves legacy parsing with configured=%s", async configured => {
  await store.db.groundingBinding.delete({ where: { taskId: f.taskId } }); await store.db.groundingCohort.delete({ where: { taskId: f.taskId } });
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "in_progress" } });
  const a = configured ? app() : createApp("");
  const result = await a.fetch(new Request(`http://localhost/api/tasks/${f.taskId}/abandon`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }));
  expect(result.status).toBe(200); expect((await f.task()).claimedByAgentId).toBeNull();
});

it.each(["direct", "task"])("durable completed %s history precedes current partial enrollment", async kind => {
  await f.evidence("merge"); const path = kind === "direct" ? "/api/github/pull-requests/42/merge" : `/api/tasks/${f.taskId}/merge`;
  const body = kind === "direct" ? mergeBody() : {}; const a = app();
  const first = await a.fetch(request(body, path)); expect(first.status).toBe(200); const saved = await first.json();
  await store.db.groundingCohort.delete({ where: { taskId: f.taskId } });
  const replay = await a.fetch(request(body, path)); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(saved); expect(f.merge).toHaveBeenCalledOnce();
  expect((await a.fetch(request(body, path, "fresh"))).status).toBe(503);
});
it("unavailable durable-state read after remote success returns503 instead of asserting dispatch", async () => {
  await f.evidence("merge");
  const hook = vi.spyOn(audit, "logGroundingDecision").mockImplementationOnce(async () => {
    vi.spyOn(store.db, "$transaction").mockRejectedValueOnce(new Error("database offline"));
    throw new Error("binding transaction failed");
  });
  const result = await app().fetch(request(mergeBody())); hook.mockRestore();
  expect(result.status).toBe(503); expect(await result.json()).toMatchObject({ error: "grounding_verification_unavailable" }); expect(f.merge).toHaveBeenCalledOnce();
  expect((await app().fetch(request(mergeBody()))).status).toBe(200); expect(f.merge).toHaveBeenCalledOnce();
});

it("N13 bare autoMergeSha without durable operation grants no direct merged success", async () => {
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "done", autoMergeSha: "b".repeat(40) } });
  const before = await f.snapshot(); const result = await app().fetch(request(mergeBody()));
  expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ error: "bad_state" }); expect(await f.snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
});

// Repository strings that are not canonical owner/repo identities (a dot
// segment, a percent-encoded name, an owner containing '/') cannot be compared
// with the enforced scope, so any such string among a request's candidate
// repositories makes the operation guarded.
async function repolessTask() {
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: null } });
  await store.db.task.update({ where: { id: u.taskId }, data: { prNumber: null, prUrl: null, deliverableRepo: null } });
  return u;
}
const createRequest = (taskId: string, owner: string, name: string, extra: Record<string, unknown> = {}) => ({ taskId, owner, repo: name, head: "feature", title: "Create", ...extra });
const percentAlias = (name: string) => `%${name.charCodeAt(0).toString(16)}${name.slice(1)}`;
// Refused at the legacy creator's effect boundary, before the POST.
async function expectCreateGuarded(response: Response, taskId: string) {
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "grounding_enrollment_required" });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(await store.db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ prUrl: null, prNumber: null });
}
it("a create naming the enforced repository from a repository-less unscoped task is guarded", async () => {
  const u = await repolessTask();
  vi.stubGlobal("fetch", legacyCreateResponse(`acme/${repo}`));
  await expectCreateGuarded(await app().fetch(request(createRequest(u.taskId, "acme", repo), "/api/github/pull-requests", null)), u.taskId);
});
it.each([
  ["a dot-segment repository", (name: string) => ["acme", `${name}/.`]],
  ["an owner containing '/'", (name: string) => [`acme/${name}`, "."]],
  ["a percent-encoded dot segment", (name: string) => ["acme", `${name}/%2e`]],
  ["a percent-encoded repository name", (name: string) => ["acme", percentAlias(name)]],
] as const)("a keyless create naming %s is guarded before any GitHub call", async (_label, target) => {
  const u = await repolessTask();
  vi.stubGlobal("fetch", legacyCreateResponse(`acme/${repo}`));
  const [owner, name] = target(repo);
  await expectCreateGuarded(await app(f.service, undefined, emptyScope).fetch(request(createRequest(u.taskId, owner, name), "/api/github/pull-requests", null)), u.taskId);
});
it("a keyed create naming a dot-segment repository goes to the grouped service, which refuses it before any GitHub call", async () => {
  const u = await repolessTask();
  vi.stubGlobal("fetch", legacyCreateResponse(`acme/${repo}`));
  const result = await app(f.service, new GroundingGithubCreateService({ db: store.db }), emptyScope).fetch(request(createRequest(u.taskId, "acme", `${repo}/.`), "/api/github/pull-requests", "reviewer-key"));
  expect(result.status).not.toBe(201);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } })).toMatchObject({ prUrl: null, prNumber: null });
  expect(await store.db.groundingGithubCreateOperation.count({ where: { taskId: u.taskId } })).toBe(0);
});
it("a create whose deliverable repository is a percent-encoded alias is guarded", async () => {
  const u = await unscopedTask();
  const alias = percentAlias(repo);
  await store.db.task.update({ where: { id: u.taskId }, data: { deliverableRepo: `acme/${alias}`, prNumber: null, prUrl: null } });
  vi.stubGlobal("fetch", legacyCreateResponse(`acme/${repo}`));
  await expectCreateGuarded(await app(f.service, undefined, emptyScope).fetch(request(createRequest(u.taskId, "acme", alias), "/api/github/pull-requests", null)), u.taskId);
});
it("a github merge for a task whose project repository is a percent-encoded alias is guarded", async () => {
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: `acme/${percentAlias(repo)}` } });
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "done", prNumber: 42, prUrl: null } });
  await expectEnrollmentRequired(await app(f.service, undefined, emptyScope).fetch(request({ taskId: u.taskId, owner: "decoy", repo: "decoy" }, "/api/github/pull-requests/42/merge", null)));
});
it("a task merge whose project repository is not canonical is refused at the effect boundary; a foreign finish PR URL gets the legacy cross-repo refusal", async () => {
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { governanceMode: "AUTONOMOUS" } });
  const a = app(f.service, undefined, emptyScope);
  // The legacy work finish rejects a PR URL outside the task's repository
  // before it merges anything, exactly as the unconfigured application does.
  const finish = await sameAsUnconfigured(target => target.fetch(request({ autoMerge: true, prUrl: `https://github.com/acme/${percentAlias(repo)}/pull/9` }, `/api/tasks/${u.taskId}/finish`, null)));
  expect(finish.configured).toEqual(finish.unconfigured);
  expect(finish.configured).toMatchObject({ status: 400, body: { error: "cross_repo_pr_rejected" } });
  expect(finish.configuredCalls).toEqual([]);
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "done" } });
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: `acme/${repo}/.` } });
  await expectEnrollmentRequired(await a.fetch(request({}, `/api/tasks/${u.taskId}/merge`, null)));
});

// A legacy effect in a repository whose fence another operation owns could
// not record its outcome, so it is refused before the GitHub call.
async function ownFence(projectId: string, repository: string, kind: "PR_CREATE" | "MERGE") {
  const other = await store.db.task.create({ data: { projectId, title: "In-flight grouped operation", status: "in_progress" } });
  const intent = await store.db.groundingGithubFenceIntent.create({ data: { id: randomUUID(), repo: repository, kind, taskId: other.id, state: "ACTIVE" } });
  await store.db.groundingGithubRepositoryFence.update({ where: { repo: repository }, data: { ownerId: intent.id } });
}
async function expectFinalizationPending(response: Response) {
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "grounding_finalization_pending" });
  expect(globalThis.fetch).not.toHaveBeenCalled();
}
it("a legacy create is refused before GitHub while another task's grouped create owns the repository fence", async () => {
  const u = await unscopedTask();
  const [owner, name] = u.ownRepo.split("/");
  await ownFence(u.projectId, u.ownRepo, "PR_CREATE");
  const before = await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } });
  vi.stubGlobal("fetch", legacyCreateResponse(u.ownRepo, 6));
  const a = app(f.service, new GroundingGithubCreateService({ db: store.db }), emptyScope);
  await expectFinalizationPending(await a.fetch(request(createRequest(u.taskId, owner, name), "/api/github/pull-requests", null)));
  await expectFinalizationPending(await a.fetch(request(createRequest(u.taskId, owner, name, { head: "feature-2" }), "/api/github/pull-requests", "fenced-create")));
  expect(await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } })).toEqual(before);
  expect(await store.db.groundingGithubCreateOperation.count({ where: { taskId: u.taskId } })).toBe(0);
});
it("a legacy merge is refused before GitHub on all three paths while another operation owns the repository fence", async () => {
  const u = await unscopedTask();
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "review", claimedByAgentId: null, claimedByUserId: null, reviewClaimedByAgentId: ids.agent } });
  await store.db.project.update({ where: { id: u.projectId }, data: { governanceMode: "AUTONOMOUS" } });
  await ownFence(u.projectId, u.ownRepo, "MERGE");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sha: "b".repeat(40), merged: true, message: "Pull Request successfully merged" }, { status: 200 })));
  const [owner, name] = u.ownRepo.split("/");
  const a = app(f.service, undefined, emptyScope);
  const before = await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } });
  await expectFinalizationPending(await a.fetch(request({ taskId: u.taskId, owner, repo: name }, "/api/github/pull-requests/99/merge", null)));
  await expectFinalizationPending(await a.fetch(request({}, `/api/tasks/${u.taskId}/merge`, null)));
  await expectFinalizationPending(await a.fetch(request({ outcome: "approve", autoMerge: true }, `/api/tasks/${u.taskId}/finish`, null)));
  expect(await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } })).toEqual(before);
});

// A provisioned task, or any task with unfinished grouped create history,
// keeps PR creation on the grouped service whatever the enforced scope says.
it.each(["EXTERNAL_V1", "OFF"] as const)("a %s task outside the enforced scope keeps keyless and keyed creates on the grouped service", async mode => {
  const t = mode === "EXTERNAL_V1" ? f : await completionFixture(store, mode, deps => new GroundingGithubMergeService(deps));
  if (mode === "OFF") await store.db.project.update({ where: { id: t.projectId }, data: { githubRepo: `acme/${repo}` } });
  const c = createFixture();
  const a = app(f.service, new GroundingGithubCreateService({ db: store.db, provider: { create: c.create, read: c.read } }), emptyScope);
  const body = createRequest(t.taskId, "acme", repo, { head: "new" });
  const keyless = await a.fetch(request(body, "/api/github/pull-requests", null));
  expect(keyless.status).toBe(400); expect(await keyless.json()).toMatchObject({ error: "grounding_operation_key_required" });
  await a.fetch(request(body, "/api/github/pull-requests", "grouped-create"));
  expect(c.create).toHaveBeenCalledOnce();
  expect(await store.db.groundingGithubCreateOperation.count({ where: { taskId: t.taskId, key: "grouped-create" } })).toBe(1);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it.each(["RESERVED", "DISPATCHED"] as const)("an unscoped task with a %s grouped create under another key keeps a fresh keyed create grouped", async state => {
  const u = await unscopedTask();
  const [owner, name] = u.ownRepo.split("/");
  const intent = await store.db.groundingGithubFenceIntent.create({ data: { id: randomUUID(), repo: u.ownRepo, kind: "PR_CREATE", taskId: u.taskId, state: "COMPLETED" } });
  await store.db.groundingGithubCreateOperation.create({ data: { id: intent.id, taskId: u.taskId, projectId: u.projectId, key: "key-a", actorId: ids.agent, actorUserId: ids.user, actorTeamId: ids.team, fingerprint: "0".repeat(64), request: { owner, repo: name, head: "feature", base: "main", title: "Create" }, delegateUserId: ids.user, state } });
  vi.stubGlobal("fetch", legacyCreateResponse(u.ownRepo));
  const create = vi.fn<GroundingGithubCreateProvider["create"]>(async () => { throw new Error("grouped provider reached"); });
  const read = vi.fn<GroundingGithubCreateProvider["read"]>(async () => ({ complete: true, pullRequests: [] }));
  const grouped = new GroundingGithubCreateService({ db: store.db, provider: { create, read } });
  await app(f.service, grouped, emptyScope).fetch(request(createRequest(u.taskId, owner, name), "/api/github/pull-requests", "key-b"));
  expect(await store.db.groundingGithubCreateOperation.count({ where: { taskId: u.taskId, key: "key-b" } })).toBe(1);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(await store.db.toolInvocation.count({ where: { projectId: u.projectId, verb: "pull_requests_create" } })).toBe(0);
});
it("a provisioned task outside the enforced scope keeps keyless create and merge on the grouped contract", async () => {
  vi.stubGlobal("fetch", legacyCreateResponse(`acme/${repo}`));
  const a = app(f.service, new GroundingGithubCreateService({ db: store.db }), emptyScope);
  const create = await a.fetch(request(createRequest(f.taskId, "acme", repo), "/api/github/pull-requests", null));
  expect(create.status).toBe(400); expect(await create.json()).toMatchObject({ error: "grounding_operation_key_required" });
  const merge = await a.fetch(request(mergeBody(), "/api/github/pull-requests/42/merge", null));
  expect(merge.status).toBe(400); expect(await merge.json()).toMatchObject({ error: "grounding_operation_key_required" });
  expect(globalThis.fetch).not.toHaveBeenCalled(); expect(f.merge).not.toHaveBeenCalled();
});

// Outside the enforced scope the legacy handlers receive the request exactly
// as sent: the same response configured and unconfigured, including inputs the
// Grounding contract would reject (key format, strict body, path number).
async function sameAsUnconfigured(send: (target: ReturnType<typeof createApp>) => Response | Promise<Response>) {
  const configured = await send(app(f.service, new GroundingGithubCreateService({ db: store.db }), emptyScope));
  const configuredCalls = fetchCalls();
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockClear();
  // The stubbed fetch rejects, an unknown merge outcome: the first request
  // keeps its merge reservation until the lease lapses. Drop it so the second
  // request meets the same task state instead of merge_in_progress.
  await store.db.task.updateMany({ where: { mergeReservedAt: { not: null } }, data: { mergeReservedAt: null, mergeReservedByUserId: null, mergeReservedByAgentId: null } });
  const unconfigured = await send(createApp(""));
  return { configured: { status: configured.status, body: await configured.json() }, unconfigured: { status: unconfigured.status, body: await unconfigured.json() }, configuredCalls, unconfiguredCalls: fetchCalls() };
}
it("a github merge with a body key outside the Grounding key format reaches the legacy handler unchanged", async () => {
  const u = await unscopedTask();
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "done" } });
  const [owner, name] = u.ownRepo.split("/");
  const result = await sameAsUnconfigured(target => target.fetch(request({ taskId: u.taskId, owner, repo: name, idempotencyKey: "legacy key/with space" }, "/api/github/pull-requests/99/merge", null)));
  expect(result.configured).toEqual(result.unconfigured);
  expect(result.configured).toMatchObject({ status: 502, body: { error: "github_error" } });
  expect(result.configuredCalls).toEqual([`https://api.github.com/repos/${u.ownRepo}/pulls/99/merge`]);
  expect(result.unconfiguredCalls).toEqual(result.configuredCalls);
});
it("a github merge with a leading-zero path number reaches the legacy handler unchanged", async () => {
  const u = await unscopedTask();
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "done" } });
  const [owner, name] = u.ownRepo.split("/");
  const result = await sameAsUnconfigured(target => target.fetch(request({ taskId: u.taskId, owner, repo: name }, "/api/github/pull-requests/099/merge", null)));
  expect(result.configured).toEqual(result.unconfigured);
  expect(result.configured).toMatchObject({ status: 502, body: { error: "github_error" } });
  expect(result.configuredCalls).toEqual([`https://api.github.com/repos/${u.ownRepo}/pulls/99/merge`]);
  expect(result.unconfiguredCalls).toEqual(result.configuredCalls);
});
it("a create with a body field outside the Grounding contract reaches the legacy creator unchanged", async () => {
  const u = await unscopedTask();
  const [owner, name] = u.ownRepo.split("/");
  vi.stubGlobal("fetch", legacyCreateResponse(u.ownRepo));
  const result = await sameAsUnconfigured(target => target.fetch(request(createRequest(u.taskId, owner, name, { draft: true }), "/api/github/pull-requests", null)));
  expect(result.configured).toEqual(result.unconfigured);
  expect(result.configured).toMatchObject({ status: 201, body: { pullRequest: { number: 5 } } });
  expect(result.configuredCalls).toEqual([`https://api.github.com/repos/${u.ownRepo}/pulls`]);
  expect(result.unconfiguredCalls).toEqual(result.configuredCalls);
});
it("a create whose header and body keys differ reaches the legacy creator, which rejects it", async () => {
  const u = await unscopedTask();
  const [owner, name] = u.ownRepo.split("/");
  vi.stubGlobal("fetch", legacyCreateResponse(u.ownRepo));
  const result = await sameAsUnconfigured(target => target.fetch(request(createRequest(u.taskId, owner, name, { idempotencyKey: "body-key" }), "/api/github/pull-requests", "header-key")));
  expect(result.configured).toEqual(result.unconfigured);
  expect(result.configured).toEqual({ status: 400, body: { error: "validation_error", message: "Idempotency-Key header and body idempotencyKey differ" } });
  expect(result.configuredCalls).toEqual([]); expect(result.unconfiguredCalls).toEqual([]);
});
it("the legacy creator accepts the same key in header and body and replays it from either", async () => {
  const u = await unscopedTask();
  const [owner, name] = u.ownRepo.split("/");
  vi.stubGlobal("fetch", legacyCreateResponse(u.ownRepo));
  const legacy = createApp("");
  const first = await legacy.fetch(request(createRequest(u.taskId, owner, name, { idempotencyKey: "same-key" }), "/api/github/pull-requests", "same-key"));
  expect(first.status).toBe(201); expect(first.headers.get("X-Idempotent-Replay")).toBeNull();
  const bodyOnly = await legacy.fetch(request(createRequest(u.taskId, owner, name, { idempotencyKey: "same-key" }), "/api/github/pull-requests", null));
  expect(bodyOnly.status).toBe(201); expect(bodyOnly.headers.get("X-Idempotent-Replay")).toBe("true");
  const invalidHeader = await legacy.fetch(request(createRequest(u.taskId, owner, name), "/api/github/pull-requests", " "));
  expect(invalidHeader.status).toBe(400); expect(await invalidHeader.json()).toMatchObject({ error: "validation_error", message: "Invalid Idempotency-Key header" });
  expect(fetchCalls()).toEqual([`https://api.github.com/repos/${u.ownRepo}/pulls`]);
});
it("a finish with a malformed Idempotency-Key and an unknown body field reaches the legacy handler unchanged", async () => {
  // An unclaimed task makes the legacy handler reject the finish without side
  // effects, so both applications see the same task state.
  const u = await unscopedTask();
  await store.db.task.update({ where: { id: u.taskId }, data: { claimedByAgentId: null } });
  const before = await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } });
  const result = await sameAsUnconfigured(target => target.fetch(request({ result: "done", unknownField: true }, `/api/tasks/${u.taskId}/finish`, "not a key/")));
  expect(result.configured).toEqual(result.unconfigured);
  expect(result.configured.status).toBeGreaterThanOrEqual(400);
  expect(result.configured.body).not.toMatchObject({ error: expect.stringMatching(/^grounding_/) });
  expect(await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } })).toEqual(before);
  expect(result.configuredCalls).toEqual([]);
});

// A reservation that keeps failing to serialize while a concurrent same-key
// request reserved and dispatched the operation is answered from that
// operation's durable history, as a retry would be.
it.each(["completed", "dispatched"])("a failed reservation whose key has %s durable history answers from that history", async state => {
  await f.evidence("merge"); const a = app();
  if (state === "dispatched") f.merge.mockRejectedValueOnce(new Error("pending"));
  const first = await a.fetch(request(mergeBody())); expect(first.status).toBe(state === "completed" ? 200 : 202);
  const saved = await first.json();
  const lookup = vi.spyOn(f.service, "lookupRouteOperation").mockResolvedValueOnce(null);
  const reserve = vi.spyOn(f.service, "reserveMerge").mockRejectedValueOnce(new GroundingReceiptVerificationError("grounding_verification_unavailable"));
  const result = await a.fetch(request(mergeBody()));
  expect(reserve).toHaveBeenCalledOnce(); expect(lookup).toHaveBeenCalledTimes(2);
  if (state === "completed") { expect(result.status).toBe(200); expect(await result.json()).toEqual(saved); expect(result.headers.get("X-Idempotent-Replay")).toBe("true"); }
  else { expect(result.status).toBe(202); expect(await result.json()).toEqual({ state: "DISPATCHED", pending: true }); }
  expect(f.merge).toHaveBeenCalledOnce();
});
it("a failed reservation without durable history for its key still fails", async () => {
  await f.evidence("merge");
  vi.spyOn(f.service, "reserveMerge").mockRejectedValueOnce(new GroundingReceiptVerificationError("grounding_verification_unavailable"));
  const result = await app().fetch(request(mergeBody()));
  expect(result.status).toBe(503); expect(await result.json()).toMatchObject({ error: "grounding_verification_unavailable" });
  expect(f.merge).not.toHaveBeenCalled();
});

it("a keyed github merge whose key has durable operation history on an unprovisioned task stays on the Grounding path", async () => {
  const u = await unscopedTask();
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "done" } });
  await store.db.groundingOperation.create({ data: { taskId: u.taskId, key: "prior-key", actorType: "agent", actorId: ids.agent, fingerprint: "0".repeat(64), request: {}, decision: {}, state: "COMPLETED", result: {} } });
  const [owner, name] = u.ownRepo.split("/");
  const a = app(f.service, undefined, emptyScope);
  for (const [header, body] of [["prior-key", {}], [null, { idempotencyKey: "prior-key" }]] as const) {
    const result = await a.fetch(request({ taskId: u.taskId, owner, repo: name, ...body }, "/api/github/pull-requests/99/merge", header));
    expect(result.status).toBe(409); expect(await result.json()).toEqual({ error: "bad_state" });
  }
  expect(globalThis.fetch).not.toHaveBeenCalled();
  // Without that history the same request is the legacy handler's.
  const legacy = await a.fetch(request({ taskId: u.taskId, owner, repo: name }, "/api/github/pull-requests/99/merge", "fresh-key"));
  expect(legacy.status).toBe(502); expect(fetchCalls()).toEqual([`https://api.github.com/repos/${u.ownRepo}/pulls/99/merge`]);
});

// A caller without access to the task's project gets the legacy handlers' own
// answer before any Grounding state is read or locked, so the answer does not
// depend on whether the task is held, provisioned, guarded, fenced or has
// pending Grounding history.
type ForeignTarget = { taskId: string; owner: string; name: string; prPath: string; key: string | null; scope: GroundingEnforcedScope };
function foreignTarget(u: Awaited<ReturnType<typeof unscopedTask>>, scope: GroundingEnforcedScope = emptyScope): ForeignTarget {
  const [owner, name] = u.ownRepo.split("/");
  return { taskId: u.taskId, owner: owner!, name: name!, prPath: "99", key: null, scope };
}
const foreignTargets: [string, () => Promise<ForeignTarget>][] = [
  ["unprovisioned unscoped", async () => foreignTarget(await unscopedTask())],
  ["held", async () => {
    const u = await unscopedTask();
    await store.db.groundingMigrationState.create({ data: { taskId: u.taskId, projectId: u.projectId, held: true, revision: 1 } });
    return foreignTarget(u);
  }],
  // "042" is a path number the Grounding merge contract rejects.
  ["provisioned", async () => ({ taskId: f.taskId, owner: "acme", name: repo, prPath: "042", key: null, scope: emptyScope })],
  ["guarded", async () => { const u = await unscopedTask(); return foreignTarget(u, { projectIds: new Set([u.projectId]), repos: new Set() }); }],
  ["fenced", async () => { const u = await unscopedTask(); await ownFence(u.projectId, u.ownRepo, "MERGE"); return foreignTarget(u); }],
  ["pending create", async () => {
    const u = await unscopedTask();
    const [owner, name] = u.ownRepo.split("/");
    const intent = await store.db.groundingGithubFenceIntent.create({ data: { id: randomUUID(), repo: u.ownRepo, kind: "PR_CREATE", taskId: u.taskId, state: "COMPLETED" } });
    await store.db.groundingGithubCreateOperation.create({ data: { id: intent.id, taskId: u.taskId, projectId: u.projectId, key: "key-a", actorId: ids.agent, actorUserId: ids.user, actorTeamId: ids.team, fingerprint: "0".repeat(64), request: { owner, repo: name, head: "feature", base: "main", title: "Create" }, delegateUserId: ids.user, state: "DISPATCHED" } });
    return foreignTarget(u);
  }],
  ["merge operation history", async () => {
    const u = await unscopedTask();
    await store.db.groundingOperation.create({ data: { taskId: u.taskId, key: "prior-key", actorType: "agent", actorId: ids.agent, fingerprint: "0".repeat(64), request: {}, decision: {}, state: "COMPLETED", result: {} } });
    return { ...foreignTarget(u), key: "prior-key" };
  }],
];
it.each(foreignTargets)("an agent without project access gets the legacy create and merge 403 for a %s task", async (_label, setup) => {
  const target = await setup();
  const configured = app(f.service, new GroundingGithubCreateService({ db: store.db }), target.scope);
  const unconfigured = createApp("");
  const denied = { status: 403, body: { error: "forbidden", message: "Access denied to this project" } };
  for (const [path, body] of [
    ["/api/github/pull-requests", createRequest(target.taskId, target.owner, target.name)],
    [`/api/github/pull-requests/${target.prPath}/merge`, { taskId: target.taskId, owner: target.owner, repo: target.name }],
  ] as const) {
    const answer = async (a: ReturnType<typeof createApp>) => { const r = await a.fetch(request(body, path, target.key, foreign.token)); return { status: r.status, body: await r.json() }; };
    expect(await answer(configured)).toEqual(denied);
    expect(await answer(unconfigured)).toEqual(denied);
  }
  expect(globalThis.fetch).not.toHaveBeenCalled(); expect(f.merge).not.toHaveBeenCalled();
});
it.each(foreignTargets.filter(([label]) => ["unprovisioned unscoped", "held", "provisioned", "guarded", "fenced"].includes(label)))("an agent without project access gets one 403 from every completion route for a %s task", async (_label, setup) => {
  const target = await setup();
  const a = app(f.service, undefined, target.scope);
  for (const [endpoint, body] of [["finish", { autoMerge: true }], ["merge", {}], ["abandon", {}]] as const) {
    const result = await a.fetch(request(body, `/api/tasks/${target.taskId}/${endpoint}`, null, foreign.token));
    expect({ status: result.status, body: await result.json() }).toEqual({ status: 403, body: { error: "forbidden" } });
  }
  expect(globalThis.fetch).not.toHaveBeenCalled(); expect(f.merge).not.toHaveBeenCalled();
});
it("a create or merge naming a task that does not exist gets the legacy handlers' own 404", async () => {
  const missing = randomUUID();
  const notFound = { status: 404, body: { error: "not_found", message: "Task not found" } };
  const create = await sameAsUnconfigured(target => target.fetch(request(createRequest(missing, "acme", repo), "/api/github/pull-requests", null)));
  expect(create.configured).toEqual(notFound); expect(create.unconfigured).toEqual(notFound);
  const merge = await sameAsUnconfigured(target => target.fetch(request({ taskId: missing, owner: "acme", repo }, "/api/github/pull-requests/42/merge", null)));
  expect(merge.configured).toEqual(notFound); expect(merge.unconfigured).toEqual(notFound);
  expect([...create.configuredCalls, ...merge.configuredCalls]).toEqual([]);
});

// The legacy merger reads the path number with parseInt, so a path that is
// not a canonical number can still name a guarded PR.
it("a github merge whose path number parseInt reads as a protected peer's PR is guarded", async () => {
  const peer = await protectedPeerElsewhere();
  const u = await unscopedAt(peer.peerRepo, null);
  const [owner, name] = peer.peerRepo.split("/");
  const a = app(f.service, undefined, emptyScope);
  for (const path of ["7x", "7.0", "07"]) {
    await expectEnrollmentRequired(await a.fetch(request({ taskId: u.taskId, owner, repo: name }, `/api/github/pull-requests/${path}/merge`, null)));
  }
});
// The legacy merger never sends the body owner/repo to GitHub, so even a
// body repo that is not a canonical identity leaves the request unguarded.
it("a github merge whose body repo repeats the owner reaches the legacy merger unchanged", async () => {
  const u = await unscopedTask();
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "done" } });
  const [owner] = u.ownRepo.split("/");
  const result = await sameAsUnconfigured(target => target.fetch(request({ taskId: u.taskId, owner, repo: u.ownRepo }, "/api/github/pull-requests/99/merge", null)));
  expect(result.configured).toEqual(result.unconfigured);
  expect(result.configured).toMatchObject({ status: 502, body: { error: "github_error" } });
  expect(result.configuredCalls).toEqual([`https://api.github.com/repos/${u.ownRepo}/pulls/99/merge`]);
  expect(result.unconfiguredCalls).toEqual(result.configuredCalls);
});

// A peer-class task whose own repository string is not canonical cannot be
// matched by repository, so any candidate PR number it shares is guarded.
// Each test uses its own PR number: this check is not scoped to a repository.
const uniquePr = () => 100000 + Math.floor(Math.random() * 900000);
async function heldPeer(data: { githubRepo: string; prNumber: number | null; prUrl: string | null }) {
  const g = await completionFixture(store);
  await store.db.groundingBinding.delete({ where: { taskId: g.taskId } });
  await store.db.groundingCohort.delete({ where: { taskId: g.taskId } });
  await store.db.project.update({ where: { id: g.projectId }, data: { githubRepo: data.githubRepo } });
  await store.db.task.update({ where: { id: g.taskId }, data: { status: "review", prNumber: data.prNumber, prUrl: data.prUrl } });
  await store.db.groundingMigrationState.create({ data: { taskId: g.taskId, projectId: g.projectId, held: true, revision: 1 } });
}
const canonicalRepo = () => `acme/r${randomUUID().replaceAll("-", "")}`;
const aliasOf = (canonical: string) => { const [owner, name] = canonical.split("/"); return `${owner}/${percentAlias(name!)}`; };
it("a held peer whose project repository is a percent-encoded alias guards the PR number it shares", async () => {
  const canonical = canonicalRepo(); const pr = uniquePr();
  await heldPeer({ githubRepo: aliasOf(canonical), prNumber: pr, prUrl: null });
  const u = await unscopedAt(canonical, null);
  const [owner, name] = canonical.split("/");
  const a = app(f.service, undefined, emptyScope);
  await expectEnrollmentRequired(await a.fetch(request({ taskId: u.taskId, owner, repo: name }, `/api/github/pull-requests/${pr}/merge`, null)));
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "review", prNumber: pr } });
  await expectEnrollmentRequired(await a.fetch(request({}, `/api/tasks/${u.taskId}/merge`, null)));
});
it("a held peer whose PR URL names a percent-encoded alias guards that URL's PR number", async () => {
  const canonical = canonicalRepo(); const pr = uniquePr();
  await heldPeer({ githubRepo: canonicalRepo(), prNumber: null, prUrl: `https://github.com/${aliasOf(canonical)}/pull/${pr}` });
  const u = await unscopedAt(canonical, null);
  const [owner, name] = canonical.split("/");
  await expectEnrollmentRequired(await app(f.service, undefined, emptyScope).fetch(request({ taskId: u.taskId, owner, repo: name }, `/api/github/pull-requests/${pr}/merge`, null)));
});
it("an unenrolled task whose repository is a percent-encoded alias does not guard a shared PR number", async () => {
  const canonical = canonicalRepo(); const pr = uniquePr();
  await unscopedAt(aliasOf(canonical), pr, "review");
  const u = await unscopedAt(canonical, null);
  const [owner, name] = canonical.split("/");
  const result = await app(f.service, undefined, emptyScope).fetch(request({ taskId: u.taskId, owner, repo: name }, `/api/github/pull-requests/${pr}/merge`, null));
  expect(result.status).toBe(502); expect(await result.json()).toMatchObject({ error: "github_error" });
  expect(fetchCalls()).toEqual([`https://api.github.com/repos/${canonical}/pulls/${pr}/merge`]);
});

it("a failed reservation whose same-key operation is reserved but not dispatched still answers 503", async () => {
  await f.evidence("merge");
  const reserve = f.service.reserveMerge.bind(f.service);
  vi.spyOn(f.service, "reserveMerge").mockImplementationOnce(async (...args: Parameters<typeof reserve>) => {
    await reserve(...args);
    throw new GroundingReceiptVerificationError("grounding_verification_unavailable");
  });
  const result = await app().fetch(request(mergeBody()));
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ error: "grounding_verification_unavailable", message: "Retry with the same Idempotency-Key and unchanged request to resolve the durable operation." });
  expect((await store.db.groundingGithubMergeGroup.findFirst({ where: { seedTaskId: f.taskId } }))?.state).toBe("RESERVED");
  expect(f.merge).not.toHaveBeenCalled();
});
it("a local finish in a repository whose fence another operation owns still reaches the legacy handler", async () => {
  // An unclaimed task makes the legacy finish refuse without a write.
  const u = await unscopedTask();
  await store.db.task.update({ where: { id: u.taskId }, data: { claimedByAgentId: null } });
  await ownFence(u.projectId, u.ownRepo, "MERGE");
  const result = await sameAsUnconfigured(target => target.fetch(request({ result: "done" }, `/api/tasks/${u.taskId}/finish`, null)));
  expect(result.configured).toEqual(result.unconfigured);
  expect(result.configured.status).toBe(403);
  expect(result.configured.body).not.toMatchObject({ error: expect.stringMatching(/^grounding_/) });
});
