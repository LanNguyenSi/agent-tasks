import { createHash } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
const harness = vi.hoisted(() => ({ db: null as PrismaClient | null, afterRouting: null as null | (() => Promise<void>) }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get: (_target, property) => { const value = Reflect.get(harness.db!, property); return typeof value === "function" ? value.bind(harness.db) : value; } }) }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("../../src/services/confidence-telemetry.js", () => ({ recordBounceBack: vi.fn(), recordTerminalSnapshot: vi.fn() }));
// A seam after the router's routing read: a test can change the task there, as
// a concurrent request would between the router's decision and the legacy
// handler's own task read.
vi.mock("../../src/services/grounding-route-context.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/services/grounding-route-context.js")>();
  return { ...original, selectGroundingRouteContext: async (...args: Parameters<typeof original.selectGroundingRouteContext>) => {
    const context = await original.selectGroundingRouteContext(...args);
    if (harness.afterRouting) await harness.afterRouting();
    return context;
  } };
});
import { createApp } from "../../src/app.js";
import { GroundingGithubMergeService } from "../../src/services/grounding-github-merge.js";
import { createGroundingRemoteTargetGuard, type GroundingEnforcedScope } from "../../src/services/grounding-scope.js";
import { performPrMerge } from "../../src/services/github-merge.js";
import { githubRouter } from "../../src/routes/github.js";
import { completionFixture, completionStore, completionActor } from "../helpers/grounding-completion-fixtures.js";
import { ids } from "../helpers/grounding-fixtures.js";
import { aliasOf, canonicalRepo, enrollTask, githubStub, mergeSites, mixedCase, ownFence, ownIntentFence, peerTask, pullUrl, remoteSites, requesterTask, siteRequest, siteWrite, uniquePr, type PeerClass, type RemoteSite } from "../helpers/grounding-remote-sites.js";
import type { AppVariables } from "../../src/types/hono.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
const token = "remote-boundary-test";
const actor = { ...completionActor, scopes: [...completionActor.scopes, "github:pr_create", "tasks:comment"] };
beforeAll(async () => {
  store = await completionStore(); harness.db = store.db;
  f = await completionFixture(store, "EXTERNAL_V1", deps => new GroundingGithubMergeService(deps));
}, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => {
  vi.stubEnv("REDIS_URL", "");
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { tokenHash: createHash("sha256").update(token).digest("hex"), scopes: actor.scopes, revokedAt: null } });
  await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrCreate: true, allowAgentPrMerge: true, allowAgentPrComment: true } });
});
afterEach(() => { harness.afterRouting = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const emptyScope = (): GroundingEnforcedScope => ({ projectIds: new Set(), repos: new Set() });
function configured(scope: GroundingEnforcedScope = emptyScope(), db: PrismaClient = store.db) {
  return createApp("", f.attempts, { db, service: f.service, scope, remoteGuard: createGroundingRemoteTargetGuard({ db, scope }) });
}
const repoParts = (repo: string) => { const slash = repo.indexOf("/"); return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) }; };
const targetPr = (site: RemoteSite, prNumber: number) => (site === "create" || site === "comment" ? null : prNumber);

// Every condition the effect-boundary guard refuses, and the neighbouring ones
// it must not. Each sets up a fresh requester at the site's legacy-reachable
// state, with its target at `repo` and `prNumber`.
type PeerRow = readonly [PeerClass, string, number | null, string | null];
const peerConditions: Record<string, (repo: string, pr: number) => PeerRow> = {
  "protected peer": (repo, pr) => ["protected", repo, pr, pullUrl(repo, pr)],
  "EXTERNAL_V1 peer": (repo, pr) => ["external", repo, pr, pullUrl(repo, pr)],
  "bound peer": (repo, pr) => ["bound", repo, pr, pullUrl(repo, pr)],
  "held peer": (repo, pr) => ["held", repo, pr, pullUrl(repo, pr)],
  "peer without a PR URL": (repo, pr) => ["held", repo, pr, null],
  "peer whose PR number is only in its PR URL": (repo, pr) => ["held", repo, null, pullUrl(repo, pr)],
  "peer whose repository is only in its PR URL": (repo, pr) => ["held", canonicalRepo(), pr, pullUrl(repo, pr)],
  "alias peer": (repo, pr) => ["held", aliasOf(repo), pr, null],
  "alias peer PR URL": (repo, pr) => ["held", canonicalRepo(), null, pullUrl(aliasOf(repo), pr)],
};
const nonPeerConditions: Record<string, (repo: string, pr: number) => PeerRow> = {
  "unenrolled task on the same PR": (repo, pr) => ["none", repo, pr, pullUrl(repo, pr)],
  "unenrolled alias task on the same PR number": (repo, pr) => ["none", aliasOf(repo), pr, null],
  "OFF cohort on the same PR": (repo, pr) => ["off", repo, pr, pullUrl(repo, pr)],
  "released hold on the same PR": (repo, pr) => ["released", repo, pr, pullUrl(repo, pr)],
  "peer on another PR of the repository": repo => { const other = uniquePr(); return ["held", repo, other, pullUrl(repo, other)]; },
  "peer on the same PR number of another repository": (_repo, pr) => { const other = canonicalRepo(); return ["held", other, pr, pullUrl(other, pr)]; },
};
// The mixed-case cells send the target in a casing other than the lowercase
// canonical identity the fence and peer rows are stored under.
const mixedCaseFence = "mixed-case target, lowercase owned fence";
const mixedCasePeer = "mixed-case target, lowercase peer row";
const conditions = ["control", "enforced repository", "non-canonical repository", "owned fence", mixedCaseFence, mixedCasePeer, ...Object.keys(peerConditions), ...Object.keys(nonPeerConditions)];
async function arrange(site: RemoteSite, condition: string) {
  const canonical = canonicalRepo();
  const repo = condition === "non-canonical repository" ? aliasOf(canonical) : condition === mixedCaseFence || condition === mixedCasePeer ? mixedCase(canonical) : canonical;
  const prNumber = uniquePr();
  const scope = emptyScope();
  if (condition === "enforced repository") (scope.repos as Set<string>).add(repo.toLowerCase());
  const peer = peerConditions[condition] ?? nonPeerConditions[condition];
  if (peer) { const [kind, peerRepo, peerPr, peerUrl] = peer(repo, prNumber); await peerTask(store.db, kind, { repo: peerRepo, prNumber: peerPr, prUrl: peerUrl }); }
  if (condition === mixedCasePeer) await peerTask(store.db, "held", { repo: canonical, prNumber, prUrl: null });
  const requester = await requesterTask(store.db, site, repo, targetPr(site, prNumber));
  if (condition === "owned fence" || condition === mixedCaseFence) await ownFence(store.db, canonical);
  return { requester, repo, prNumber, scope };
}
/** Which refusal the guard gives at a site, or null where the target reaches GitHub. */
function expected(site: RemoteSite, condition: string): string | null {
  if (condition === "enforced repository" || condition === "non-canonical repository") return "grounding_enrollment_required";
  if (condition === "owned fence" || condition === mixedCaseFence) return site === "comment" ? null : "grounding_finalization_pending";
  // A create sends no PR number, so no peer PR can be its target.
  if (condition in peerConditions || condition === mixedCasePeer) return site === "create" ? null : "grounding_enrollment_required";
  return null;
}

describe("effect-boundary matrix", () => {
  for (const site of remoteSites) {
    it.each(conditions)(`${site}: %s`, async condition => {
      const { requester, repo, prNumber, scope } = await arrange(site, condition);
      const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
      const before = await store.db.task.findUniqueOrThrow({ where: { id: requester.taskId } });
      const response = await configured(scope).fetch(siteRequest(site, requester.taskId, repo, prNumber, token));
      const refusal = expected(site, condition);
      if (refusal) {
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: refusal, message: expect.any(String) });
        expect(github.calls).toEqual([]);
        expect(await store.db.task.findUniqueOrThrow({ where: { id: requester.taskId } })).toEqual(before);
      } else {
        expect(github.writes()[0]).toBe(siteWrite(site, repo, prNumber));
        expect(response.status).not.toBe(409);
      }
    });
  }
});

describe("unconfigured differential", () => {
  // Out-of-scope requests on a configured application with an empty scope get
  // the same response and the same GitHub calls as on the unconfigured one.
  // Timestamps written by the handler differ between the two runs by design.
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key.endsWith("At") && typeof entry === "string" ? "<timestamp>" : stable(entry)]))
      : value;
  // The first run's stored idempotent response and task writes are undone so
  // the second run starts from the same state.
  const restore = async (taskId: string, row: Awaited<ReturnType<typeof store.db.task.findUniqueOrThrow>>) => {
    await store.db.toolInvocation.deleteMany({ where: { projectId: row.projectId } });
    await store.db.task.update({ where: { id: taskId }, data: { status: row.status, claimedByAgentId: row.claimedByAgentId, claimedByUserId: row.claimedByUserId, claimedAt: row.claimedAt, reviewClaimedByAgentId: row.reviewClaimedByAgentId, reviewClaimedByUserId: row.reviewClaimedByUserId, reviewClaimedAt: row.reviewClaimedAt, prUrl: row.prUrl, prNumber: row.prNumber, branchName: row.branchName, autoMergeSha: row.autoMergeSha } });
  };
  async function both(taskId: string, send: (target: ReturnType<typeof createApp>) => Response | Promise<Response>) {
    const before = await store.db.task.findUniqueOrThrow({ where: { id: taskId } });
    const answers = [];
    for (const target of [configured(), createApp("")]) {
      const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
      const response = await send(target);
      answers.push({ status: response.status, body: stable(await response.json()), calls: github.calls });
      await restore(taskId, before);
    }
    return answers;
  }
  it.each(remoteSites)("%s reaches GitHub identically configured and unconfigured", async site => {
    const repo = canonicalRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, site, repo, targetPr(site, prNumber));
    const [configuredAnswer, unconfiguredAnswer] = await both(requester.taskId, target => target.fetch(siteRequest(site, requester.taskId, repo, prNumber, token)));
    expect(configuredAnswer).toEqual(unconfiguredAnswer);
    expect(configuredAnswer!.calls).toContain(siteWrite(site, repo, prNumber));
  });
  // Inputs the Grounding contract would reject reach the legacy handlers
  // unchanged: a body key outside the key format, a leading-zero path number,
  // a body field outside the strict create body and a merge body repo that is
  // not a canonical identity, which the legacy merger never sends to GitHub.
  it.each([
    ["a merge body key outside the key format", "github-merge", (b: Record<string, unknown>) => ({ ...b, idempotencyKey: "legacy key/with space" }), (n: number) => `${n}`],
    ["a leading-zero merge path number", "github-merge", (b: Record<string, unknown>) => b, (n: number) => `0${n}`],
    ["a create body field outside the strict contract", "create", (b: Record<string, unknown>) => ({ ...b, draft: true }), (n: number) => `${n}`],
    ["a merge body repo repeating the owner", "github-merge", (b: Record<string, unknown>) => ({ ...b, repo: `${b.owner as string}/${b.repo as string}` }), (n: number) => `${n}`],
  ] as const)("%s reaches the legacy handler identically configured and unconfigured", async (_label, site, shape, path) => {
    const repo = canonicalRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, site, repo, targetPr(site, prNumber));
    const { owner, name } = repoParts(repo);
    const body = shape(site === "create" ? { taskId: requester.taskId, owner, repo: name, head: "feature", title: "Create" } : { taskId: requester.taskId, owner, repo: name });
    const url = site === "create" ? "/api/github/pull-requests" : `/api/github/pull-requests/${path(prNumber)}/merge`;
    const [configuredAnswer, unconfiguredAnswer] = await both(requester.taskId, target => target.fetch(new Request(`http://localhost${url}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })));
    expect(configuredAnswer).toEqual(unconfiguredAnswer);
    expect(configuredAnswer!.calls).toContain(siteWrite(site, repo, prNumber));
  });
});

describe("requesting-side race", () => {
  it("performPrMerge refuses a PR number changed after routing, and never calls GitHub", async () => {
    const repo = canonicalRepo(); const peerPr = uniquePr();
    await peerTask(store.db, "protected", { repo, prNumber: peerPr, prUrl: pullUrl(repo, peerPr) });
    const requester = await requesterTask(store.db, "task-merge", repo, uniquePr());
    const task = await store.db.task.findUniqueOrThrow({ where: { id: requester.taskId }, include: { project: true } });
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    // The router admitted the task with its own PR; a concurrent write then
    // pointed it at the peer's PR, which is what the legacy handler sends.
    const guard = createGroundingRemoteTargetGuard({ db: store.db, scope: emptyScope() });
    expect(await performPrMerge({ ...task, prNumber: peerPr }, "squash", completionActor, guard)).toMatchObject({ ok: false, error: "grounding_enrollment_required", status: 409 });
    expect(github.calls).toEqual([]);
    expect(await performPrMerge(task, "squash", completionActor, guard)).toMatchObject({ ok: true });
    expect(github.writes()).toEqual([siteWrite("task-merge", repo, requester.prNumber!)]);
  });
  it.each(mergeSites)("%s: a concurrent change of the task's PR after the router's decision is refused at the effect boundary", async site => {
    const repo = canonicalRepo(); const peerPr = uniquePr();
    await peerTask(store.db, "protected", { repo, prNumber: peerPr, prUrl: pullUrl(repo, peerPr) });
    const requester = await requesterTask(store.db, site, repo, uniquePr());
    harness.afterRouting = async () => {
      harness.afterRouting = null;
      await store.db.task.update({ where: { id: requester.taskId }, data: { prNumber: peerPr, prUrl: pullUrl(repo, peerPr) } });
    };
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    // The GitHub merge route's path names the requester's original PR; the
    // legacy merger sends the task's current one.
    const response = await configured().fetch(siteRequest(site, requester.taskId, repo, requester.prNumber!, token));
    expect(harness.afterRouting).toBeNull();
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "grounding_enrollment_required" });
    expect(github.calls).toEqual([]);
  });
  it.each(mergeSites)("%s: a hold placed on the requesting task after the router's decision is refused at the effect boundary", async site => {
    const repo = canonicalRepo();
    const requester = await requesterTask(store.db, site, repo, uniquePr());
    harness.afterRouting = async () => {
      harness.afterRouting = null;
      await store.db.groundingMigrationState.create({ data: { taskId: requester.taskId, projectId: requester.projectId, held: true, revision: 1 } });
    };
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured().fetch(siteRequest(site, requester.taskId, repo, requester.prNumber!, token));
    expect(harness.afterRouting).toBeNull();
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "grounding_enrollment_required" });
    expect(github.calls).toEqual([]);
  });
});

describe("exact target", () => {
  // The creator posts to the request's owner/repo, which the legacy cross-repo
  // gate matches against the task's deliverable repository, not its project's.
  it("a create is checked on the repository it posts to, not on the task's project repository", async () => {
    const enforced = canonicalRepo();
    const requester = await requesterTask(store.db, "create", canonicalRepo(), null);
    await store.db.task.update({ where: { id: requester.taskId }, data: { deliverableRepo: enforced } });
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const refused = await configured({ projectIds: new Set(), repos: new Set([enforced]) }).fetch(siteRequest("create", requester.taskId, enforced, 1, token));
    expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: "grounding_enrollment_required" });
    expect(github.calls).toEqual([]);
    const allowed = await configured({ projectIds: new Set(), repos: new Set([requester.repo]) }).fetch(siteRequest("create", requester.taskId, enforced, 1, token));
    expect(allowed.status).toBe(201);
    expect(github.writes()).toEqual([siteWrite("create", enforced, 1)]);
  });
  // The commenter posts to the request's owner/repo and path number, whatever
  // the task's own repository.
  it("a comment is checked on the repository and PR it posts to, not on the task's own", async () => {
    const target = canonicalRepo(); const pr = uniquePr();
    await peerTask(store.db, "held", { repo: target, prNumber: pr, prUrl: null });
    const requester = await requesterTask(store.db, "comment", canonicalRepo(), null);
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const peer = await configured().fetch(siteRequest("comment", requester.taskId, target, pr, token));
    expect(peer.status).toBe(409); expect(await peer.json()).toMatchObject({ error: "grounding_enrollment_required" });
    const enforced = await configured({ projectIds: new Set(), repos: new Set([target]) }).fetch(siteRequest("comment", requester.taskId, target, uniquePr(), token));
    expect(enforced.status).toBe(409); expect(await enforced.json()).toMatchObject({ error: "grounding_enrollment_required" });
    expect(github.calls).toEqual([]);
    const own = await configured({ projectIds: new Set(), repos: new Set([target]) }).fetch(siteRequest("comment", requester.taskId, requester.repo, pr, token));
    expect(own.status).toBe(201);
    expect(github.writes()).toEqual([siteWrite("comment", requester.repo, pr)]);
  });
});

describe("fence of the requesting task's own repositories", () => {
  // The legacy task write's fence trigger checks every repository of the task
  // (its effective repository, its stored PR URL repository and its own active
  // PR-create intents), not only the one the GitHub write goes to; a fence
  // another operation owns on any of them would fail that write after the
  // GitHub effect.
  it.each(mergeSites)("%s: an owned fence on the task's stored PR URL repository refuses the merge of its project repository", async site => {
    const repo = canonicalRepo(); const stored = canonicalRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, site, repo, prNumber);
    await store.db.task.update({ where: { id: requester.taskId }, data: { prUrl: pullUrl(stored, prNumber) } });
    await ownFence(store.db, stored);
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const before = await store.db.task.findUniqueOrThrow({ where: { id: requester.taskId } });
    const response = await configured().fetch(siteRequest(site, requester.taskId, repo, prNumber, token));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "grounding_finalization_pending", message: expect.any(String) });
    expect(github.calls).toEqual([]);
    expect(await store.db.task.findUniqueOrThrow({ where: { id: requester.taskId } })).toEqual(before);
  });
  it("github-merge on a review task: an owned fence on the stored PR URL repository refuses the merge", async () => {
    const repo = canonicalRepo(); const stored = canonicalRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, "github-merge", repo, prNumber);
    await store.db.task.update({ where: { id: requester.taskId }, data: { status: "review", claimedByAgentId: null, reviewClaimedByAgentId: ids.agent, prUrl: pullUrl(stored, prNumber) } });
    await ownFence(store.db, stored);
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured().fetch(siteRequest("github-merge", requester.taskId, repo, prNumber, token));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "grounding_finalization_pending", message: expect.any(String) });
    expect(github.calls).toEqual([]);
  });
  it("create: an owned fence on the stored PR URL repository of a task without a project repository refuses a create elsewhere", async () => {
    const stored = canonicalRepo(); const target = canonicalRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, "create", stored, prNumber);
    await store.db.project.update({ where: { id: requester.projectId }, data: { githubRepo: null } });
    await ownFence(store.db, stored);
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const before = await store.db.task.findUniqueOrThrow({ where: { id: requester.taskId } });
    const response = await configured().fetch(siteRequest("create", requester.taskId, target, 1, token));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "grounding_finalization_pending", message: expect.any(String) });
    expect(github.calls).toEqual([]);
    expect(await store.db.task.findUniqueOrThrow({ where: { id: requester.taskId } })).toEqual(before);
  });
  it.each(["task-merge", "create"] as const)("%s: a fence the task's own active PR-create intent owns elsewhere refuses the write", async site => {
    const repo = canonicalRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, site, repo, targetPr(site, prNumber));
    await ownIntentFence(store.db, requester.taskId, canonicalRepo());
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured().fetch(siteRequest(site, requester.taskId, repo, prNumber, token));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "grounding_finalization_pending", message: expect.any(String) });
    expect(github.calls).toEqual([]);
  });
  it("a merge-kind intent of the task on an unrelated repository is not a repository its task write checks", async () => {
    const repo = canonicalRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, "task-merge", repo, prNumber);
    await ownIntentFence(store.db, requester.taskId, canonicalRepo(), "MERGE");
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured().fetch(siteRequest("task-merge", requester.taskId, repo, prNumber, token));
    expect(response.status).toBe(200);
    expect(github.writes()).toEqual([siteWrite("task-merge", repo, prNumber)]);
  });
  it("a create whose mixed-case target is fenced under its lowercase identity is refused, with no project repository to match", async () => {
    const canonical = canonicalRepo();
    const requester = await requesterTask(store.db, "create", canonicalRepo(), null);
    await store.db.project.update({ where: { id: requester.projectId }, data: { githubRepo: null } });
    await ownFence(store.db, canonical);
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured().fetch(siteRequest("create", requester.taskId, mixedCase(canonical), 1, token));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "grounding_finalization_pending", message: expect.any(String) });
    expect(github.calls).toEqual([]);
  });
});

describe("exact repository string sent", () => {
  // The check runs on the string that goes into the GitHub URL, so a string
  // with surrounding whitespace is refused rather than trimmed into a
  // different identity.
  it.each([["a leading space in the owner", " ", ""], ["a trailing no-break space in the name", "", " "]] as const)("create: %s is refused before GitHub", async (_label, ownerPad, namePad) => {
    const requester = await requesterTask(store.db, "create", canonicalRepo(), null);
    await store.db.project.update({ where: { id: requester.projectId }, data: { githubRepo: null } });
    const [owner, name] = canonicalRepo().split("/");
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured().fetch(siteRequest("create", requester.taskId, `${ownerPad}${owner}/${name}${namePad}`, 1, token));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "grounding_enrollment_required", message: expect.any(String) });
    expect(github.calls).toEqual([]);
  });
  it.each([["a leading space in the owner", " ", ""], ["a trailing no-break space in the name", "", " "]] as const)("comment: %s is refused before GitHub", async (_label, ownerPad, namePad) => {
    const requester = await requesterTask(store.db, "comment", canonicalRepo(), null);
    const [owner, name] = canonicalRepo().split("/");
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured().fetch(siteRequest("comment", requester.taskId, `${ownerPad}${owner}/${name}${namePad}`, uniquePr(), token));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "grounding_enrollment_required", message: expect.any(String) });
    expect(github.calls).toEqual([]);
  });
  it.each(mergeSites)("%s: a project repository with surrounding whitespace is refused before GitHub", async site => {
    const prNumber = uniquePr();
    const requester = await requesterTask(store.db, site, ` ${canonicalRepo()}\t`, prNumber);
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured().fetch(siteRequest(site, requester.taskId, requester.repo.trim(), prNumber, token));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "grounding_enrollment_required", message: expect.any(String) });
    expect(github.calls).toEqual([]);
  });
});

describe("requesting task that became a peer after routing", () => {
  // The router handed the task on as unprovisioned; a merge or create is
  // refused once it is protected, EXTERNAL_V1, bound or held, whatever PR
  // number the handler sends.
  it.each(["held", "protected", "external", "bound"] as const)("github-merge on a task without a stored PR, %s after routing, is refused on the path number", async kind => {
    const repo = canonicalRepo();
    const requester = await requesterTask(store.db, "github-merge", repo, null);
    harness.afterRouting = async () => { harness.afterRouting = null; await enrollTask(store.db, kind, requester.taskId, requester.projectId); };
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured().fetch(siteRequest("github-merge", requester.taskId, repo, uniquePr(), token));
    expect(harness.afterRouting).toBeNull();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "grounding_enrollment_required", message: expect.any(String) });
    expect(github.calls).toEqual([]);
  });
  it("github-merge by a task held after routing is refused as enrollment required while a fence it checks is owned", async () => {
    const repo = canonicalRepo();
    const requester = await requesterTask(store.db, "github-merge", repo, null);
    // The hold goes in first: the enrollment fence trigger refuses a hold on a
    // task whose repository fence is owned.
    harness.afterRouting = async () => { harness.afterRouting = null; await enrollTask(store.db, "held", requester.taskId, requester.projectId); await ownFence(store.db, repo); };
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured().fetch(siteRequest("github-merge", requester.taskId, repo, uniquePr(), token));
    expect(harness.afterRouting).toBeNull();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "grounding_enrollment_required", message: expect.any(String) });
    expect(github.calls).toEqual([]);
  });
  it("create by a task held after routing is refused", async () => {
    const repo = canonicalRepo();
    const requester = await requesterTask(store.db, "create", repo, null);
    harness.afterRouting = async () => { harness.afterRouting = null; await enrollTask(store.db, "held", requester.taskId, requester.projectId); };
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured().fetch(siteRequest("create", requester.taskId, repo, 1, token));
    expect(harness.afterRouting).toBeNull();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "grounding_enrollment_required", message: expect.any(String) });
    expect(github.calls).toEqual([]);
  });
});

describe("a task's comment on its own PR", () => {
  // A task's stored PR number and repository are fields an agent can set, so
  // they prove no authorship: a comment on an enforced repository or on a
  // protected, EXTERNAL_V1, bound or held task's PR is refused whoever sends
  // it, the requesting task's own PR included.
  async function enrolledTask() {
    const enrolled = await completionFixture(store, "EXTERNAL_V1", deps => new GroundingGithubMergeService(deps));
    const repo = canonicalRepo(); const prNumber = uniquePr();
    await store.db.project.update({ where: { id: enrolled.projectId }, data: { githubRepo: repo } });
    await store.db.task.update({ where: { id: enrolled.taskId }, data: { prNumber, prUrl: pullUrl(repo, prNumber) } });
    return { taskId: enrolled.taskId, projectId: enrolled.projectId, repo, prNumber };
  }
  const enforcedScope = (repo: string, projectId?: string): GroundingEnforcedScope => ({ projectIds: new Set(projectId ? [projectId] : []), repos: new Set([repo]) });
  async function comment(scope: GroundingEnforcedScope, taskId: string, repo: string, prNumber: number) {
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await configured(scope).fetch(siteRequest("comment", taskId, repo, prNumber, token));
    return { status: response.status, body: await response.json(), calls: github.calls };
  }
  const refused = { status: 409, body: { error: "grounding_enrollment_required", message: expect.any(String) }, calls: [] };
  it("an EXTERNAL_V1 task's comment on its own PR is refused, in an enforced repository as well", async () => {
    const task = await enrolledTask();
    for (const scope of [emptyScope(), enforcedScope(task.repo), enforcedScope(task.repo, task.projectId)]) {
      expect(await comment(scope, task.taskId, task.repo, task.prNumber)).toEqual(refused);
    }
  });
  it.each(["protected", "bound", "held"] as const)("a %s task's comment on its own PR is refused", async kind => {
    const repo = canonicalRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, "comment", repo, prNumber);
    await enrollTask(store.db, kind, requester.taskId, requester.projectId);
    expect(await comment(emptyScope(), requester.taskId, repo, prNumber)).toEqual(refused);
  });
  // Whatever the requesting task stores, a comment on an enforced repository
  // is refused: in scope or not, with or without a stored PR, and after a
  // released hold.
  const enforcedRequesters: Record<string, (repo: string, prNumber: number) => Record<string, unknown>> = {
    "its stored PR and PR URL": (repo, prNumber) => ({ prNumber, prUrl: pullUrl(repo, prNumber) }),
    "its stored PR without a PR URL": (_repo, prNumber) => ({ prNumber, prUrl: null }),
    "no stored PR number or PR URL": () => ({ prNumber: null, prUrl: null }),
    "a PR URL that is not a GitHub pull request": (_repo, prNumber) => ({ prNumber, prUrl: `https://gitlab.example/acme/x/-/merge_requests/${prNumber}` }),
    "a non-canonical deliverable repository": (repo, prNumber) => ({ deliverableRepo: aliasOf(repo), prNumber, prUrl: null }),
  };
  it.each(Object.keys(enforcedRequesters))("a task of an enforced project with %s is refused on its enforced repository", async label => {
    const repo = canonicalRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, "comment", repo, prNumber);
    await store.db.task.update({ where: { id: requester.taskId }, data: enforcedRequesters[label]!(repo, prNumber) });
    expect(await comment(enforcedScope(repo, requester.projectId), requester.taskId, repo, prNumber)).toEqual(refused);
    expect(await comment(enforcedScope(repo), requester.taskId, repo, prNumber)).toEqual(refused);
  });
  it("a task whose hold was released is refused on its own PR in its enforced repository", async () => {
    const repo = canonicalRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, "comment", repo, prNumber);
    await enrollTask(store.db, "released", requester.taskId, requester.projectId);
    expect(await comment(enforcedScope(repo, requester.projectId), requester.taskId, repo, prNumber)).toEqual(refused);
  });
  it("another peer's PR in the task's repository stays refused", async () => {
    const task = await enrolledTask(); const other = uniquePr();
    await peerTask(store.db, "held", { repo: task.repo, prNumber: other, prUrl: pullUrl(task.repo, other) });
    expect(await comment(emptyScope(), task.taskId, task.repo, other)).toEqual(refused);
  });
  it("an enrolled or held task's comment on an unrelated PR is not refused by its own class", async () => {
    const task = await enrolledTask();
    const other = await comment(emptyScope(), task.taskId, task.repo, uniquePr());
    expect(other.status).toBe(201);
    const repo = canonicalRepo();
    const held = await requesterTask(store.db, "comment", repo, uniquePr());
    await enrollTask(store.db, "held", held.taskId, held.projectId);
    const unrelated = uniquePr();
    const answer = await comment(emptyScope(), held.taskId, repo, unrelated);
    expect(answer.status).toBe(201);
    expect(answer.calls).toEqual([siteWrite("comment", repo, unrelated)]);
  });
  it("an unenrolled task outside the scope comments on its own PR in a repository no enforced project owns", async () => {
    const repo = canonicalRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, "comment", repo, prNumber);
    const answer = await comment(enforcedScope(canonicalRepo()), requester.taskId, repo, prNumber);
    expect(answer.status).toBe(201);
    expect(answer.calls).toEqual([siteWrite("comment", repo, prNumber)]);
  });
});

describe("guard wiring", () => {
  it("a configured completion service without its remote target guard refuses startup", () => {
    expect(() => createApp("", f.attempts, { db: store.db, service: f.service, scope: emptyScope() } as unknown as Parameters<typeof createApp>[2])).toThrow("Grounding completion service requires a remote target guard");
  });
  it("a configuration without a completion service installs a guard that refuses every target", async () => {
    const repo = canonicalRepo();
    const requester = await requesterTask(store.db, "comment", repo, null);
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await createApp("", f.attempts).fetch(siteRequest("comment", requester.taskId, repo, uniquePr(), token));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "grounding_enrollment_required" });
    expect(github.calls).toEqual([]);
  });
  it("a legacy handler mounted without the application's wiring fails closed before GitHub", async () => {
    const repo = canonicalRepo();
    const requester = await requesterTask(store.db, "create", repo, null);
    const bare = new Hono<{ Variables: AppVariables }>();
    bare.use("*", async (c, next) => { c.set("actor", actor); await next(); });
    bare.route("/api/github", githubRouter);
    const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
    const response = await bare.fetch(siteRequest("create", requester.taskId, repo, 1, token));
    expect(response.status).toBe(500);
    expect(github.calls).toEqual([]);
  });
  it("every site issues exactly one boundary statement when configured and none when unconfigured", async () => {
    const logged = new PrismaClient({ datasourceUrl: store.datasourceUrl, log: [{ emit: "event", level: "query" }] });
    const statements: string[] = [];
    (logged as unknown as { $on(event: "query", listener: (event: { query: string }) => void): void }).$on("query", event => { statements.push(event.query); });
    harness.db = logged;
    try {
      for (const [target, perSite] of [[() => configured(emptyScope(), logged), 1], [() => createApp(""), 0]] as const) {
        for (const site of remoteSites) {
          const repo = canonicalRepo(); const prNumber = uniquePr();
          const requester = await requesterTask(store.db, site, repo, targetPr(site, prNumber));
          const github = githubStub(); vi.stubGlobal("fetch", github.fetcher);
          statements.length = 0;
          await target().fetch(siteRequest(site, requester.taskId, repo, prNumber, token));
          expect(github.calls, site).toContain(siteWrite(site, repo, prNumber));
          expect(statements.filter(sql => sql.includes("AS peer")).length, site).toBe(perSite);
        }
      }
    } finally { harness.db = store.db; await logged.$disconnect(); }
  });
});
