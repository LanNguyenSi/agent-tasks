import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
const harness = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get: (_target, property) => { const value = Reflect.get(harness.db!, property); return typeof value === "function" ? value.bind(harness.db) : value; } }) }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("../../src/services/confidence-telemetry.js", () => ({ recordBounceBack: vi.fn(), recordTerminalSnapshot: vi.fn(), recordClarification: vi.fn(), recordAbandonDisposition: vi.fn(), clearDisposition: vi.fn() }));
import { createApp } from "../../src/app.js";
import { GroundingGithubMergeService } from "../../src/services/grounding-github-merge.js";
import { GroundingMigrationService } from "../../src/services/grounding-migration.js";
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { createGroundingRemoteTargetGuard, type GroundingEnforcedScope } from "../../src/services/grounding-scope.js";
import { createSessionToken } from "../../src/services/session.js";
import { completionFixture, completionStore, completionActor } from "../helpers/grounding-completion-fixtures.js";
import { ids, session } from "../helpers/grounding-fixtures.js";
import { canonicalRepo, ownFence, pullUrl } from "../helpers/grounding-remote-sites.js";

// Every Grounding router answers a caller without access to the task's
// project before it reads any Grounding table or takes any row lock, so the
// answer is the same whatever the task's Grounding state.
let store: Awaited<ReturnType<typeof completionStore>>;
let logged: PrismaClient;
let f: Awaited<ReturnType<typeof completionFixture>>;
const statements: string[] = [];
const scopes = [...completionActor.scopes, "github:pr_create", "tasks:create", "tasks:comment", "tasks:read"];
// An agent and a human of another team, with every route scope but no access
// to any project used here.
const foreign = { user: randomUUID(), team: randomUUID(), agent: randomUUID(), token: "auth-order-foreign-agent" };
let foreignHuman: string;
beforeAll(async () => {
  store = await completionStore();
  logged = new PrismaClient({ datasourceUrl: store.datasourceUrl, log: [{ emit: "event", level: "query" }] });
  (logged as unknown as { $on(event: "query", listener: (event: { query: string }) => void): void }).$on("query", event => { statements.push(event.query); });
  harness.db = logged;
  await store.db.user.create({ data: { id: foreign.user, login: "foreign", githubAccessToken: "test-only", githubConnectedAt: new Date(), allowAgentPrCreate: true, allowAgentPrMerge: true, allowAgentPrComment: true } });
  await store.db.team.create({ data: { id: foreign.team, name: "Foreign", slug: `foreign-${foreign.team}` } });
  await store.db.teamMember.create({ data: { teamId: foreign.team, userId: foreign.user, role: "ADMIN" } });
  await store.db.agentToken.create({ data: { id: foreign.agent, teamId: foreign.team, createdById: foreign.user, name: "Foreign", tokenHash: createHash("sha256").update(foreign.token).digest("hex"), scopes } });
  foreignHuman = await createSessionToken(foreign.user, "test-secret-which-is-long-enough-1234");
  f = await completionFixture(store, "EXTERNAL_V1", deps => new GroundingGithubMergeService(deps));
}, 60000);
afterAll(async () => { await logged?.$disconnect(); if (store) await store.close(); });
beforeEach(() => { vi.stubEnv("REDIS_URL", ""); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("external HTTP disabled"))); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

type State = "plain" | "held" | "EXTERNAL_V1" | "pending operation" | "owned fence" | "in scope";
const states: State[] = ["held", "EXTERNAL_V1", "pending operation", "owned fence", "in scope"];
/** A task in the given Grounding state, in a project of the fixture team. */
async function taskIn(state: State, scope: GroundingEnforcedScope) {
  if (state === "EXTERNAL_V1") {
    const provisioned = await completionFixture(store, "EXTERNAL_V1", deps => new GroundingGithubMergeService(deps));
    return { taskId: provisioned.taskId, projectId: provisioned.projectId, repo: "acme/repo" };
  }
  const projectId = randomUUID(); const taskId = randomUUID(); const repo = canonicalRepo();
  await store.db.project.create({ data: { id: projectId, teamId: ids.team, name: "Target", slug: randomUUID(), githubRepo: repo } });
  await store.db.task.create({ data: { id: taskId, projectId, title: "Target", status: "review", claimedByAgentId: ids.agent, prNumber: 7, prUrl: pullUrl(repo, 7), branchName: "feature" } });
  if (state === "held") await store.db.groundingMigrationState.create({ data: { taskId, projectId, held: true, revision: 1 } });
  if (state === "pending operation") {
    await store.db.groundingOperation.create({ data: { taskId, key: "pending-merge", actorType: "agent", actorId: ids.agent, fingerprint: "0".repeat(64), request: {}, decision: {}, state: "DISPATCHED" } });
    await store.db.groundingGithubCreateOperation.create({ data: { id: randomUUID(), taskId, projectId, key: "pending-create", actorId: ids.agent, actorUserId: ids.user, actorTeamId: ids.team, fingerprint: "0".repeat(64), request: { owner: "acme", repo: "x", head: "feature", base: "main", title: "Create" }, delegateUserId: ids.user, state: "DISPATCHED" } });
  }
  if (state === "owned fence") await ownFence(store.db, repo);
  if (state === "in scope") (scope.projectIds as Set<string>).add(projectId);
  return { taskId, projectId, repo };
}
// Every service runs on the logged client, so the query log sees each
// statement a router or service issues for the request.
function application(scope: GroundingEnforcedScope, selected: string[] = []) {
  const config = { audience: "consumer.test", trust: () => f.issuer.trust };
  const attempts = new GroundingAttemptsService({ db: logged, config, now: () => f.now, headProvider: f.headProvider });
  return createApp("", attempts, { db: logged, service: f.make(logged), scope, remoteGuard: createGroundingRemoteTargetGuard({ db: logged, scope }), creationPolicy: selected.map(projectId => ({ projectId, subjectMode: "TASK_SPEC" as const })) }, new GroundingMigrationService({ db: logged, config }));
}
function request(method: string, path: string, body: unknown, auth: string, key: string | null = "auth-order-key") {
  return new Request(`http://localhost${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}`, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
/** Statements a denied request must not issue before (or instead of) its
 * denial: any Grounding table (after dropping the test schema's own
 * "grounding_test_..." qualifier) or any row lock taken FOR UPDATE. */
const lockOrGroundingRead = (sql: string) => /\bgrounding_/.test(sql.replaceAll(`"${store.schema}".`, "")) || /\bFOR\s+UPDATE\b/i.test(sql);
async function answer(send: () => Response | Promise<Response>) {
  statements.length = 0;
  const response = await send();
  return { status: response.status, body: await response.json(), statements: [...statements] };
}

type Endpoint = [label: string, method: string, path: (task: { taskId: string; repo: string }) => string, body: (task: { taskId: string; repo: string }) => unknown, auth: () => string];
const agent = () => foreign.token;
const endpoints: Endpoint[] = [
  ["grounding attempt issue", "POST", t => `/api/tasks/${t.taskId}/grounding-attempts`, () => ({ intent: "finish" }), agent],
  ["grounding direct attempt issue", "POST", t => `/api/tasks/${t.taskId}/grounding-attempts/direct`, () => ({ version: 1, endpoint: "transition", target: "review" }), agent],
  ["grounding receipt", "POST", t => `/api/tasks/${t.taskId}/grounding-attempts/${randomUUID()}/receipt`, () => ({ session, receipt: "{}" }), agent],
  ["grounding migration", "POST", t => `/api/tasks/${t.taskId}/grounding-migration`, () => ({ action: "hold", reason: "Operator hold", expectedRevision: 0, key: "hold-key" }), () => foreignHuman],
  ["finish", "POST", t => `/api/tasks/${t.taskId}/finish`, () => ({ autoMerge: true }), agent],
  ["merge", "POST", t => `/api/tasks/${t.taskId}/merge`, () => ({}), agent],
  ["abandon", "POST", t => `/api/tasks/${t.taskId}/abandon`, () => ({}), agent],
  ["transition", "POST", t => `/api/tasks/${t.taskId}/transition`, () => ({ status: "done" }), agent],
  ["review", "POST", t => `/api/tasks/${t.taskId}/review`, () => ({ action: "approve" }), agent],
  ["patch", "PATCH", t => `/api/tasks/${t.taskId}`, () => ({ status: "done" }), agent],
  ["respec", "POST", t => `/api/tasks/${t.taskId}/respec`, () => ({ title: "Respec" }), agent],
  ["delete", "DELETE", t => `/api/tasks/${t.taskId}`, () => undefined, agent],
  ["github create", "POST", () => "/api/github/pull-requests", t => ({ taskId: t.taskId, owner: t.repo.split("/")[0], repo: t.repo.split("/")[1], head: "feature", title: "Create" }), agent],
  ["github merge", "POST", () => "/api/github/pull-requests/7/merge", t => ({ taskId: t.taskId, owner: t.repo.split("/")[0], repo: t.repo.split("/")[1] }), agent],
  ["github comment", "POST", () => "/api/github/pull-requests/7/comments", t => ({ taskId: t.taskId, owner: t.repo.split("/")[0], repo: t.repo.split("/")[1], body: "A comment" }), agent],
];

describe("access before routing on every Grounding router", () => {
  for (const [label, method, path, body, auth] of endpoints) {
    it.each(states)(`${label}: a caller without access gets the plain task's answer for a %s task, before any Grounding read or lock`, async state => {
      const scope: GroundingEnforcedScope = { projectIds: new Set(), repos: new Set() };
      const plain = await taskIn("plain", scope);
      const target = await taskIn(state, scope);
      const app = application(scope);
      for (const key of [null, "auth-order-key"]) {
        const baseline = await answer(() => app.fetch(request(method, path(plain), body(plain), auth(), key)));
        const observed = await answer(() => app.fetch(request(method, path(target), body(target), auth(), key)));
        expect(baseline.status).toBeGreaterThanOrEqual(400);
        expect({ status: observed.status, body: observed.body }).toEqual({ status: baseline.status, body: baseline.body });
        expect(baseline.statements.filter(lockOrGroundingRead)).toEqual([]);
        expect(observed.statements.filter(lockOrGroundingRead)).toEqual([]);
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  }
});

describe("creation selection is not observable without access", () => {
  const creations: [string, string, (projectId: string) => string, unknown][] = [
    ["task create", "POST", projectId => `/api/projects/${projectId}/tasks`, { title: "Created" }],
    ["task create with an invalid body", "POST", projectId => `/api/projects/${projectId}/tasks`, { title: "" }],
    ["task import", "POST", projectId => `/api/projects/${projectId}/tasks/import`, { tasks: [{ title: "Imported" }] }],
    ["task import with an invalid body", "POST", projectId => `/api/projects/${projectId}/tasks/import`, { tasks: [] }],
  ];
  it.each(creations)("%s: a caller without access gets the legacy answer for a selected project", async (_label, method, path, body) => {
    const scope: GroundingEnforcedScope = { projectIds: new Set(), repos: new Set() };
    const selected = await taskIn("in scope", scope);
    const unselected = await taskIn("plain", scope);
    const app = application(scope, [selected.projectId]);
    const count = await store.db.task.count();
    const legacy = await answer(() => createApp("").fetch(request(method, path(unselected.projectId), body, foreign.token, null)));
    const baseline = await answer(() => app.fetch(request(method, path(unselected.projectId), body, foreign.token, null)));
    const observed = await answer(() => app.fetch(request(method, path(selected.projectId), body, foreign.token, null)));
    expect(legacy.status).toBeGreaterThanOrEqual(400);
    expect({ status: baseline.status, body: baseline.body }).toEqual({ status: legacy.status, body: legacy.body });
    expect({ status: observed.status, body: observed.body }).toEqual({ status: legacy.status, body: legacy.body });
    expect(observed.statements.filter(lockOrGroundingRead)).toEqual([]);
    expect(await store.db.task.count()).toBe(count);
  });
});
