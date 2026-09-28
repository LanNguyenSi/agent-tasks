import { createHash, createHmac, randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
const harness = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get: (_target, property) => { const value = Reflect.get(harness.db!, property); return typeof value === "function" ? value.bind(harness.db) : value; } }) }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("../../src/services/confidence-telemetry.js", () => ({ recordBounceBack: vi.fn(), recordTerminalSnapshot: vi.fn() }));
import { createApp } from "../../src/app.js";
import { GroundingGithubMergeService } from "../../src/services/grounding-github-merge.js";
import { GroundingFinalizationService } from "../../src/services/grounding-finalization.js";
import { GroundingGithubCreateService } from "../../src/services/grounding-github-create.js";
import { githubCreateCorrelationMarker, type GroundingGithubCreateProvider } from "../../src/services/grounding-github-create-provider.js";
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import type { GroundingEnforcedScope } from "../../src/services/grounding-scope.js";
import { completionFixture, completionStore, completionActor } from "../helpers/grounding-completion-fixtures.js";
import { ids, session } from "../helpers/grounding-fixtures.js";
import * as audit from "../../src/services/audit.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
let repo: string;
const token = "configured-github-route-test";
const actor = { ...completionActor, scopes: [...completionActor.scopes, "github:pr_create"] };
beforeAll(async () => { store = await completionStore(); harness.db = store.db; }, 60000);
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
const app = (service = f.service, githubCreate?: GroundingGithubCreateService, scope: GroundingEnforcedScope = defaultScope()) => createApp("", f.attempts, { db: store.db, service, githubCreate, scope });
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
  expect(responses.every(r => [200, 202].includes(r.status))).toBe(true);
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
  const a = kind === "attempts-only" ? createApp("", f.attempts) : createApp("", f.attempts, kind === "base-only" ? { db: store.db, service: base, scope: defaultScope() } : { db: store.db });
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
it("an unscoped task whose repo equals an enforced project's repo still rejects on all three paths", async () => {
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: `acme/${repo}` } });
  await store.db.task.update({ where: { id: u.taskId }, data: { prNumber: 55, prUrl: `https://github.com/acme/${repo}/pull/55` } });
  const a = app();
  const before = await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } });
  const mergeResult = await a.fetch(request({ taskId: u.taskId, owner: "acme", repo }, "/api/github/pull-requests/55/merge", null));
  expect(mergeResult.status).toBe(409); expect(await mergeResult.json()).toEqual({ error: "grounding_enrollment_required" });
  const taskMergeResult = await a.fetch(request({}, `/api/tasks/${u.taskId}/merge`, null));
  expect(taskMergeResult.status).toBe(409); expect(await taskMergeResult.json()).toEqual({ error: "grounding_enrollment_required" });
  const finishResult = await a.fetch(request({ autoMerge: true }, `/api/tasks/${u.taskId}/finish`, null));
  expect(finishResult.status).toBe(409); expect(await finishResult.json()).toEqual({ error: "grounding_enrollment_required" });
  expect(await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } })).toEqual(before);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("an unscoped task sharing a PR with a protected peer still rejects on all three paths", async () => {
  const peer = await protectedPeerElsewhere();
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: peer.peerRepo } });
  await store.db.task.update({ where: { id: u.taskId }, data: { prNumber: peer.prNumber, prUrl: `https://github.com/${peer.peerRepo}/pull/${peer.prNumber}` } });
  const a = app(f.service, undefined, emptyScope);
  const before = await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } });
  const mergeResult = await a.fetch(request({ taskId: u.taskId, owner: peer.peerRepo.split("/")[0]!, repo: peer.peerRepo.split("/")[1]! }, `/api/github/pull-requests/${peer.prNumber}/merge`, null));
  expect(mergeResult.status).toBe(409); expect(await mergeResult.json()).toEqual({ error: "grounding_enrollment_required" });
  const taskMergeResult = await a.fetch(request({}, `/api/tasks/${u.taskId}/merge`, null));
  expect(taskMergeResult.status).toBe(409); expect(await taskMergeResult.json()).toEqual({ error: "grounding_enrollment_required" });
  const finishResult = await a.fetch(request({ autoMerge: true }, `/api/tasks/${u.taskId}/finish`, null));
  expect(finishResult.status).toBe(409); expect(await finishResult.json()).toEqual({ error: "grounding_enrollment_required" });
  expect(await store.db.task.findUniqueOrThrow({ where: { id: u.taskId } })).toEqual(before);
  expect(globalThis.fetch).not.toHaveBeenCalled();
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
async function expectEnrollmentRequired(response: Response) {
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "grounding_enrollment_required" });
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
it("a task whose only repository is its PR URL's is guarded when that repository is enforced", async () => {
  const u = await unscopedTask();
  await store.db.project.update({ where: { id: u.projectId }, data: { githubRepo: null } });
  await store.db.task.update({ where: { id: u.taskId }, data: { status: "done", deliverableRepo: null, prNumber: 55, prUrl: `https://github.com/acme/${repo}/pull/55` } });
  await expectEnrollmentRequired(await app().fetch(request({}, `/api/tasks/${u.taskId}/merge`, null)));
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
it("a keyed create for an unscoped task reaches the legacy creator with the header key in its body", async () => {
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
it("a keyed create with durable create history keeps using the grouped create service", async () => {
  const u = await unscopedTask();
  const [owner, name] = u.ownRepo.split("/");
  const a = app(f.service, new GroundingGithubCreateService({ db: store.db }), emptyScope);
  const body = { taskId: u.taskId, owner, repo: name, head: "feature", title: "Create" };
  const intent = await store.db.groundingGithubFenceIntent.create({ data: { id: randomUUID(), repo: u.ownRepo, kind: "PR_CREATE", taskId: u.taskId, state: "COMPLETED" } });
  await store.db.groundingGithubCreateOperation.create({ data: { id: intent.id, taskId: u.taskId, projectId: u.projectId, key: "mcp-generated-key", actorId: ids.agent, actorUserId: ids.user, actorTeamId: ids.team, fingerprint: "0".repeat(64), request: { owner, repo: name, head: "feature", base: "main", title: "Create" }, delegateUserId: ids.user, state: "COMPLETED" } });
  const result = await a.fetch(request(body, "/api/github/pull-requests", "mcp-generated-key"));
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
  const result = await createApp("", attempts, { db: store.db, service, scope: defaultScope() }).fetch(request(mergeBody())); expect(result.status).toBe(200); expect(f.merge).toHaveBeenCalledOnce();
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
