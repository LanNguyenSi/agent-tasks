import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AgentActor } from "../../src/types/auth.js";
import { groundingPostgres, barrier } from "../helpers/grounding-postgres.js";
import { epoch, session, testIssuer } from "../helpers/grounding-fixtures.js";
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { GroundingGithubCreateService } from "../../src/services/grounding-github-create.js";
import { githubGroundingCreateProvider, githubCreateCorrelationMarker, type GroundingGithubCreateProvider } from "../../src/services/grounding-github-create-provider.js";
import { acquireGithubFence } from "../../src/services/grounding-github-fence.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { store = await groundingPostgres(); }, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => { f = await fixture(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await store.db.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_create_binding ON audit_logs'); });
async function fixture() {
  const db = store.db; const userId = randomUUID(); const teamId = randomUUID(); const tokenId = randomUUID(); const projectId = randomUUID(); const taskId = randomUUID(); const repo = randomUUID();
  const actor: AgentActor = { type: "agent", tokenId, userId, teamId, scopes: ["tasks:update", "github:pr_create", "tasks:transition", "github:pr_merge"] };
  await db.user.create({ data: { id: userId, login: userId, githubAccessToken: "test-only-token", githubConnectedAt: new Date(), allowAgentPrCreate: true } });
  await db.team.create({ data: { id: teamId, name: "Create", slug: teamId } });
  await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  await db.agentToken.create({ data: { id: tokenId, teamId, createdById: userId, name: "Create", tokenHash: tokenId, scopes: actor.scopes } });
  await db.project.create({ data: { id: projectId, teamId, name: "Create", slug: projectId, githubRepo: `acme/${repo}` } });
  await db.task.create({ data: { id: taskId, projectId, title: "Create", status: "in_progress", claimedByAgentId: tokenId, claimedAt: new Date(), branchName: "old" } });
  const request = { owner: "acme", repo, head: "work/feature", base: "main", title: "Create PR", body: "Body" };
  const raw = { body: request.body, number: 42, html_url: `https://github.com/acme/${repo}/pull/42`, title: "Create PR", head: { label: "acme:work/feature", ref: "work/feature", sha: "a".repeat(40), repo: { full_name: `acme/${repo}`, owner: { login: "acme" } } }, base: { ref: "main", repo: { full_name: `acme/${repo}` } } };
  const tagged = (operationId: string, value = raw) => ({ ...structuredClone(value), body: `${request.body}\n\n${githubCreateCorrelationMarker(operationId)}` });
  const create = vi.fn<GroundingGithubCreateProvider["create"]>(async (_request, _token, operationId) => tagged(operationId));
  const read = vi.fn<GroundingGithubCreateProvider["read"]>(async (_request, _token, operationId) => ({ complete: true, pullRequests: [tagged(operationId)] }));
  const provider = { create, read }; const service = new GroundingGithubCreateService({ db, provider });
  const issuer = testIssuer([projectId]); const attempts = new GroundingAttemptsService({ db, config: { audience: "consumer.test", trust: () => issuer.trust }, now: () => epoch });
  return { db, actor, projectId, taskId, request, raw, tagged, provider, create, read, service,
    call(key = "create", body: unknown = request, requester = actor) { return service.createOrResume(taskId, requester, key, body); },
    restart() { return new GroundingGithubCreateService({ db: store.connect(), provider }); },
    async evidence() {
      await attempts.provision({ taskId, projectId, subjectMode: "TASK_SPEC" });
      const challenge = await attempts.issue(taskId, actor, "finish");
      await attempts.ingest(taskId, challenge.attemptId, actor, session, issuer.receipt(challenge));
      return challenge;
    },
    async snapshot() {
      return { signals: await db.signal.findMany({ where: { taskId }, orderBy: { id: "asc" } }), task: await db.task.findUniqueOrThrow({ where: { id: taskId } }), binding: await db.groundingBinding.findUnique({ where: { taskId } }), attempts: await db.groundingAttempt.findMany({ where: { taskId } }),
        audits: await db.auditLog.findMany({ where: { OR: [{ taskId }, { projectId, action: "project.grounding.context_mutated" }] }, orderBy: { createdAt: "asc" } }),
        operations: await db.groundingGithubCreateOperation.findMany({ where: { taskId } }), fence: await db.groundingGithubRepositoryFence.findUnique({ where: { repo: `acme/${repo}` } }) };
    },
  };
}
async function failBindingAudit() {
  await f.db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_create_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'github.pr_created' THEN RAISE EXCEPTION 'test_binding_commit_failure'; END IF; RETURN NEW; END $$`);
  await f.db.$executeRawUnsafe('CREATE TRIGGER fail_create_binding BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_create_binding()');
}

it("binds and invalidates receipt exactly once without changing claims, status or signals", async () => {
  const challenge = await f.evidence();
  await f.db.signal.create({ data: { taskId: f.taskId, projectId: f.projectId, type: "changes_requested", recipientAgentId: f.actor.tokenId, context: { question: "Retain this" } } });
  const before = await f.snapshot();
  const result = await f.call(); expect(result.status).toBe(201);
  expect(result.body).toEqual({ pullRequest: { number: 42, url: f.raw.html_url, title: "Create PR" }, task: { id: f.taskId, branchName: f.request.head, prUrl: f.raw.html_url, prNumber: 42 } });
  const after = await f.snapshot();
  expect(after.task).toMatchObject({ status: before.task.status, claimedByAgentId: before.task.claimedByAgentId, claimedAt: before.task.claimedAt });
  expect(after.signals).toEqual(before.signals);
  expect(after.binding).toMatchObject({ contextRevision: before.binding!.contextRevision + 1, activeAttemptId: null, contextDigest: null });
  expect(after.attempts.find(a => a.id === challenge.attemptId)?.state).toBe("SUPERSEDED");
  expect(after.audits.map(a => a.action)).toEqual(expect.arrayContaining(["github.pr_created", "project.grounding.context_mutated"]));
  expect(after.fence?.ownerId).toBeNull(); expect(after.operations).toHaveLength(1); expect(after.operations[0]?.state).toBe("COMPLETED");
  expect((await f.call()).replayed).toBe(true);
  expect(await f.snapshot()).toEqual(after); expect(f.create).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1);
});

it("unprovisioned tasks preserve the success response without implicit enrollment", async () => {
  expect((await f.call()).status).toBe(201);
  const after = await f.snapshot(); expect(after.binding).toBeNull(); expect(after.attempts).toHaveLength(0);
  expect(await f.db.groundingCohort.count({ where: { taskId: f.taskId } })).toBe(0);
});

it("existing legacy reservation rejects before any POST or create intent", async () => {
  await f.db.$transaction(async tx => {
    const operation = await tx.groundingOperation.create({ data: { taskId: f.taskId, key: "merge", actorType: "agent", actorId: f.actor.tokenId, fingerprint: "legacy", request: {}, decision: {}, state: "RESERVED", repo: `acme/${f.request.repo}`, prNumber: 42 } });
    await tx.groundingCohort.create({ data: { taskId: f.taskId, projectId: f.projectId, mode: "OFF", protected: false, provenance: "test", reservationId: operation.id } });
  });
  await expect(f.call()).rejects.toMatchObject({ status: 409 }); expect(f.create).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  expect(await f.db.groundingGithubCreateOperation.count({ where: { taskId: f.taskId } })).toBe(0);
});

it("holds the committed fence before POST, excluding merge and raw binding writers", async () => {
  f.create.mockImplementationOnce(async (_request, _token, operationId) => {
    const operation = await f.db.groundingGithubCreateOperation.findUniqueOrThrow({ where: { taskId_key: { taskId: f.taskId, key: "create" } } });
    expect(operation.state).toBe("DISPATCHED");
    expect((await f.snapshot()).fence?.ownerId).toBe(operation.id);
    await expect(store.connect().$transaction(tx => acquireGithubFence(tx, { id: randomUUID(), repo: `acme/${f.request.repo}`, kind: "MERGE", taskId: f.taskId }))).rejects.toThrow(/fence/);
    await expect(store.connect().task.update({ where: { id: f.taskId }, data: { branchName: "intruder" } })).rejects.toThrow(/grounding_github_fence_conflict/);
    return f.tagged(operationId);
  });
  expect((await f.call()).status).toBe(201); expect(f.create).toHaveBeenCalledTimes(1);
});

it("remote success plus a real audit failure rolls back binding and resumes read-only after restart", async () => {
  await f.evidence(); const before = await f.snapshot(); await failBindingAudit();
  const result = await f.call(); expect(result.status).toBe(202);
  const failed = await f.snapshot(); expect(failed.task).toEqual(before.task); expect(failed.binding).toEqual(before.binding); expect(failed.attempts).toEqual(before.attempts);
  expect(failed.operations[0]).toMatchObject({ state: "DISPATCHED", observed: { number: 42, sourceRepo: `acme/${f.request.repo}`, headSha: "a".repeat(40) }, result: null });
  expect(failed.fence?.ownerId).toBe(failed.operations[0]?.id);
  await f.db.$executeRawUnsafe('DROP TRIGGER fail_create_binding ON audit_logs');
  f.raw.head.sha = "b".repeat(40);
  expect((await f.restart().createOrResume(f.taskId, f.actor, "create", f.request)).status).toBe(201);
  const after = await f.snapshot(); expect(after.binding?.contextRevision).toBe(before.binding!.contextRevision + 1);
  expect(after.operations[0]?.observed).toMatchObject({ headSha: "a".repeat(40) });
  expect(after.audits.filter(a => a.action === "github.pr_created")).toHaveLength(1);
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1);
});

it("failure persisting the first observation remains pending and reconciles without another POST", async () => {
  const original = f.db.$transaction.bind(f.db);
  f.create.mockImplementationOnce(async (_request, _token, operationId) => { vi.spyOn(f.db, "$transaction").mockImplementationOnce(() => Promise.reject(new Error("test DB unavailable")) as ReturnType<typeof original>); return f.tagged(operationId); });
  expect((await f.call()).status).toBe(202);
  expect((await f.snapshot()).operations[0]?.observed).toBeNull();
  expect((await f.restart().createOrResume(f.taskId, f.actor, "create", f.request)).status).toBe(201);
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1);
});

it("concurrent retry never takes another dispatch claim or invalidates twice", async () => {
  await f.evidence(); const gate = barrier();
  f.create.mockImplementationOnce(async (_request, _token, operationId) => { await gate.wait(); return f.tagged(operationId); });
  f.read.mockResolvedValueOnce({ complete: true, pullRequests: [] });
  const first = f.call(); await gate.reached;
  const second = await f.restart().createOrResume(f.taskId, f.actor, "create", f.request);
  gate.release(); const firstResult = await first;
  expect(second.status).toBe(202); expect(firstResult.status).toBe(201);
  const retry = await Promise.all([f.call(), f.restart().createOrResume(f.taskId, f.actor, "create", f.request)]);
  expect(retry.map(r => r.status)).toEqual([201, 201]);
  const snapshot = await f.snapshot(); expect(snapshot.binding?.contextRevision).toBe(2); expect(snapshot.operations).toHaveLength(1); expect(snapshot.audits.filter(a => a.action === "github.pr_created")).toHaveLength(1);
  expect(f.create).toHaveBeenCalledTimes(1);
});

it("actor and body mismatch cannot replay either pending or completed results", async () => {
  f.create.mockRejectedValueOnce(new Error("uncertain")); expect((await f.call()).status).toBe(202);
  await expect(f.call("create", { ...f.request, body: "Different" })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  await expect(f.call("create", f.request, { ...f.actor, tokenId: randomUUID() })).rejects.toMatchObject({ code: "forbidden" });
  expect(f.read).not.toHaveBeenCalled(); expect((await f.call()).status).toBe(201);
  await expect(f.call("create", { ...f.request, title: "Different" })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
  expect(f.create).toHaveBeenCalledTimes(1);
});

it.each(["scope", "revoked", "consent", "connection", "membership"] as const)("recovery rechecks %s instead of using the admitted actor or switching delegate", async cause => {
  f.create.mockRejectedValueOnce(new Error("uncertain")); expect((await f.call()).status).toBe(202);
  const alternate = await f.db.user.create({ data: { login: randomUUID(), githubAccessToken: "alternate-test", githubConnectedAt: new Date(), allowAgentPrCreate: true } });
  await f.db.teamMember.create({ data: { userId: alternate.id, teamId: f.actor.teamId, role: "ADMIN" } });
  if (cause === "scope") await f.db.agentToken.update({ where: { id: f.actor.tokenId }, data: { scopes: ["tasks:update"] } });
  if (cause === "revoked") await f.db.agentToken.update({ where: { id: f.actor.tokenId }, data: { revokedAt: new Date() } });
  if (cause === "consent") await f.db.user.update({ where: { id: f.actor.userId }, data: { allowAgentPrCreate: false } });
  if (cause === "connection") await f.db.user.update({ where: { id: f.actor.userId }, data: { githubAccessToken: null } });
  if (cause === "membership") await f.db.teamMember.delete({ where: { teamId_userId: { teamId: f.actor.teamId, userId: f.actor.userId } } });
  await expect(f.call()).rejects.toMatchObject({ code: "forbidden" });
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.read).not.toHaveBeenCalled();
  expect((await f.snapshot()).operations[0]?.state).toBe("DISPATCHED");
});

it("requires agent scopes, project access and effective repository before any remote effect", async () => {
  await expect(f.service.createOrResume(f.taskId, { type: "human", userId: f.actor.userId }, "human", f.request)).rejects.toMatchObject({ code: "forbidden" });
  await expect(f.call("scope", f.request, { ...f.actor, scopes: ["tasks:update"] })).rejects.toMatchObject({ code: "forbidden" });
  await expect(f.call("repo", { ...f.request, repo: "foreign" })).rejects.toMatchObject({ status: 409 });
  const foreign = await fixture(); await expect(f.call("access", f.request, foreign.actor)).rejects.toMatchObject({ code: "forbidden" });
  expect(f.create).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
});

it.each(["base", "source", "branch", "url", "multiple", "incomplete"] as const)("wrong or ambiguous %s proof remains pending without redispatch", async mismatch => {
  f.create.mockRejectedValueOnce(new Error("uncertain")); expect((await f.call()).status).toBe(202);
  const raw = structuredClone(f.raw);
  if (mismatch === "base") raw.base.ref = "other";
  if (mismatch === "source") raw.head.repo.full_name = "stranger/repo";
  if (mismatch === "branch") raw.head.ref = "other";
  if (mismatch === "url") raw.html_url = "https://github.com/stranger/repo/pull/42";
  f.read.mockImplementationOnce(async (_request, _token, operationId) => ({ complete: mismatch !== "incomplete", pullRequests: mismatch === "multiple" ? [f.tagged(operationId, raw), f.tagged(operationId, raw)] : [f.tagged(operationId, raw)] }));
  expect((await f.call()).status).toBe(202); expect((await f.snapshot()).task.prNumber).toBeNull();
  expect((await f.call()).status).toBe(201); expect(f.create).toHaveBeenCalledTimes(1);
});

it("persisted observation rejects a different otherwise matching PR", async () => {
  await failBindingAudit(); expect((await f.call()).status).toBe(202);
  await f.db.$executeRawUnsafe('DROP TRIGGER fail_create_binding ON audit_logs');
  f.raw.number = 43; f.raw.html_url = `https://github.com/acme/${f.request.repo}/pull/43`;
  expect((await f.call()).status).toBe(202); expect((await f.snapshot()).task.prNumber).toBeNull();
  expect((await f.snapshot()).operations[0]?.observed).toMatchObject({ number: 42 }); expect(f.create).toHaveBeenCalledTimes(1);
});

it("qualified heads accept actual renamed forks while unqualified heads require the target repository", async () => {
  const request = { ...f.request, head: "forker:work/feature" };
  f.raw.head.repo = { full_name: "forker/renamed-fork", owner: { login: "forker" } }; f.raw.head.label = "forker:work/feature";
  expect((await f.call("fork", request)).status).toBe(201);
  expect((await f.snapshot()).operations[0]?.observed).toMatchObject({ sourceRepo: "forker/renamed-fork" });
  f = await fixture(); f.raw.head.repo.full_name = `acme/another-repo`;
  expect((await f.call()).status).toBe(202);
});

it("default provider bounds reads, rejects redirects, and encodes exact branch/base filters", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify([f.raw]), { headers: { link: '<https://api.github.com/next>; rel="next"' } })).mockResolvedValueOnce(new Response(JSON.stringify([f.raw])));
  vi.stubGlobal("fetch", fetcher);
  expect((await githubGroundingCreateProvider.read(f.request, "test-only", randomUUID())).complete).toBe(false);
  expect((await githubGroundingCreateProvider.read(f.request, "test-only", randomUUID())).complete).toBe(true);
  const [url, options] = fetcher.mock.calls[0]!; const parsed = new URL(String(url));
  expect(parsed.searchParams.get("head")).toBe("acme:work/feature"); expect(parsed.searchParams.get("base")).toBe("main"); expect(parsed.searchParams.get("state")).toBe("all"); expect(options).toMatchObject({ redirect: "error", cache: "no-store", method: "GET" });
  fetcher.mockResolvedValueOnce(new Response("x".repeat(262145)));
  await expect(githubGroundingCreateProvider.read(f.request, "test-only", randomUUID())).rejects.toThrow("provider unavailable");
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(f.raw), { status: 302 }));
  await expect(githubGroundingCreateProvider.create(f.request, "test-only", randomUUID())).rejects.toThrow("provider unavailable");
  expect(fetcher.mock.calls[3]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
});

it("unbound seed context remains excluded during a committed PR_CREATE dispatch", async () => {
  await f.db.project.update({ where: { id: f.projectId }, data: { githubRepo: null } });
  const gate = barrier(); f.create.mockImplementationOnce(async (_request, _token, operationId) => { await gate.wait(); return f.tagged(operationId); });
  const operation = f.call(); await gate.reached;
  const raw = await store.connect().task.update({ where: { id: f.taskId }, data: { branchName: "intruder" } }).then(() => "committed", e => String(e));
  gate.release(); await operation;
  expect(raw).toMatch(/grounding_github_fence_conflict/);
});

for (const isolationLevel of ["ReadCommitted", "Serializable"] as const) {
  it.each(["task", "project", "cohort", "binding"] as const)(`${isolationLevel} old snapshot cannot mutate unbound %s context after create dispatch`, async kind => {
    await f.evidence();
    await f.db.project.update({ where: { id: f.projectId }, data: { githubRepo: null } });
    const writer = barrier(); const post = barrier();
    const write = store.connect().$transaction(async tx => {
      await tx.task.findUniqueOrThrow({ where: { id: f.taskId } });
      await writer.wait();
      if (kind === "task") return tx.task.update({ where: { id: f.taskId }, data: { branchName: "intruder" } });
      if (kind === "project") return tx.project.update({ where: { id: f.projectId }, data: { githubRepo: "other/repository" } });
      if (kind === "cohort") return tx.groundingCohort.update({ where: { taskId: f.taskId }, data: { provenance: "changed" } });
      return tx.groundingBinding.update({ where: { taskId: f.taskId }, data: { contextRevision: { increment: 1 } } });
    }, { isolationLevel, timeout: 15000 }).then(() => "committed", e => String(e));
    await writer.reached;
    f.create.mockImplementationOnce(async (_request, _token, operationId) => { await post.wait(); return f.tagged(operationId); });
    const operation = f.call(); await post.reached;
    writer.release(); const outcome = await write;
    post.release(); await operation;
    expect(outcome).toMatch(/grounding_github_fence_conflict|write conflict|40001|serialize/i);
  });
}

it("different repository/key cannot dispatch a second create for the same unbound task", async () => {
  await f.db.project.update({ where: { id: f.projectId }, data: { githubRepo: null } });
  const gate = barrier(); f.create.mockImplementationOnce(async (_request, _token, operationId) => { await gate.wait(); return f.tagged(operationId); });
  const first = f.call(); await gate.reached;
  const second = await f.restart().createOrResume(f.taskId, f.actor, "other-key", { ...f.request, owner: "other", repo: "repository" }).then(result => result, error => ({ error }));
  gate.release(); const initial = await first;
  expect(second).toMatchObject({ error: { status: 409 } });
  expect(initial.status).toBe(201); expect(f.create).toHaveBeenCalledTimes(1);
});

it("CREATE-FIX historical closed PR cannot win retry before original POST returns its new PR", async () => {
  const gate = barrier();
  const created = { ...structuredClone(f.raw), number: 43, html_url: `https://github.com/acme/${f.request.repo}/pull/43`, state: "open" };
  f.create.mockImplementationOnce(async (_request, _token, operationId) => { await gate.wait(); return f.tagged(operationId, created); });
  f.read.mockResolvedValueOnce({ complete: true, pullRequests: [{ ...structuredClone(f.raw), state: "closed" }] });
  const first = f.call(); await gate.reached;
  let retry: Awaited<ReturnType<typeof f.call>>;
  let during: Awaited<ReturnType<typeof f.snapshot>>;
  try { retry = await f.restart().createOrResume(f.taskId, f.actor, "create", f.request); during = await f.snapshot(); }
  finally { gate.release(); }
  const original = await first;
  expect(retry!.status).toBe(202);
  expect(during!.task.prNumber).toBeNull();
  expect(during!.fence?.ownerId).toBe(during!.operations[0]?.id);
  expect(original).toMatchObject({ status: 201, body: { pullRequest: { number: 43 }, task: { prNumber: 43 } } });
  expect((await f.snapshot()).task.prNumber).toBe(43);
  expect(f.create).toHaveBeenCalledTimes(1);
});

it("CREATE-FIX actual tagged PR may win retry before same-proof original POST", async () => {
  await f.evidence(); const gate = barrier();
  f.raw.number = 43; f.raw.html_url = `https://github.com/acme/${f.request.repo}/pull/43`;
  f.create.mockImplementationOnce(async (_request, _token, operationId) => { await gate.wait(); return f.tagged(operationId); });
  const first = f.call(); await gate.reached;
  let retry: Awaited<ReturnType<typeof f.call>>;
  try { retry = await f.restart().createOrResume(f.taskId, f.actor, "create", f.request); }
  finally { gate.release(); }
  const original = await first;
  expect(retry!).toMatchObject({ status: 201, body: { pullRequest: { number: 43 } } });
  expect(original.body).toEqual(retry!.body);
  const after = await f.snapshot();
  expect(after.operations[0]?.proofConflict).toBeNull(); expect(after.binding?.contextRevision).toBe(2);
  expect(after.audits.filter(row => row.action === "github.pr_created")).toHaveLength(1);
  expect(f.create).toHaveBeenCalledTimes(1);
});

it.each(["missing", "edited", "different_operation", "multiple_tagged", "incomplete"] as const)("CREATE-FIX %s correlation cannot authorize a pending operation", async condition => {
  f.create.mockRejectedValueOnce(new Error("uncertain")); expect((await f.call()).status).toBe(202);
  const operationId = (await f.snapshot()).operations[0]!.id;
  const raw = f.tagged(condition === "different_operation" ? randomUUID() : operationId);
  if (condition === "missing") raw.body = f.request.body;
  if (condition === "edited") raw.body += "edited";
  f.read.mockResolvedValueOnce({ complete: condition !== "incomplete", pullRequests: condition === "multiple_tagged" ? [raw, { ...raw, number: 43, html_url: `https://github.com/acme/${f.request.repo}/pull/43` }] : [raw] });
  expect(await f.call()).toMatchObject({ status: 202, body: { state: "DISPATCHED" } });
  const after = await f.snapshot(); expect(after.task.prNumber).toBeNull(); expect(after.fence?.ownerId).toBe(operationId);
  expect(f.create).toHaveBeenCalledTimes(1);
});

it("CREATE-FIX untagged older and newer candidates do not displace the unique correlated PR", async () => {
  f.create.mockRejectedValueOnce(new Error("uncertain")); await f.call();
  f.read.mockImplementationOnce(async (_request, _token, operationId) => ({ complete: true, pullRequests: [
    { ...f.raw, number: 41, html_url: `https://github.com/acme/${f.request.repo}/pull/41`, state: "closed" },
    f.tagged(operationId),
    { ...f.raw, number: 43, html_url: `https://github.com/acme/${f.request.repo}/pull/43`, state: "open" },
  ] }));
  expect(await f.call()).toMatchObject({ status: 201, body: { pullRequest: { number: 42 } } });
  expect(f.create).toHaveBeenCalledTimes(1);
});

it("CREATE-FIX late conflicting POST after completed retry records durable conflict without touching binding or another fence owner", async () => {
  const gate = barrier();
  f.create.mockImplementationOnce(async (_request, _token, operationId) => { await gate.wait(); return f.tagged(operationId, { ...f.raw, number: 43, html_url: `https://github.com/acme/${f.request.repo}/pull/43` }); });
  const first = f.call(); await gate.reached;
  let before: Awaited<ReturnType<typeof f.snapshot>>;
  const nextOwner = { id: randomUUID(), repo: `acme/${f.request.repo}`, kind: "MERGE" as const, taskId: null };
  try {
    expect((await f.restart().createOrResume(f.taskId, f.actor, "create", f.request)).status).toBe(201);
    await store.connect().$transaction(tx => acquireGithubFence(tx, nextOwner));
    before = await f.snapshot();
  } finally { gate.release(); }
  const late = await first;
  expect(late).toMatchObject({ status: 202, body: { error: "grounding_github_create_conflict" } });
  const after = await f.snapshot(); expect(after.task).toEqual(before!.task); expect(after.fence).toEqual(before!.fence);
  expect(after.operations[0]).toMatchObject({ state: "COMPLETED", result: before!.operations[0]?.result, proofConflict: { source: "POST", priorState: "COMPLETED", original: { number: 42 }, conflicting: { number: 43 } } });
  const diagnostic = after.audits.filter(row => row.action === "github.pr_create_conflict");
  expect(diagnostic).toHaveLength(1); expect(diagnostic[0]).toMatchObject({ actorId: null, payload: expect.objectContaining({ actorType: "system_observation" }) });
  expect(await f.db.comment.count({ where: { taskId: f.taskId, content: { contains: "conflicting remote proof" } } })).toBe(1);
  expect(await f.restart().createOrResume(f.taskId, f.actor, "create", f.request)).toMatchObject({ status: 202, body: late.body });
  expect(await f.snapshot()).toEqual(after); expect(f.create).toHaveBeenCalledTimes(1);
});

it.each(["missing", "edited", "multiple_tagged", "incomplete", "unavailable"] as const)("CREATE-FIX completed replay with %s proof remains pending without rePOST or invented fence", async condition => {
  expect((await f.call()).status).toBe(201); const before = await f.snapshot(); const operationId = before.operations[0]!.id;
  const raw = f.tagged(operationId); if (condition === "missing") raw.body = f.request.body; if (condition === "edited") raw.body += "edited";
  if (condition === "unavailable") f.read.mockRejectedValueOnce(new Error("remote unavailable"));
  else f.read.mockResolvedValueOnce({ complete: condition !== "incomplete", pullRequests: condition === "multiple_tagged" ? [raw, structuredClone(raw)] : [raw] });
  expect(await f.restart().createOrResume(f.taskId, f.actor, "create", f.request)).toMatchObject({ status: 202, body: { error: "grounding_github_create_pending", operationId, state: "COMPLETED" } });
  expect(await f.snapshot()).toEqual(before); expect(f.create).toHaveBeenCalledTimes(1);
  expect((await f.call()).status).toBe(201);
});

it("CREATE-FIX completed replay with changed logical proof persists conflict rather than saved201", async () => {
  expect((await f.call()).status).toBe(201); const before = await f.snapshot();
  f.raw.number = 43; f.raw.html_url = `https://github.com/acme/${f.request.repo}/pull/43`;
  expect(await f.call()).toMatchObject({ status: 202, body: { error: "grounding_github_create_conflict" } });
  const after = await f.snapshot(); expect(after.task).toEqual(before.task); expect(after.fence).toEqual(before.fence);
  expect(after.operations[0]).toMatchObject({ state: "COMPLETED", observed: { number: 42 }, proofConflict: { source: "READ", conflicting: { number: 43 } } });
  expect(await f.restart().createOrResume(f.taskId, f.actor, "create", f.request)).toMatchObject({ status: 202, body: { error: "grounding_github_create_conflict" } });
  expect(f.create).toHaveBeenCalledTimes(1);
});

it.each(["pending", "completed"] as const)("CREATE-FIX revocation during %s read cannot bind or return saved success", async state => {
  if (state === "pending") f.create.mockRejectedValueOnce(new Error("uncertain"));
  await f.call(); const before = await f.snapshot();
  f.read.mockImplementationOnce(async (_request, _token, operationId) => {
    await f.db.agentToken.update({ where: { id: f.actor.tokenId }, data: { revokedAt: new Date() } });
    return { complete: true, pullRequests: [f.tagged(operationId)] };
  });
  await expect(f.call()).rejects.toMatchObject({ code: "forbidden" });
  const after = await f.snapshot();
  expect(after.fence).toMatchObject({ ownerId: before.fence?.ownerId, repo: before.fence?.repo });
  expect({ ...after, fence: before.fence }).toEqual(before); expect(f.create).toHaveBeenCalledTimes(1);
});

it("CREATE-FIX diagnostic audit failure rolls back conflict and comment; restart rechecks remote proof before saved201", async () => {
  expect((await f.call()).status).toBe(201); const before = await f.snapshot();
  await f.db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_create_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'github.pr_create_conflict' THEN RAISE EXCEPTION 'test_conflict_audit_failure'; END IF; RETURN NEW; END $$`);
  await f.db.$executeRawUnsafe('CREATE TRIGGER fail_create_binding BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_create_binding()');
  f.raw.number = 43; f.raw.html_url = `https://github.com/acme/${f.request.repo}/pull/43`;
  expect(await f.call()).toMatchObject({ status: 202, body: { error: "grounding_github_create_pending", state: "COMPLETED" } });
  expect(await f.snapshot()).toEqual(before); expect(await f.db.comment.count({ where: { taskId: f.taskId } })).toBe(0);
  await f.db.$executeRawUnsafe('DROP TRIGGER fail_create_binding ON audit_logs');
  expect(await f.restart().createOrResume(f.taskId, f.actor, "create", f.request)).toMatchObject({ status: 202, body: { error: "grounding_github_create_conflict" } });
  expect((await f.snapshot()).task).toEqual(before.task); expect(f.create).toHaveBeenCalledTimes(1);
});

it("CREATE-FIX default provider appends persisted correlation without changing request fingerprint and reads it on restart", async () => {
  const fetcher = vi.fn<typeof fetch>(); let wireBody = "";
  fetcher.mockImplementation(async (_url, options) => {
    if (options?.method === "POST") {
      wireBody = JSON.parse(String(options.body)).body;
      throw new Error("response lost after remote create");
    }
    return Response.json([{ ...f.raw, body: wireBody }]);
  });
  vi.stubGlobal("fetch", fetcher);
  const service = new GroundingGithubCreateService({ db: f.db });
  const original = structuredClone(f.request);
  expect((await service.createOrResume(f.taskId, f.actor, "wire-key", f.request)).status).toBe(202);
  const reserved = (await f.snapshot()).operations[0]!;
  expect(wireBody).toBe(`${f.request.body}\n\n${githubCreateCorrelationMarker(reserved.id)}`);
  expect(reserved.request).toEqual(original); expect(f.request).toEqual(original);
  const retry = new GroundingGithubCreateService({ db: store.connect() });
  expect((await retry.createOrResume(f.taskId, f.actor, "wire-key", f.request)).status).toBe(201);
  expect((await f.snapshot()).operations[0]?.fingerprint).toBe(reserved.fingerprint);
  expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET"]);
  await expect(retry.createOrResume(f.taskId, f.actor, "wire-key", { ...f.request, body: wireBody })).rejects.toMatchObject({ code: "grounding_operation_conflict" });
});

it.each([false, true])("CREATE-FIX completion between observation and binding rechecks proof; changed stored proof=%s", async changed => {
  const service = new GroundingGithubCreateService({ db: store.connect(), provider: f.provider });
  const observation = service as unknown as { remember(...args: unknown[]): Promise<unknown> };
  const remember = observation.remember.bind(observation); const gate = barrier();
  vi.spyOn(observation, "remember").mockImplementationOnce(async (...args) => { const result = await remember(...args); await gate.wait(); return result; });
  const first = service.createOrResume(f.taskId, f.actor, "create", f.request); await gate.reached;
  let completed: Awaited<ReturnType<typeof f.snapshot>>;
  try {
    expect((await f.call()).status).toBe(201); completed = await f.snapshot();
    if (changed) {
      const proof = completed.operations[0]!.observed as Record<string, string | number>;
      await f.db.groundingGithubCreateOperation.update({ where: { id: completed.operations[0]!.id }, data: { observed: { ...proof, number: 43, url: `https://github.com/acme/${f.request.repo}/pull/43` } } });
    }
  } finally { gate.release(); }
  const result = await first;
  expect(result).toMatchObject(changed ? { status: 202, body: { error: "grounding_github_create_conflict" } } : { status: 201, body: { pullRequest: { number: 42 } } });
  const after = await f.snapshot(); expect(after.task).toEqual(completed!.task); expect(after.fence).toEqual(completed!.fence);
  expect(after.audits.filter(row => row.action === "github.pr_created")).toHaveLength(1); expect(f.create).toHaveBeenCalledTimes(1);
});

it("CREATE-FIX failed late-POST conflict audit cannot become saved success on restart", async () => {
  const gate = barrier();
  f.create.mockImplementationOnce(async (_request, _token, operationId) => { await gate.wait(); return f.tagged(operationId, { ...f.raw, number: 43, html_url: `https://github.com/acme/${f.request.repo}/pull/43` }); });
  const first = f.call(); await gate.reached;
  let before: Awaited<ReturnType<typeof f.snapshot>>;
  try {
    expect((await f.restart().createOrResume(f.taskId, f.actor, "create", f.request)).status).toBe(201); before = await f.snapshot();
    await f.db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_create_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'github.pr_create_conflict' THEN RAISE EXCEPTION 'test_late_conflict_audit_failure'; END IF; RETURN NEW; END $$`);
    await f.db.$executeRawUnsafe('CREATE TRIGGER fail_create_binding BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_create_binding()');
  } finally { gate.release(); }
  expect(await first).toMatchObject({ status: 202, body: { error: "grounding_github_create_pending", state: "COMPLETED" } });
  expect(await f.snapshot()).toEqual(before!); expect(await f.db.comment.count({ where: { taskId: f.taskId } })).toBe(0);
  await f.db.$executeRawUnsafe('DROP TRIGGER fail_create_binding ON audit_logs');
  f.raw.number = 43; f.raw.html_url = `https://github.com/acme/${f.request.repo}/pull/43`;
  expect(await f.restart().createOrResume(f.taskId, f.actor, "create", f.request)).toMatchObject({ status: 202, body: { error: "grounding_github_create_conflict" } });
  expect((await f.snapshot()).task).toEqual(before!.task); expect(f.create).toHaveBeenCalledTimes(1);
});
