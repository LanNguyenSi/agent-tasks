import { createHash, createHmac, randomUUID } from "node:crypto";
import { type PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { completionStore, completionFixture, completionActor as actor } from "../helpers/grounding-completion-fixtures.js";
import { githubGroupFixture } from "../helpers/grounding-github-fixtures.js";
import { barrier } from "../helpers/grounding-postgres.js";
import { ids, session } from "../helpers/grounding-fixtures.js";
import { GroundingMigrationService } from "../../src/services/grounding-migration.js";
import { selectGroundingRouteContext } from "../../src/services/grounding-route-context.js";
import { GroundingGithubWebhookService } from "../../src/services/grounding-github-webhook.js";
import { acquireGithubFence, assertGithubFenceInstalled } from "../../src/services/grounding-github-fence.js";
import { computeGroundingMigrationReport } from "../../src/scripts/grounding-migration-report.js";
import { createGroundingDirectTaskRouter } from "../../src/routes/grounding-direct-tasks.js";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";

const harness = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get: (_target, property) => { const value = Reflect.get(harness.db!, property); return typeof value === "function" ? value.bind(harness.db) : value; } }) }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
import { createApp } from "../../src/app.js";
import { createSessionToken } from "../../src/services/session.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
const admin = { type: "human" as const, userId: ids.user };
const hold = { action: "hold" as const, key: "hold", expectedRevision: 0, reason: "Investigate" };
const migration = (db = store.db) => new GroundingMigrationService({ db, config: { audience: "consumer.test", trust: () => f.issuer.trust }, legacyClient: f.ledger });
beforeAll(async () => { store = await completionStore(); harness.db = store.db; }, 60000);
afterAll(async () => { await store?.close(); });
beforeEach(async () => { vi.stubEnv("REDIS_URL", ""); f = await completionFixture(store); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(["UNPROVISIONED", "EXTERNAL_V1", "LEGACY_LOCAL", "OFF", "MALFORMED"])("held %s blocks selection before fallback or validation, without trust", async mode => {
  let taskId: string = f.taskId;
  if (mode === "UNPROVISIONED") taskId = (await store.db.task.create({ data: { projectId: f.projectId, title: "Historical" } })).id;
  if (mode === "LEGACY_LOCAL" || mode === "OFF") { f = await completionFixture(store, mode); taskId = f.taskId; }
  if (mode === "MALFORMED") await store.db.groundingCohort.update({ where: { taskId }, data: { provenance: "bad provenance" } });
  f.issuer.trust = [];
  await migration().execute(taskId, admin, hold);
  await expect(selectGroundingRouteContext(store.db, { taskId, projectId: f.projectId })).rejects.toMatchObject({ code: "grounding_task_held" });
  const report = await computeGroundingMigrationReport(store.db, f.projectId);
  expect(report.totals.held).toBe(1); expect(report.totals.recommendedActions.HELD_REQUIRES_AUTHORIZED_READINESS_REVIEW).toBe(1);
});

it("rejects evidence use and overrides before any remote read or side effect, then needs fresh evidence", async () => {
  const { challenge, receipt } = await f.evidence();
  await migration().execute(f.taskId, admin, hold);
  const before = await f.snapshot(); f.headProvider.mockClear();
  await expect(f.service.complete(f.taskId, admin, "override", { action: "finish", overrideReason: "Admin override" })).rejects.toMatchObject({ code: "grounding_task_held" });
  await expect(f.service.reserveMerge(f.taskId, actor, "merge")).rejects.toMatchObject({ code: "grounding_task_held" });
  await expect(f.attempts.issue(f.taskId, actor, "finish")).rejects.toMatchObject({ code: "grounding_task_held" });
  await expect(f.attempts.ingest(f.taskId, challenge.attemptId, actor, session, receipt)).rejects.toMatchObject({ code: "grounding_task_held" });
  expect(f.headProvider).not.toHaveBeenCalled(); expect(f.merge).not.toHaveBeenCalled(); expect(f.deliverSignal).not.toHaveBeenCalled(); expect(await f.snapshot()).toEqual(before);
  await migration().execute(f.taskId, admin, { action: "resume", key: "resume", expectedRevision: 1, reason: "Compatible consumer" });
  await expect(f.attempts.ingest(f.taskId, challenge.attemptId, actor, session, receipt)).rejects.toMatchObject({ code: "grounding_receipt_stale" });
  await expect(f.service.complete(f.taskId, actor, "fresh", { action: "finish" })).rejects.toMatchObject({ code: "grounding_required" });
  await f.evidence(); expect(await f.service.complete(f.taskId, actor, "fresh", { action: "finish" })).toMatchObject({ status: "review" });
});

it("direct force transition rejects a held unprovisioned task", async () => {
  const task = await store.db.task.create({ data: { projectId: f.projectId, title: "Historical", status: "in_progress" } });
  await migration().execute(task.id, admin, hold);
  const app = new Hono<{ Variables: AppVariables }>(); app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
  app.route("/api", createGroundingDirectTaskRouter({ db: store.db, service: f.service, scope: { projectIds: new Set([f.projectId]), repos: new Set<string>() } }));
  const response = await app.request(`/api/tasks/${task.id}/transition`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "force" }, body: JSON.stringify({ toStatus: "done", force: true, reason: "Admin request" }) });
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "grounding_task_held" });
  expect(await store.db.task.findUnique({ where: { id: task.id } })).toEqual(task);
});

it("database freeze blocks task updates including no-op, deletes, and internal GitHub token claims", async () => {
  await migration().execute(f.taskId, admin, hold);
  for (const statement of ['UPDATE tasks SET title = title WHERE id = $1', 'UPDATE tasks SET "updatedAt" = "updatedAt" WHERE id = $1', "UPDATE tasks SET status = 'done' WHERE id = $1", 'DELETE FROM tasks WHERE id = $1']) await expect(store.db.$executeRawUnsafe(statement, f.taskId)).rejects.toThrow(/grounding_task_held/);
  await expect(store.db.$transaction(async tx => { await tx.$executeRawUnsafe("SELECT set_config('grounding.github_owner', 'forged', true)"); await tx.task.update({ where: { id: f.taskId }, data: { title: "bypass" } }); })).rejects.toThrow(/grounding_task_held/);
});

it.each(["Serializable", "RepeatableRead"] as const)("hold row-version touch rejects a stale %s task write", async isolationLevel => {
  const gate = barrier();
  const write = store.connect().$transaction(async tx => {
    await tx.task.findUniqueOrThrow({ where: { id: f.taskId } }); await gate.wait();
    await tx.$executeRaw`UPDATE tasks SET "updatedAt" = "updatedAt" WHERE id = ${f.taskId}`;
  }, { isolationLevel, timeout: 15000 }).then(() => "incorrectly committed", error => String(error));
  await gate.reached;
  try { await migration().execute(f.taskId, admin, hold); } finally { gate.release(); }
  expect(await write).toMatch(/write conflict|40001|serialize/i);
  expect((await f.task()).status).toBe("in_progress");
});

it("already-waiting READ COMMITTED update observes committed hold", async () => {
  const gate = barrier();
  const client = store.connect().$extends({ query: { auditLog: { async create({ args, query }) { const row = await query(args); await gate.wait(); return row; } } } });
  const held = migration(client as unknown as PrismaClient).execute(f.taskId, admin, hold);
  await gate.reached;
  const writer = store.connect();
  let pid = 0;
  const write = writer.$transaction(async tx => {
    const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; pid = row.pid;
    await tx.$executeRaw`UPDATE tasks SET "updatedAt" = "updatedAt" WHERE id = ${f.taskId}`;
  }, { isolationLevel: "ReadCommitted", timeout: 15000 }).then(() => "incorrectly committed", error => String(error));
  // Poll the server's lock graph to establish the ordering, not elapsed time.
  let waiting = false;
  try {
    for (let count = 0; count < 200 && !waiting; count++) {
      const [row] = await store.db.$queryRaw<{ blocked: boolean }[]>`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`;
      waiting = row.blocked;
    }
    expect(waiting).toBe(true);
  } finally { gate.release(); }
  await held; expect(await write).toMatch(/grounding_task_held/);
});

it("held unprovisioned peer and seed block a grouped merge before remote effects", async () => {
  const group = await githubGroupFixture(store);
  const peer = await store.db.task.create({ data: { projectId: group.peer.projectId, title: "Unprovisioned peer", prNumber: 42, prUrl: `https://github.com/${group.repo}/pull/42` } });
  await migration().execute(peer.id, admin, hold); await group.evidence();
  await expect(group.reserve()).rejects.toMatchObject({ code: "grounding_task_held" });
  expect(group.seed.merge).not.toHaveBeenCalled(); expect((await group.snapshot()).group).toBeNull();
  const seed = await store.db.task.create({ data: { projectId: f.projectId, title: "Unprovisioned seed", status: "review", prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42" } });
  await migration().execute(seed.id, admin, hold);
  await expect(group.service.protectedMergeParticipants(seed.id, actor)).rejects.toMatchObject({ code: "grounding_task_held" });
  await expect(group.service.reserveMerge(seed.id, actor, "held-seed")).rejects.toMatchObject({ code: "grounding_task_held" });
});

it("existing group fence excludes holding an unprovisioned peer, and taskless repo PR-create intent excludes hold", async () => {
  const group = await githubGroupFixture(store);
  const peer = await store.db.task.create({ data: { projectId: group.peer.projectId, title: "Unprovisioned peer", prNumber: 42, prUrl: `https://github.com/${group.repo}/pull/42` } });
  await group.evidence(); await group.reserve();
  await expect(migration().execute(peer.id, admin, hold)).rejects.toBeInstanceOf(Error);
  expect(await store.db.groundingMigrationState.findUnique({ where: { taskId: peer.id } })).toBeNull();
  // Test the overlay trigger directly too, independently of service enrollment.
  await expect(store.db.groundingMigrationState.create({ data: { taskId: peer.id, projectId: peer.projectId, held: true, revision: 1 } })).rejects.toThrow(/grounding_github_fence_conflict/);
  const project = await store.db.project.create({ data: { teamId: ids.team, name: "No repo", slug: randomUUID() } });
  const task = await store.db.task.create({ data: { projectId: project.id, title: "No repo" } });
  await store.db.$transaction(tx => acquireGithubFence(tx, { id: randomUUID(), kind: "PR_CREATE", repo: `acme/${randomUUID()}`, taskId: task.id }));
  await expect(migration().execute(task.id, admin, hold)).rejects.toMatchObject({ code: "grounding_operation_conflict" });
});

it.each(["pr_merged", "pr_opened", "pr_reopened", "review_changes_requested", "issue_closed", "issue_reopened"])("held unprovisioned webhook %s remains pending without task mutations", async kind => {
  const issue = kind.startsWith("issue_");
  const task = await store.db.task.create({ data: { projectId: f.projectId, title: issue ? "[GH #42] Historical" : "Historical", status: "review", prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42" } });
  await migration().execute(task.id, admin, hold);
  const event = issue ? "issues" : kind.startsWith("review") ? "pull_request_review" : "pull_request";
  const action = kind === "pr_merged" ? "closed" : kind.startsWith("review") ? "submitted" : kind.split("_")[1];
  const rawBody = JSON.stringify({ action, repository: { full_name: "acme/repo" }, ...(issue ? { issue: { number: 42, title: "Historical", body: null, html_url: "https://github.com/acme/repo/issues/42", state: action === "closed" ? "closed" : "open" } } : { pull_request: { number: 42, title: "PR", html_url: "https://github.com/acme/repo/pull/42", state: "closed", merged: kind === "pr_merged", head: { ref: "branch", sha: "a".repeat(40) } }, review: { state: "changes_requested", user: { login: "reviewer" }, html_url: "https://github.com/acme/repo/pull/42" } }) });
  const input = { deliveryId: randomUUID(), event, rawBody };
  const webhook = new GroundingGithubWebhookService(store.db); await webhook.handle(input);
  expect(await store.db.task.findUnique({ where: { id: task.id } })).toEqual(task);
  expect(await store.db.groundingGithubObservation.findFirst({ where: { taskId: task.id } })).toMatchObject({ state: "PENDING", reason: "grounding_task_held" });
  expect(await webhook.handle(input)).toMatchObject({ duplicate: true });
});

it("installation check rejects disabled hold and overlay guards", async () => {
  for (const [table, trigger] of [["tasks", "grounding_hold_task_fence"], ["grounding_migration_states", "grounding_github_migration_fence"]]) {
    await store.db.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    try { await expect(assertGithubFenceInstalled(store.db)).rejects.toThrow(/not installed/); }
    finally { await store.db.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); }
  }
});


it("migration-only app composition selects guarded remote and pending webhook paths", async () => {
  const task = await store.db.task.create({ data: { projectId: f.projectId, title: "Historical", status: "review", prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42" } });
  const token = await createSessionToken(ids.user, "test-secret-which-is-long-enough-1234");
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "migration-test-secret");
  const remote = vi.fn().mockRejectedValue(new Error("unexpected remote effect")); vi.stubGlobal("fetch", remote);
  const app = createApp("", undefined, undefined, migration());
  const result = await app.request(`/api/tasks/${task.id}/grounding-migration`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(hold) });
  expect(result.status).toBe(200);
  const agentToken = "migration-composition-agent";
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { tokenHash: createHash("sha256").update(agentToken).digest("hex") } });
  const mergeRequest = () => new Request("http://test/api/github/pull-requests/42/merge", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}`, "Idempotency-Key": "merge" }, body: JSON.stringify({ taskId: task.id, owner: "acme", repo: "repo" }) });
  const response = await app.fetch(mergeRequest());
  // The caller passes real agent authorization, but migration-only composition
  // has no completion service and must fail closed before the legacy remote path.
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: "grounding_verification_unavailable" }); expect(remote).not.toHaveBeenCalled();

  const rawBody = JSON.stringify({ action: "closed", repository: { full_name: "acme/repo" }, pull_request: { number: 42, title: "PR", html_url: "https://github.com/acme/repo/pull/42", state: "closed", merged: true } });
  const webhook = await app.request("/api/webhooks/github", { method: "POST", headers: { "content-type": "application/json", "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": randomUUID(), "X-Hub-Signature-256": `sha256=${createHmac("sha256", "migration-test-secret").update(rawBody).digest("hex")}` }, body: rawBody });
  expect(webhook.status).toBe(200);
  expect(await store.db.groundingGithubObservation.findFirst({ where: { taskId: task.id } })).toMatchObject({ state: "PENDING", reason: "grounding_task_held" });
  expect(await store.db.task.findUnique({ where: { id: task.id } })).toEqual(task);
});
