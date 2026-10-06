// The legacy GitHub writers on a configured application do not follow a
// GitHub redirect, which GitHub sends for a renamed or transferred repository
// and which would take the write to a repository the effect-boundary check
// never saw. GitHub is emulated by a local 127.0.0.1 server (no remote
// contact) that answers every request for a repository named "acme/old-*"
// with a 307 to repository id 77, as GitHub does after a rename, and answers
// the writes there successfully.
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
const harness = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get: (_target, property) => { const value = Reflect.get(harness.db!, property); return typeof value === "function" ? value.bind(harness.db) : value; } }) }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("../../src/services/confidence-telemetry.js", () => ({ recordBounceBack: vi.fn(), recordTerminalSnapshot: vi.fn(), recordClarification: vi.fn(), recordAbandonDisposition: vi.fn(), clearDisposition: vi.fn() }));
import { createApp } from "../../src/app.js";
import { GroundingGithubMergeService } from "../../src/services/grounding-github-merge.js";
import { createGroundingRemoteTargetGuard, type GroundingEnforcedScope } from "../../src/services/grounding-scope.js";
import { completionFixture, completionStore, completionActor } from "../helpers/grounding-completion-fixtures.js";
import { ids } from "../helpers/grounding-fixtures.js";
import { remoteSites, requesterTask, siteRequest, uniquePr, type RemoteSite } from "../helpers/grounding-remote-sites.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
const token = "remote-redirect-test";
const actor = { ...completionActor, scopes: [...completionActor.scopes, "github:pr_create", "tasks:comment"] };
const realFetch = globalThis.fetch;
/** Every request the emulator received, as "METHOD path". */
const received: string[] = [];
/** The init every GitHub write was sent with. */
const writeInits: RequestInit[] = [];
let server: http.Server; let origin = "";
beforeAll(async () => {
  store = await completionStore(); harness.db = store.db;
  f = await completionFixture(store, "EXTERNAL_V1", deps => new GroundingGithubMergeService(deps));
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      received.push(`${req.method} ${url}`);
      const renamed = /^\/repos\/acme\/old-[^/]+(\/.*)$/.exec(url);
      if (renamed) { res.writeHead(307, { Location: `/repositories/77${renamed[1]}` }); res.end(); return; }
      // A write to "acme/status-<code>-*" is answered with that status and no
      // Location header, so no redirect can be followed.
      const answered = req.method !== "GET" ? /^\/repos\/acme\/status-(\d{3})-[^/]+\//.exec(url) : null;
      if (answered) { res.writeHead(Number(answered[1]), { "Content-Type": "application/json" }); res.end(JSON.stringify({ message: `Status ${answered[1]}` })); return; }
      const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.method === "PUT" && /^\/repositories\/77\/pulls\/\d+\/merge$/.test(url)) return json(200, { sha: "d".repeat(40), merged: true, message: "Pull Request successfully merged" });
      if (req.method === "POST" && url === "/repositories/77/pulls") return json(201, { number: 501, html_url: "https://github.com/acme/pilot/pull/501", title: "Create" });
      if (req.method === "POST" && /^\/repositories\/77\/issues\/\d+\/comments$/.test(url)) return json(201, { id: 1, html_url: "https://github.com/acme/pilot/pull/5#issuecomment-1", body: "A comment" });
      json(404, { message: "Not Found" });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60000);
afterAll(async () => { server?.close(); if (store) await store.close(); });
beforeEach(async () => {
  vi.stubEnv("REDIS_URL", ""); received.length = 0; writeInits.length = 0;
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { tokenHash: createHash("sha256").update(token).digest("hex"), scopes: actor.scopes, revokedAt: null } });
  await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrCreate: true, allowAgentPrMerge: true, allowAgentPrComment: true } });
  // api.github.com goes to the emulator with every fetch option, the redirect
  // mode included, exactly as the caller passed it.
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") writeInits.push(init);
    return realFetch(url.startsWith("https://api.github.com") ? origin + url.slice("https://api.github.com".length) : url, init);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const emptyScope = (): GroundingEnforcedScope => ({ projectIds: new Set(), repos: new Set() });
const configured = () => createApp("", f.attempts, { db: store.db, service: f.service, scope: emptyScope(), remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope: emptyScope() }) });
const renamedRepo = () => `acme/old-${uniquePr()}`;
/** The first write the site sends, as the emulator receives it, for `repo` and `prNumber`. */
function firstWrite(site: RemoteSite, repo: string, prNumber: number) {
  if (site === "create") return `POST /repos/${repo}/pulls`;
  if (site === "comment") return `POST /repos/${repo}/issues/${prNumber}/comments`;
  return `PUT /repos/${repo}/pulls/${prNumber}/merge`;
}
/** The same write re-sent to the redirect target. */
function followedWrite(site: RemoteSite, prNumber: number) {
  if (site === "create") return "POST /repositories/77/pulls";
  if (site === "comment") return `POST /repositories/77/issues/${prNumber}/comments`;
  return `PUT /repositories/77/pulls/${prNumber}/merge`;
}
const writesOf = (requests: string[]) => requests.filter(request => !request.startsWith("GET "));

describe("a GitHub redirect on a legacy write", () => {
  it.each(remoteSites)("%s: the configured application refuses it with 409 github_redirect_refused and sends nothing to the redirect target", async site => {
    const repo = renamedRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, site, repo, site === "create" || site === "comment" ? null : prNumber);
    const before = await store.db.task.findUniqueOrThrow({ where: { id: requester.taskId } });
    const response = await configured().fetch(siteRequest(site, requester.taskId, repo, prNumber, token));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "github_redirect_refused", message: expect.stringContaining("renamed or transferred") });
    expect(writesOf(received)).toEqual([firstWrite(site, repo, prNumber)]);
    expect(writeInits.map(init => init.redirect)).toEqual(["manual"]);
    expect(await store.db.task.findUniqueOrThrow({ where: { id: requester.taskId } })).toEqual(before);
  });
  it.each(remoteSites)("%s: the unconfigured application keeps fetch's default redirect handling and follows it, as before", async site => {
    const repo = renamedRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, site, repo, site === "create" || site === "comment" ? null : prNumber);
    const response = await createApp("").fetch(siteRequest(site, requester.taskId, repo, prNumber, token));
    expect(response.status).toBe(site === "create" || site === "comment" ? 201 : 200);
    expect(writesOf(received)).toEqual([firstWrite(site, repo, prNumber), followedWrite(site, prNumber)]);
    // The request init carries no redirect option at all, so it is the same
    // request the unconfigured application sent before.
    expect(writeInits).toHaveLength(1);
    // The merge PUT additionally carries its timeout signal; create and comment do not.
    expect(Object.keys(writeInits[0]!)).toEqual(site === "create" || site === "comment" ? ["method", "headers", "body"] : ["method", "headers", "body", "signal"]);
  });
});

describe("which GitHub answers count as a redirect", () => {
  const answeredRepo = (status: number) => `acme/status-${status}-${uniquePr()}`;
  const requesterFor = (site: RemoteSite, repo: string, prNumber: number) => requesterTask(store.db, site, repo, site === "create" || site === "comment" ? null : prNumber);
  it.each(remoteSites)("%s: the configured application refuses a 300 answer as a redirect", async site => {
    const repo = answeredRepo(300); const prNumber = uniquePr();
    const requester = await requesterFor(site, repo, prNumber);
    const response = await configured().fetch(siteRequest(site, requester.taskId, repo, prNumber, token));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "github_redirect_refused", message: expect.stringContaining("renamed or transferred") });
    expect(writesOf(received)).toEqual([firstWrite(site, repo, prNumber)]);
  });
  it.each(remoteSites)("%s: the configured application answers a 400 answer as the GitHub error it is, not as a redirect", async site => {
    const repo = answeredRepo(400); const prNumber = uniquePr();
    const requester = await requesterFor(site, repo, prNumber);
    const response = await configured().fetch(siteRequest(site, requester.taskId, repo, prNumber, token));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "github_error", message: expect.stringContaining("Status 400") });
  });
  it("a refused merge redirect writes exactly one github.pr_merge_failed audit event", async () => {
    const repo = renamedRepo(); const prNumber = uniquePr();
    const requester = await requesterTask(store.db, "task-merge", repo, prNumber);
    const response = await configured().fetch(siteRequest("task-merge", requester.taskId, repo, prNumber, token));
    expect(response.status).toBe(409);
    const failures = () => store.db.auditLog.findMany({ where: { taskId: requester.taskId, action: "github.pr_merge_failed" } });
    await vi.waitFor(async () => expect((await failures()).length).toBeGreaterThan(0));
    // The audit write is not awaited; a second one would land within this wait.
    await new Promise(resolve => setTimeout(resolve, 200));
    const rows = await failures();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ prNumber, githubStatus: 307, githubMessage: "github_redirect_refused" });
  });
  it.each(remoteSites)("%s: the unconfigured application answers a final 307 it cannot follow as a GitHub error with that status", async site => {
    const repo = answeredRepo(307); const prNumber = uniquePr();
    const requester = await requesterFor(site, repo, prNumber);
    const before = await store.db.task.findUniqueOrThrow({ where: { id: requester.taskId } });
    const response = await createApp("").fetch(siteRequest(site, requester.taskId, repo, prNumber, token));
    expect(response.status).toBe(307);
    expect(await response.json()).toMatchObject({ error: "github_error", message: "GitHub API error: Status 307" });
    expect(writesOf(received)).toEqual([firstWrite(site, repo, prNumber)]);
    expect(await store.db.task.findUniqueOrThrow({ where: { id: requester.taskId } })).toEqual(before);
  });
});
