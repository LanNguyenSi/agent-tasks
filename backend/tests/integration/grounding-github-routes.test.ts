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
const app = (service = f.service, githubCreate?: GroundingGithubCreateService) => createApp("", f.attempts, { db: store.db, service, githubCreate });
function request(body: unknown = {}, path = "/api/github/pull-requests/42/merge", key: string | null = "route-operation", auth: string | null = token) {
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(key === null ? {} : { "Idempotency-Key": key }), ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }) }, body: JSON.stringify(body) });
}
const mergeBody = () => ({ taskId: f.taskId, owner: "acme", repo });
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
  const a = kind === "attempts-only" ? createApp("", f.attempts) : createApp("", f.attempts, { db: store.db, ...(kind === "base-only" ? { service: base } : {}) });
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
  const result = await createApp("", attempts, { db: store.db, service }).fetch(request(mergeBody())); expect(result.status).toBe(200); expect(f.merge).toHaveBeenCalledOnce();
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
