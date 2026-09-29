import { createHash, randomUUID } from "node:crypto";
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
import { createGroundingRemoteTargetGuard, type GroundingEnforcedScope } from "../../src/services/grounding-scope.js";
import { completionFixture, completionStore, completionActor } from "../helpers/grounding-completion-fixtures.js";
import { ids } from "../helpers/grounding-fixtures.js";

/**
 * Grounded merge of a task whose binding attests the task specification
 * (TASK_SPEC) rather than a code head, with the PR linked through the grounded
 * create route. That route stores the canonical (lowercased) PR URL while the
 * project keeps its mixed-case repository name.
 */
let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
let owner: string; let name: string;
const token = "configured-task-spec-merge-test";
const actor = { ...completionActor, scopes: [...completionActor.scopes, "github:pr_create"] };
beforeAll(async () => { store = await completionStore(); harness.db = store.db; }, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => {
  vi.stubEnv("REDIS_URL", "");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("external HTTP disabled")));
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { tokenHash: createHash("sha256").update(token).digest("hex"), scopes: actor.scopes, revokedAt: null } });
  f = await completionFixture(store, "EXTERNAL_V1", deps => new GroundingGithubMergeService(deps));
  owner = "Acme"; name = `Spec_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await store.db.project.update({ where: { id: f.projectId }, data: { githubRepo: `${owner}/${name}` } });
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "in_progress", prUrl: null, prNumber: null, branchName: null } });
  await store.db.groundingBinding.delete({ where: { taskId: f.taskId } });
  await f.attempts.provision({ taskId: f.taskId, projectId: f.projectId, subjectMode: "TASK_SPEC" });
  f.proof.repo = `${owner}/${name}`;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const scope = (): GroundingEnforcedScope => ({ projectIds: new Set([f.projectId]), repos: new Set([`${owner}/${name}`.toLowerCase()]) });
function send(path: string, body: unknown, key: string) {
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}
function createService() {
  const lower = `${owner}/${name}`.toLowerCase();
  const raw = { number: 42, html_url: `https://github.com/${lower}/pull/42`, title: "Spec PR", head: { label: `${owner.toLowerCase()}:spec`, ref: "spec", sha: f.head, repo: { full_name: lower, owner: { login: owner.toLowerCase() } } }, base: { ref: "main", repo: { full_name: lower } } };
  const proof = (operationId: string) => ({ ...structuredClone(raw), body: `\n\n${githubCreateCorrelationMarker(operationId)}` });
  const create = vi.fn<GroundingGithubCreateProvider["create"]>(async (_request, _token, operationId) => proof(operationId));
  const read = vi.fn<GroundingGithubCreateProvider["read"]>(async (_request, _token, operationId) => ({ complete: true, pullRequests: [proof(operationId)] }));
  return new GroundingGithubCreateService({ db: store.db, provider: { create, read } });
}
const app = () => createApp("", f.attempts, { db: store.db, service: f.service, githubCreate: createService(), scope: scope(), remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope: scope() }) });

/** Grounded create, grounded finish, merge attempt: the state the merge route then acts on. */
async function toReview(a = app()) {
  const created = await a.fetch(send("/api/github/pull-requests", { taskId: f.taskId, owner, repo: name, head: "spec", base: "main", title: "Spec PR" }, "create"));
  expect(created.status).toBe(201);
  const stored = await f.task();
  expect(stored.prUrl).toBe(`https://github.com/${`${owner}/${name}`.toLowerCase()}/pull/42`);
  expect(stored.prNumber).toBe(42);
  await f.evidence("finish");
  const finished = await a.fetch(send(`/api/tasks/${f.taskId}/finish`, {}, "finish"));
  expect(finished.status).toBe(200);
  expect((await f.task()).status).toBe("review");
  await f.evidence("merge");
  return a;
}

it("TASK_SPEC grounded create, finish and merge completes the task and merges at the head observed at reservation", async () => {
  const a = await toReview();
  const context = JSON.parse((await store.db.groundingAttempt.findFirstOrThrow({ where: { taskId: f.taskId, state: "ACTIVE" } })).contextBytes.toString("utf8"));
  expect(context.protection.subjectMode).toBe("TASK_SPEC");
  expect(context.deliverable.headSha).toBeNull();
  const result = await a.fetch(send(`/api/tasks/${f.taskId}/merge`, {}, "merge"));
  const body = await result.json();
  expect({ status: result.status, body }).toMatchObject({ status: 200, body: { merged: true, sha: "b".repeat(40) } });
  expect((await f.task()).status).toBe("done");
  expect(f.merge).toHaveBeenCalledExactlyOnceWith({ repo: `${owner}/${name}`, prNumber: 42, headSha: f.head, method: "squash" }, "test-only");
  const group = await store.db.groundingGithubMergeGroup.findFirstOrThrow({ where: { seedTaskId: f.taskId } });
  expect(group.headSha).toBe(f.head);
  const operation = await store.db.groundingOperation.findFirstOrThrow({ where: { taskId: f.taskId, key: "merge" } });
  expect(operation.headSha).toBe(f.head);
});

it.each([
  ["project-case URL of the bound PR", (repo: string) => `https://github.com/${repo}/pull/42`, 200],
  ["URL of another PR number", (repo: string) => `https://github.com/${repo}/pull/43`, 409],
  ["URL of another repository", (repo: string) => `https://github.com/${repo}x/pull/42`, 409],
] as const)("grounded finish carrying the %s answers %d", async (_case, prUrl, status) => {
  const a = app();
  expect((await a.fetch(send("/api/github/pull-requests", { taskId: f.taskId, owner, repo: name, head: "spec", base: "main", title: "Spec PR" }, "create"))).status).toBe(201);
  await f.evidence("finish");
  const finished = await a.fetch(send(`/api/tasks/${f.taskId}/finish`, { prUrl: prUrl(`${owner}/${name}`), prNumber: 42 }, "finish"));
  expect(finished.status).toBe(status);
  expect((await f.task()).status).toBe(status === 200 ? "review" : "in_progress");
});

it("TASK_SPEC merge is refused without any remote write when the PR head changes between reservation and merge", async () => {
  await toReview();
  await f.service.reserveMerge(f.taskId, actor, "merge", { action: "merge", method: "squash", route: { kind: "task_merge", transport: { endpoint: "merge", body: { mergeMethod: "squash" } } } });
  const group = await store.db.groundingGithubMergeGroup.findFirstOrThrow({ where: { seedTaskId: f.taskId } });
  expect(group.headSha).toBe(f.head);
  f.head = "c".repeat(40); f.proof = { ...f.proof, headSha: f.head };
  await expect(f.service.dispatchMerge(f.taskId, actor, "merge")).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
  expect(f.merge).not.toHaveBeenCalled();
  expect((await f.task()).status).toBe("review");
});

it("TASK_SPEC merge is refused when the signed context carries a code head the binding does not attest", async () => {
  await toReview();
  const attempt = await store.db.groundingAttempt.findFirstOrThrow({ where: { taskId: f.taskId, state: "ACTIVE" } });
  const context = JSON.parse(attempt.contextBytes.toString("utf8"));
  context.deliverable.headSha = f.head;
  await store.db.groundingAttempt.update({ where: { id: attempt.id }, data: { contextBytes: Buffer.from(JSON.stringify(context), "utf8") } });
  const result = await app().fetch(send(`/api/tasks/${f.taskId}/merge`, {}, "merge"));
  expect(result.status).toBe(409);
  expect(f.merge).not.toHaveBeenCalled();
  expect((await f.task()).status).toBe("review");
});

it("TASK_SPEC merge through the base finalization service reserves the observed head and merges with it", async () => {
  const baseService = new GroundingFinalizationService({ db: store.db, config: { audience: "consumer.test", trust: () => f.issuer.trust }, now: () => f.now, headProvider: f.headProvider, mergeProvider: { merge: f.merge, read: f.read }, deliverSignal: vi.fn(async () => {}) });
  await toReview();
  const request = { action: "merge" as const, method: "squash" as const, route: { kind: "task_merge" as const, transport: { endpoint: "merge" as const, body: { mergeMethod: "squash" } } } };
  await baseService.reserveMerge(f.taskId, actor, "base-merge", request);
  const operation = await store.db.groundingOperation.findFirstOrThrow({ where: { taskId: f.taskId, key: "base-merge" } });
  expect(operation.headSha).toBe(f.head);
  expect(await baseService.dispatchMerge(f.taskId, actor, "base-merge")).toMatchObject({ status: "done" });
  expect(f.merge).toHaveBeenCalledExactlyOnceWith({ repo: `${owner}/${name}`, prNumber: 42, headSha: f.head, method: "squash" }, "test-only");
});

it("TASK_SPEC base finalization service refuses the merge when the head moves after reservation", async () => {
  const baseService = new GroundingFinalizationService({ db: store.db, config: { audience: "consumer.test", trust: () => f.issuer.trust }, now: () => f.now, headProvider: f.headProvider, mergeProvider: { merge: f.merge, read: f.read }, deliverSignal: vi.fn(async () => {}) });
  await toReview();
  await baseService.reserveMerge(f.taskId, actor, "base-merge", { action: "merge", method: "squash", route: { kind: "task_merge", transport: { endpoint: "merge", body: { mergeMethod: "squash" } } } });
  f.head = "c".repeat(40); f.proof = { ...f.proof, headSha: f.head };
  await expect(baseService.dispatchMerge(f.taskId, actor, "base-merge")).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
  expect(f.merge).not.toHaveBeenCalled();
});

const taskMerge = { action: "merge" as const, method: "squash" as const, route: { kind: "task_merge" as const, transport: { endpoint: "merge" as const, body: { mergeMethod: "squash" } } } };
/** A CODE_HEAD task in review whose project keeps a mixed-case repository name. */
async function codeHead(factory: "base" | "group", prUrl: (repo: string) => string) {
  const c = await completionFixture(store, "EXTERNAL_V1", factory === "group" ? deps => new GroundingGithubMergeService(deps) : undefined);
  // A unique repository keeps other fixtures' protected tasks out of the merge group.
  const repo = `Acme/Code_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await store.db.project.update({ where: { id: c.projectId }, data: { githubRepo: repo } });
  await store.db.task.update({ where: { id: c.taskId }, data: { status: "review", prUrl: prUrl(repo), prNumber: 42 } });
  c.proof.repo = repo;
  return Object.assign(c, { repo });
}

it.each(["base", "group"] as const)("CODE_HEAD %s merge is still refused when the reservation observes a head other than the signed one", async factory => {
  const c = await codeHead(factory, repo => `https://github.com/${repo}/pull/42`);
  await c.evidence("merge");
  // The receipt check projects the signed head; the reservation's own read sees a new head.
  c.headProvider.mockResolvedValueOnce(c.head).mockResolvedValueOnce("c".repeat(40));
  await expect(c.service.reserveMerge(c.taskId, completionActor, "merge", taskMerge)).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
  expect(await store.db.groundingOperation.count({ where: { taskId: c.taskId } })).toBe(0);
  expect(c.merge).not.toHaveBeenCalled();
});

it.each(["base", "group"] as const)("CODE_HEAD %s merge accepts the lowercased PR URL for a mixed-case project repository", async factory => {
  const c = await codeHead(factory, repo => `https://github.com/${repo.toLowerCase()}/pull/42`);
  await c.evidence("merge");
  await c.service.reserveMerge(c.taskId, completionActor, "merge", taskMerge);
  expect(await c.service.dispatchMerge(c.taskId, completionActor, "merge")).toMatchObject({ status: "done" });
  expect(c.merge).toHaveBeenCalledExactlyOnceWith({ repo: c.repo, prNumber: 42, headSha: c.head, method: "squash" }, "test-only");
});

it.each([
  ["different repository", (repo: string) => `https://github.com/${repo.toLowerCase()}x/pull/42`],
  ["different number", (repo: string) => `https://github.com/${repo.toLowerCase()}/pull/43`],
] as const)("base merge refuses a PR URL naming a %s before any remote read", async (_case, prUrl) => {
  const c = await codeHead("base", repo => `https://github.com/${repo.toLowerCase()}/pull/42`);
  await c.evidence("merge");
  await store.db.task.update({ where: { id: c.taskId }, data: { prUrl: prUrl(c.repo) } });
  await expect(c.service.reserveMerge(c.taskId, completionActor, "merge", taskMerge)).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
  expect(await store.db.groundingOperation.count({ where: { taskId: c.taskId } })).toBe(0);
  expect(c.merge).not.toHaveBeenCalled();
});

it.each([
  ["different repository", (repo: string) => `https://github.com/${repo.toLowerCase()}x/pull/42`],
  ["different number", (repo: string) => `https://github.com/${repo.toLowerCase()}/pull/43`],
] as const)("CODE_HEAD merge attempt refuses a PR URL naming a %s", async (_case, prUrl) => {
  const c = await codeHead("base", prUrl);
  await expect(c.evidence("merge")).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
});
