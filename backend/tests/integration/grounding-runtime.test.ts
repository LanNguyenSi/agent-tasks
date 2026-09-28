import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get: (_target, property) => { const value = Reflect.get(harness.db!, property); return typeof value === "function" ? value.bind(harness.db) : value; } }) }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("../../src/services/confidence-telemetry.js", () => ({ recordBounceBack: vi.fn(), recordTerminalSnapshot: vi.fn() }));
import { createApp } from "../../src/app.js";
import { composeGroundingRuntime } from "../../src/services/grounding-runtime.js";
import { completionStore } from "../helpers/grounding-completion-fixtures.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";
import { ids, session, testIssuer } from "../helpers/grounding-fixtures.js";
import { createSessionToken } from "../../src/services/session.js";
import type { GroundingChallenge } from "../../src/services/grounding-attempts.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let projectId: string;
let issuer: ReturnType<typeof testIssuer>;
let human: string;
let repo: string;
const token = "runtime-test-agent";
const secret = "runtime-webhook-test-secret";
const workflow = {
  initialState: "open", states: [{ name: "open", label: "open", terminal: false }, { name: "in_progress", label: "in_progress", terminal: false }, { name: "review", label: "review", terminal: false }, { name: "done", label: "done", terminal: true }],
  transitions: [{ from: "open", to: "in_progress" }, { from: "in_progress", to: "review" }, { from: "review", to: "done" }],
};
const config = () => ({ enabled: true, audience: "consumer.test", trust: issuer.trust, creationPolicy: [{ projectId, subjectMode: "TASK_SPEC" }] });
async function app(db = store.db, input: unknown = config()) {
  const services = await composeGroundingRuntime(JSON.stringify(input), db);
  return createApp("", services.attempts, services.completion, services.migration);
}
function request(path: string, body: unknown, auth = token, key = "runtime-operation") {
  return new Request(`http://localhost/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}`, "Idempotency-Key": key }, body: JSON.stringify(body) });
}
function webhook(delivery = randomUUID(), signature = true) {
  const raw = JSON.stringify({ action: "opened", repository: { full_name: repo }, issue: { number: 17, title: "New issue", body: "Original description", html_url: `https://github.com/${repo}/issues/17`, state: "open" } });
  return new Request("http://localhost/api/webhooks/github", { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Delivery": delivery, "X-GitHub-Event": "issues", "X-Hub-Signature-256": signature ? `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` : "bad" }, body: raw });
}
async function snapshot() {
  return {
    tasks: await store.db.task.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
    cohorts: await store.db.groundingCohort.findMany({ where: { projectId }, orderBy: { taskId: "asc" } }),
    bindings: await store.db.groundingBinding.findMany({ where: { projectId }, orderBy: { taskId: "asc" } }),
    audits: await store.db.auditLog.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
    signals: await store.db.signal.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
    deliveries: await store.db.groundingGithubWebhookDelivery.findMany({ orderBy: { deliveryId: "asc" } }),
  };
}
beforeAll(async () => {
  store = await completionStore(); harness.db = store.db;
  human = await createSessionToken(ids.user, "test-secret-which-is-long-enough-1234");
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { tokenHash: createHash("sha256").update(token).digest("hex"), scopes: ["tasks:create", "tasks:update", "tasks:transition", "tasks:claim", "github:pr_create", "github:pr_merge"] } });
}, 60000);
afterAll(async () => { await store?.close(); });
beforeEach(async () => {
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", secret); vi.stubEnv("REDIS_URL", "");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected network request")));
  projectId = randomUUID(); repo = `acme/runtime_${projectId.replaceAll("-", "")}`;
  await store.db.project.create({ data: { id: projectId, teamId: ids.team, name: "Runtime", slug: projectId, githubRepo: repo } });
  await store.db.workflow.create({ data: { projectId, name: "Runtime workflow", isDefault: true, definition: workflow } });
  issuer = testIssuer([projectId]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("preserves empty migrated disabled startup and refuses missing grounding tables", async () => {
  const isolated = await groundingPostgres();
  try {
    expect(await composeGroundingRuntime("", isolated.db)).toEqual({});
    await isolated.db.$executeRawUnsafe("ALTER TABLE grounding_github_observations RENAME TO hidden_observations");
    await expect(composeGroundingRuntime("", isolated.db)).rejects.toThrow("Grounding runtime startup refused");
  } finally { await isolated.close(); }
}, 60000);

it.each(["off cohort", "completed delivery"])("disabled startup refuses %s without modifying it", async kind => {
  const isolated = await groundingPostgres();
  try {
    if (kind === "completed delivery") await isolated.db.groundingGithubWebhookDelivery.create({ data: { deliveryId: "history", event: "ping", fingerprint: "a".repeat(64), result: { received: true }, completedAt: new Date() } });
    if (kind === "off cohort") {
      await isolated.db.team.create({ data: { id: ids.team, name: "History", slug: "history" } });
      await isolated.db.project.create({ data: { id: ids.project, teamId: ids.team, name: "History", slug: "history" } });
      await isolated.db.task.create({ data: { id: ids.task, projectId: ids.project, title: "History" } });
      await isolated.db.groundingCohort.create({ data: { taskId: ids.task, projectId: ids.project, mode: "OFF", protected: false, provenance: "historical" } });
    }
    const before = [await isolated.db.groundingCohort.count(), await isolated.db.groundingGithubRepositoryFence.count(), await isolated.db.groundingGithubWebhookDelivery.count()];
    await expect(composeGroundingRuntime('{"enabled":false}', isolated.db)).rejects.toThrow("Grounding runtime startup refused");
    expect([await isolated.db.groundingCohort.count(), await isolated.db.groundingGithubRepositoryFence.count(), await isolated.db.groundingGithubWebhookDelivery.count()]).toEqual(before);
  } finally { await isolated.close(); }
}, 60000);

// SE-04: the repository-fence trigger fires on every ordinary GitHub-linked
// task write whether or not grounding is configured, so an unowned fence row
// (and a non-ACTIVE fence intent, its historical counterpart) is no longer
// treated as grounding history on its own; every other grounding table is
// still checked exactly as before.
it("disabled startup accepts an unowned repository fence produced by an ordinary GitHub-linked task write", async () => {
  const isolated = await groundingPostgres();
  try {
    await isolated.db.team.create({ data: { id: ids.team, name: "History", slug: "history" } });
    await isolated.db.project.create({ data: { id: ids.project, teamId: ids.team, name: "History", slug: "history", githubRepo: "acme/history" } });
    await isolated.db.task.create({ data: { id: ids.task, projectId: ids.project, title: "History" } });
    expect(await isolated.db.groundingGithubRepositoryFence.findUniqueOrThrow({ where: { repo: "acme/history" } })).toMatchObject({ ownerId: null });
    expect(await composeGroundingRuntime("", isolated.db)).toEqual({});
    await isolated.db.task.update({ where: { id: ids.task }, data: { title: "History (touched)" } });
    expect(await composeGroundingRuntime("", isolated.db)).toEqual({});
  } finally { await isolated.close(); }
}, 60000);
it.each(["owned fence", "active intent", "other table row"])("disabled startup still refuses %s despite an otherwise-exempt unowned fence", async kind => {
  const isolated = await groundingPostgres();
  try {
    await isolated.db.team.create({ data: { id: ids.team, name: "History", slug: "history" } });
    await isolated.db.project.create({ data: { id: ids.project, teamId: ids.team, name: "History", slug: "history", githubRepo: "acme/history" } });
    await isolated.db.task.create({ data: { id: ids.task, projectId: ids.project, title: "History" } });
    if (kind === "owned fence") {
      const intent = await isolated.db.groundingGithubFenceIntent.create({ data: { id: randomUUID(), repo: "acme/history", kind: "MERGE", taskId: ids.task, state: "COMPLETED" } });
      await isolated.db.groundingGithubRepositoryFence.update({ where: { repo: "acme/history" }, data: { ownerId: intent.id } });
    }
    if (kind === "active intent") await isolated.db.groundingGithubFenceIntent.create({ data: { id: randomUUID(), repo: "acme/other", kind: "PR_CREATE", taskId: ids.task, state: "ACTIVE" } });
    if (kind === "other table row") await isolated.db.groundingGithubWebhookDelivery.create({ data: { deliveryId: "history", event: "ping", fingerprint: "a".repeat(64), result: { received: true }, completedAt: new Date() } });
    await expect(composeGroundingRuntime("", isolated.db)).rejects.toThrow("Grounding runtime startup refused");
  } finally { await isolated.close(); }
}, 60000);

it.each(["unknown project", "revoked", "wrong audience", "wrong profile", "uncovered"])("enabled startup refuses %s with no persisted effects", async condition => {
  const input = config();
  if (condition === "unknown project") { const missing = randomUUID(); input.creationPolicy[0]!.projectId = missing; input.trust[0]!.projectIds = [missing]; }
  if (condition === "revoked") input.trust[0]!.revoked = true;
  if (condition === "wrong audience") input.audience = "wrong";
  if (condition === "wrong profile") input.trust[0]!.profileDigest = "0".repeat(64);
  if (condition === "uncovered") input.trust[0]!.projectIds = [randomUUID()];
  const before = await snapshot();
  await expect(app(store.db, input)).rejects.toThrow("Grounding runtime startup refused");
  expect(await snapshot()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
});

it("real app enrolls selected REST and import creation while keeping agent backlog and success rejection", async () => {
  const target = await app();
  const created = await target.request(request(`/projects/${projectId}/tasks`, { title: "Selected" }));
  expect(created.status).toBe(201);
  const { task } = await created.json() as { task: { id: string; status: string } };
  expect(task.status).toBe("backlog");
  expect(await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId: task.id } })).toMatchObject({ projectId, subjectMode: "TASK_SPEC", audience: "consumer.test" });
  const imported = await target.request(request(`/projects/${projectId}/tasks/import`, { tasks: [{ title: "Imported", externalRef: "runtime-import" }] }));
  expect(imported.status).toBe(201);
  expect(await store.db.groundingCohort.count({ where: { projectId, mode: "EXTERNAL_V1" } })).toBe(2);
  const before = await snapshot();
  expect((await target.request(request(`/projects/${projectId}/tasks`, { title: "No historical success", status: "done" }, human))).status).toBe(409);
  expect((await target.request(request(`/projects/${projectId}/tasks`, { title: "No unauthenticated write" }, "invalid"))).status).toBe(401);
  expect(await snapshot()).toEqual(before);
});

it("configured routing protects previously unprovisioned remote operations without enrolling history", async () => {
  const task = await store.db.task.create({ data: { projectId, title: "Historical", status: "review", prNumber: 42, prUrl: `https://github.com/${repo}/pull/42` } });
  const target = await app(); const before = await snapshot();
  const result = await target.request(request(`/tasks/${task.id}/merge`, {}));
  expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ error: "grounding_enrollment_required" });
  expect(await snapshot()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
});

it("enabled config with empty trust and creationPolicy behaves like legacy on all three remote paths", async () => {
  const target = await app(store.db, { enabled: true, audience: "consumer.test", trust: [], creationPolicy: [] });
  const task = await store.db.task.create({ data: { projectId, title: "Legacy equivalent", status: "in_progress", claimedByAgentId: ids.agent } });
  const finish = await target.request(request(`/tasks/${task.id}/finish`, { autoMerge: true }));
  expect(finish.status).toBe(403); expect(await finish.json()).toMatchObject({ error: "autonomous_mode_required" });
  const merge = await target.request(request(`/tasks/${task.id}/merge`, {}));
  expect(merge.status).toBe(409); expect(await merge.json()).toMatchObject({ error: "bad_state" });
  const direct = await target.request(request(`/github/pull-requests/1/merge`, { taskId: task.id, owner: "acme", repo: "irrelevant" }));
  expect(direct.status).toBe(403); expect(await direct.json()).toMatchObject({ error: "forbidden" });
  expect(fetch).not.toHaveBeenCalled();
});

it("enabled startup refuses when a project outside the enforced scope shares a repo with an enforced project", async () => {
  const other = await store.db.project.create({ data: { teamId: ids.team, name: "Shares repo", slug: randomUUID(), githubRepo: repo.toUpperCase() } });
  const before = await snapshot();
  await expect(app()).rejects.toThrow("Grounding runtime startup refused");
  expect(await snapshot()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  await store.db.project.delete({ where: { id: other.id } });
});

it("enabled startup accepts a disjoint repo on an unscoped project", async () => {
  await store.db.project.create({ data: { teamId: ids.team, name: "Disjoint", slug: randomUUID(), githubRepo: `other/disjoint_${randomUUID().replaceAll("-", "")}` } });
  const target = await app();
  const created = await target.request(request(`/projects/${projectId}/tasks`, { title: "Still enrolls" }));
  expect(created.status).toBe(201);
});

it("real app uses shared trust for issue, signed receipt and successful completion", async () => {
  const target = await app();
  const created = await target.request(request(`/projects/${projectId}/tasks`, { title: "Protected completion" }, human));
  const { task } = await created.json() as { task: { id: string } };
  await store.db.task.update({ where: { id: task.id }, data: { status: "in_progress", claimedByAgentId: ids.agent } });
  const issue = await target.request(request(`/tasks/${task.id}/grounding-attempts`, { intent: "finish" }));
  expect(issue.status).toBe(201);
  const challenge = await issue.json() as GroundingChallenge;
  const receiptPath = `/tasks/${task.id}/grounding-attempts/${challenge.attemptId}/receipt`;
  const bad = await target.request(request(receiptPath, { session, receipt: testIssuer([projectId]).receipt(challenge) }));
  expect(bad.status).toBe(422);
  expect(await store.db.groundingReceipt.count({ where: { taskId: task.id } })).toBe(0);
  expect(await store.db.groundingAttempt.findUniqueOrThrow({ where: { id: challenge.attemptId } })).toMatchObject({ sessionId: null, sessionRevision: null });
  const good = await target.request(request(receiptPath, { session, receipt: issuer.receipt(challenge) }));
  expect(good.status).toBe(200);
  const finish = await target.request(request(`/tasks/${task.id}/finish`, {}));
  expect(finish.status).toBe(200);
  expect(await store.db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "review" });
  expect(await store.db.groundingFinalization.count({ where: { taskId: task.id } })).toBe(1);
});

it("real app wires human-admin migration with live authority and shared trust", async () => {
  const task = await store.db.task.create({ data: { projectId, title: "Migration", status: "in_progress" } });
  const target = await app(); const path = `/tasks/${task.id}/grounding-migration`;
  const hold = { action: "hold", reason: "Operator review", key: "hold", expectedRevision: 0 };
  expect((await target.request(request(path, hold))).status).toBe(403);
  expect(await store.db.groundingMigrationState.count({ where: { taskId: task.id } })).toBe(0);
  expect((await target.request(request(path, hold, human))).status).toBe(200);
  const held = await snapshot();
  const finish = await target.request(request(`/tasks/${task.id}/finish`, {}));
  expect(finish.status).toBe(409); expect(await finish.json()).toMatchObject({ error: "grounding_task_held" });
  expect(await snapshot()).toEqual(held); expect(fetch).not.toHaveBeenCalled();
  expect((await target.request(request(path, { action: "migrate_external", reason: "Compatible trust", key: "migrate", expectedRevision: 1, subjectMode: "TASK_SPEC" }, human))).status).toBe(200);
  expect(await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId: task.id } })).toMatchObject({ audience: "consumer.test", subjectMode: "TASK_SPEC" });
  expect(await store.db.groundingMigrationState.findUniqueOrThrow({ where: { taskId: task.id } })).toMatchObject({ held: true, revision: 2 });
});

it("real composed CODE_HEAD creation and grouped GitHub merge retain one database and durable group", async () => {
  const input = config(); input.creationPolicy[0]!.subjectMode = "CODE_HEAD";
  const target = await app(store.db, input);
  const created = await target.request(request(`/projects/${projectId}/tasks`, { title: "Code change" }, human));
  expect(created.status).toBe(201);
  const { task } = await created.json() as { task: { id: string } };
  expect(await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId: task.id } })).toMatchObject({ subjectMode: "CODE_HEAD" });
  let merged = false;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") { merged = true; return Response.json({ merged: true, sha: "b".repeat(40) }); }
    const body = init?.method === "POST" ? JSON.parse(init.body as string).body : "";
    return Response.json({ number: 42, html_url: `https://github.com/${repo}/pull/42`, title: "Code change", body,
      head: { sha: "a".repeat(40), ref: "feature", label: "acme:feature", repo: { full_name: repo, owner: { login: "acme" } } },
      base: { ref: "main", repo: { full_name: repo } }, merged, state: merged ? "closed" : "open", merge_commit_sha: merged ? "b".repeat(40) : null,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const create = await target.request(request("/github/pull-requests", { taskId: task.id, owner: "acme", repo: repo.split("/")[1], head: "feature", title: "Code change" }, token, "create"));
  expect(create.status).toBe(201);
  expect(await store.db.groundingGithubCreateOperation.findFirstOrThrow({ where: { taskId: task.id } })).toMatchObject({ state: "COMPLETED" });
  await store.db.task.update({ where: { id: task.id }, data: { status: "review" } });
  const issue = await target.request(request(`/tasks/${task.id}/grounding-attempts`, { intent: "merge" }));
  expect(issue.status).toBe(201);
  const challenge = await issue.json() as GroundingChallenge;
  expect((await target.request(request(`/tasks/${task.id}/grounding-attempts/${challenge.attemptId}/receipt`, { session, receipt: issuer.receipt(challenge) }))).status).toBe(200);
  const result = await target.request(request("/github/pull-requests/42/merge", { taskId: task.id, owner: "acme", repo: repo.split("/")[1] }, token, "merge"));
  expect(result.status).toBe(200);
  expect(await store.db.groundingGithubMergeGroup.findFirstOrThrow({ where: { seedTaskId: task.id } })).toMatchObject({ state: "COMPLETED" });
  expect(await store.db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "done", autoMergeSha: "b".repeat(40) });
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
});

it("signed issue creation enrolls selected projects and preserves unselected behavior and exact dedup", async () => {
  // An unselected project may no longer share a repo with an enforced one
  // (SE-02): give it its own repo, so the webhook fans out only to the
  // enrolled project below and the unselected one sees no task at all.
  const other = await store.db.project.create({ data: { teamId: ids.team, name: "Unselected", slug: randomUUID(), githubRepo: `${repo}-unselected` } });
  const target = await app(); const delivery = randomUUID(); const before = await snapshot();
  expect((await target.request(webhook(delivery, false))).status).toBe(401); expect(await snapshot()).toEqual(before);
  expect((await target.request(webhook(delivery))).status).toBe(200);
  const task = await store.db.task.findFirstOrThrow({ where: { projectId } });
  expect(task).toMatchObject({ title: "[GH #17] New issue", description: "Original description", status: "open" });
  expect(await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId: task.id } })).toMatchObject({ subjectMode: "TASK_SPEC" });
  expect(await store.db.groundingCohort.findUniqueOrThrow({ where: { taskId: task.id } })).toMatchObject({ mode: "EXTERNAL_V1" });
  expect(await store.db.task.count({ where: { projectId: other.id } })).toBe(0);
  expect((await snapshot()).signals).toHaveLength(0);
  const after = await snapshot();
  const duplicate = await target.request(webhook(delivery)); expect(await duplicate.json()).toMatchObject({ duplicate: true });
  expect(await snapshot()).toEqual(after);
  const changed = webhook(delivery);
  const changedRaw = (await changed.text()).replace("New issue", "Different issue");
  const changedHeaders = new Headers(changed.headers);
  changedHeaders.set("X-Hub-Signature-256", `sha256=${createHmac("sha256", secret).update(changedRaw).digest("hex")}`);
  expect((await target.request(new Request(changed.url, { method: "POST", headers: changedHeaders, body: changedRaw }))).status).toBe(409);
  expect(await snapshot()).toEqual(after);
});

it.each(["missing open", "terminal open", "review open", "binding failure", "audit failure"])("issue creation %s rolls back delivery, task, cohort, binding and audit", async condition => {
  if (condition === "missing open") await store.db.workflow.updateMany({ where: { projectId }, data: { definition: { initialState: "queued", states: [{ name: "queued", label: "queued", terminal: false }, { name: "done", label: "done", terminal: true }], transitions: [{ from: "queued", to: "done" }] } } });
  if (condition === "terminal open") await store.db.workflow.updateMany({ where: { projectId }, data: { definition: { ...workflow, states: workflow.states.map(state => ({ ...state, terminal: state.name === "open" || state.terminal })) } } });
  if (condition === "review open") await store.db.workflow.updateMany({ where: { projectId }, data: { definition: { initialState: "queued", states: [{ name: "queued", label: "queued", terminal: false }, { name: "working", label: "working", terminal: false }, { name: "open", label: "open", terminal: false }, { name: "done", label: "done", terminal: true }], transitions: [{ from: "queued", to: "working" }, { from: "working", to: "open" }, { from: "open", to: "done" }] } } });
  const db = store.connect().$extends({ query: {
    groundingBinding: { async create({ args, query }) { if (condition === "binding failure") throw new Error("binding unavailable"); return query(args); } },
    auditLog: { async create({ args, query }) { if (condition === "audit failure") throw new Error("audit unavailable"); return query(args); } },
  } }) as unknown as PrismaClient;
  const target = await app(db); const before = await snapshot();
  expect((await target.request(webhook())).status).toBeGreaterThanOrEqual(400);
  expect(await snapshot()).toEqual(before);
});
