import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Prisma, type PrismaClient } from "@prisma/client";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
const shared = vi.hoisted(() => ({ db: undefined as PrismaClient | undefined }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get: (_target, key) => {
  if (!shared.db) throw new Error("test database not connected");
  const value = Reflect.get(shared.db, key);
  return typeof value === "function" ? value.bind(shared.db) : value;
} }) }));
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { GROUNDING_POLICY } from "../../src/services/grounding-context.js";
import { groundingPostgres, barrier } from "../helpers/grounding-postgres.js";
import { actor, ids, session, epoch, headSha, testIssuer } from "../helpers/grounding-fixtures.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let service: GroundingAttemptsService;
let issuer: ReturnType<typeof testIssuer>;
let taskId: string;
let projectId: string;
let now: number;
let head: string;
let provider: ReturnType<typeof vi.fn<() => Promise<string>>>;
function makeService(client = db) {
  return new GroundingAttemptsService({ db: client, config: { audience: "consumer.test", trust: () => issuer.trust }, now: () => now, headProvider: () => provider() });
}
async function unchangedTask() {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  expect(task.status).toBe("in_progress"); expect(task.claimedByAgentId).toBe(ids.agent);
  expect(task.claimedByUserId).toBeNull(); expect(task.reviewClaimedByAgentId).toBeNull(); expect(task.result).toBeNull(); expect(task.autoMergeSha).toBeNull();
  expect(await db.groundingFinalization.count()).toBe(0);
}
async function snapshot() {
  return {
    binding: await db.groundingBinding.findUnique({ where: { taskId } }),
    attempts: await db.groundingAttempt.findMany({ where: { taskId }, orderBy: { id: "asc" } }),
    receipts: await db.groundingReceipt.findMany({ where: { taskId }, orderBy: { id: "asc" } }),
  };
}
async function blocked(operation: () => Promise<unknown>, code: string, original?: Awaited<ReturnType<typeof snapshot>>) {
  const before = original ?? await snapshot();
  await expect(operation()).rejects.toMatchObject({ code });
  expect(await snapshot()).toEqual(before);
  await unchangedTask();
}

/** Observe a real PostgreSQL wait on another connection before releasing the barrier. */
async function waitForLock(observer: PrismaClient, blockedPid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<{ wait_event_type: string | null }[]>`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${blockedPid}`;
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("second PostgreSQL connection never waited on the task lock");
}
async function separate() {
  const client = store.connect();
  const [{ pid }] = await client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return { client, pid, service: makeService(client) };
}

beforeAll(async () => {
  store = await groundingPostgres(); db = store.db; shared.db = db;
  await db.user.create({ data: { id: ids.user, login: "grounding-test" } });
  await db.team.create({ data: { id: ids.team, name: "Grounding", slug: "grounding" } });
  await db.teamMember.create({ data: { teamId: ids.team, userId: ids.user, role: "ADMIN" } });
  await db.agentToken.create({ data: { id: ids.agent, teamId: ids.team, createdById: ids.user, name: "Test", tokenHash: "grounding-test-hash", scopes: actor.scopes } });
}, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => {
  now = epoch; head = headSha; projectId = randomUUID(); taskId = randomUUID(); issuer = testIssuer([projectId]);
  provider = vi.fn(async () => head);
  await db.project.create({ data: { id: projectId, teamId: ids.team, name: "Test", slug: randomUUID(), githubRepo: "acme/repo" } });
  await db.task.create({ data: { id: taskId, projectId, title: "Exact task", description: "Server spec", templateData: { acceptanceCriteria: "exact" }, status: "in_progress", claimedByAgentId: ids.agent, branchName: "test/branch", prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42" } });
  service = makeService();
  await service.provision({ taskId, projectId, subjectMode: "CODE_HEAD" });
});

describe("protected issuance and atomic receipt persistence (PostgreSQL)", () => {
  it("returns producer-compatible exact challenge keys and persists only authenticated documentary evidence", async () => {
    const challenge = await service.issue(taskId, actor, "finish");
    expect(Object.keys(challenge).sort()).toEqual(["audience", "projectId", "taskId", "attemptId", "nonce", "contextRevision", "target", "subject", "policy", "createdAt", "expiresAt"].sort());
    expect(challenge.createdAt).toBe(epoch); expect(challenge.expiresAt).toBe(epoch + 900); expect(challenge.policy).toEqual(GROUNDING_POLICY);
    if (process.env.GROUNDING_CHALLENGE_EVIDENCE) writeFileSync(process.env.GROUNDING_CHALLENGE_EVIDENCE, JSON.stringify({ now, challenge }, null, 2));
    const raw = issuer.receipt(challenge);
    const result = await service.ingest(taskId, challenge.attemptId, actor, session, raw);
    expect(result).toMatchObject({ replayed: false, evidence: { evidenceOrigin: "agent_asserted" } });
    const stored = await db.groundingReceipt.findUniqueOrThrow({ where: { attemptId: challenge.attemptId } });
    expect(stored.wireBytes.equals(Buffer.from(raw))).toBe(true);
    expect(await db.groundingAttempt.findUnique({ where: { id: challenge.attemptId } })).toMatchObject({ sessionId: session.id, sessionRevision: session.revision });
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).requireGroundingForDebug).toBe(false);
    await unchangedTask();
  });
  it.each(["taskId", "projectId", "audience", "nonce", "contextRevision", "target", "subject", "session"])("N-05 rejects a valid signature over foreign %s and rolls nomination back", async field => {
    const challenge = await service.issue(taskId, actor, "finish");
    if (field === "projectId") issuer.trust[0].projectIds = [projectId, ids.project];
    if (field === "audience") issuer.trust[0].audiences = ["consumer.test", "another.consumer"];
    const overrides: Record<string, unknown> = {
      taskId: ids.task, projectId: ids.project, audience: "another.consumer", nonce: Buffer.alloc(32, 1).toString("base64url"), contextRevision: 2,
      target: { ...challenge.target, action: "merge" }, subject: { ...challenge.subject, digest: "c".repeat(64) }, session: { id: "other.session", revision: 2 },
    };
    await blocked(() => service.ingest(taskId, challenge.attemptId, actor, session, issuer.receipt(challenge, { [field]: overrides[field] })), "grounding_receipt_mismatch");
  });
  it("never overwrites a nomination/receipt and rolls back on bad signature, schema or failed assessment", async () => {
    const challenge = await service.issue(taskId, actor, "finish");
    const raw = issuer.receipt(challenge); const envelope = JSON.parse(raw); envelope.signature = Buffer.alloc(64).toString("base64url");
    await blocked(() => service.ingest(taskId, challenge.attemptId, actor, session, JSON.stringify(envelope)), "grounding_receipt_untrusted");
    await blocked(() => service.ingest(taskId, challenge.attemptId, actor, session, '{"duplicate":1,"duplicate":2}'), "grounding_receipt_invalid");
    const fail = issuer.receipt(challenge, { assessment: { outcome: "fail", evidenceOrigin: "agent_asserted", factCount: 0, claimAllowed: true, reasons: ["fact_missing"], dossierSha256: "b".repeat(64) } });
    await blocked(() => service.ingest(taskId, challenge.attemptId, actor, session, fail), "grounding_required");
    await service.ingest(taskId, challenge.attemptId, actor, session, raw);
    await blocked(() => service.ingest(taskId, challenge.attemptId, actor, { ...session, revision: 2 }, raw), "grounding_receipt_mismatch");
    await blocked(() => service.ingest(taskId, challenge.attemptId, actor, session, issuer.receipt(challenge)), "grounding_receipt_mismatch");
  });
  it.each(["description", "templateData", "title", "projectTemplate", "workflow", "projectRepo", "pr", "head", "policy", "protection"])("N-06 revalidates %s on upload and exact retry", async change => {
    const challenge = await service.issue(taskId, actor, "finish"); const raw = issuer.receipt(challenge);
    await service.ingest(taskId, challenge.attemptId, actor, session, raw);
    if (change === "description" || change === "title") await db.task.update({ where: { id: taskId }, data: { [change]: "Changed" } });
    if (change === "templateData") await db.task.update({ where: { id: taskId }, data: { templateData: { acceptanceCriteria: "changed" } } });
    if (change === "projectTemplate") await db.project.update({ where: { id: projectId }, data: { taskTemplate: { fields: { goal: true } } } });
    if (change === "workflow") await db.workflow.create({ data: { projectId, name: "Default", isDefault: true, definition: { initialState: "open", states: [{ name: "open", label: "Open", terminal: false }, { name: "in_progress", label: "Work", terminal: false }, { name: "review", label: "Review", terminal: false }, { name: "done", label: "Done", terminal: true }], transitions: [{ from: "open", to: "in_progress" }, { from: "in_progress", to: "review" }, { from: "review", to: "done" }] } } });
    if (change === "projectRepo") await db.project.update({ where: { id: projectId }, data: { githubRepo: "acme/other" } });
    if (change === "pr") await db.task.update({ where: { id: taskId }, data: { prNumber: 43, prUrl: "https://github.com/acme/repo/pull/43" } });
    if (change === "head") head = "c".repeat(40);
    if (change === "policy") await db.groundingBinding.update({ where: { taskId }, data: { policySha256: "c".repeat(64) } });
    if (change === "protection") await db.groundingBinding.update({ where: { taskId }, data: { protected: false } });
    const code = ["projectRepo", "policy", "protection"].includes(change) ? "grounding_verification_unavailable" : "grounding_receipt_mismatch";
    await blocked(() => service.ingest(taskId, challenge.attemptId, actor, session, raw), code);
  });
  it("increments context revision only when projected bytes change, keeps comments/metadata independent", async () => {
    const first = await service.issue(taskId, actor, "finish");
    await db.comment.create({ data: { taskId, content: "display only", authorUserId: ids.user } });
    await db.task.update({ where: { id: taskId }, data: { metadata: { debugFlavor: false, sessionId: "forged", pass: true, receipt: "fake" } } });
    const second = await service.issue(taskId, actor, "finish");
    expect(second.contextRevision).toBe(first.contextRevision); expect(second.subject).toEqual(first.subject);
    await db.task.update({ where: { id: taskId }, data: { title: "Changed spec" } });
    const third = await service.issue(taskId, actor, "finish");
    expect(third.contextRevision).toBe(first.contextRevision + 1); expect(third.subject.digest).not.toBe(first.subject.digest);
    expect((await db.groundingBinding.findUniqueOrThrow({ where: { taskId } })).protected).toBe(true);
    await unchangedTask();
  });
  it("N-07 metadata cannot enroll an unbound task or bypass its protected mode", async () => {
    const unbound = await db.task.create({ data: { projectId, title: "Unbound", status: "in_progress", claimedByAgentId: ids.agent, metadata: { debugFlavor: true, pass: true, sessionId: "fake", receipt: "fake" } } });
    await expect(service.issue(unbound.id, actor, "finish")).rejects.toMatchObject({ code: "grounding_not_provisioned" });
    expect(await db.groundingBinding.findUnique({ where: { taskId: unbound.id } })).toBeNull();
    await expect(service.provision({ taskId, projectId, subjectMode: "TASK_SPEC" })).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
    const challenge = await service.issue(taskId, actor, "finish");
    await db.task.update({ where: { id: taskId }, data: { metadata: { debugFlavor: false } } });
    await expect(service.ingest(taskId, challenge.attemptId, actor, session, "fake")).rejects.toMatchObject({ code: "grounding_receipt_invalid" });
    expect(await db.groundingReceipt.count({ where: { taskId } })).toBe(0);
  });
  it("N-08 exact expiry has no grace and exact retry cannot resurrect an expired receipt", async () => {
    const challenge = await service.issue(taskId, actor, "finish"); const raw = issuer.receipt(challenge);
    now = challenge.expiresAt - 1;
    await service.ingest(taskId, challenge.attemptId, actor, session, raw);
    now = challenge.expiresAt;
    await blocked(() => service.ingest(taskId, challenge.attemptId, actor, session, raw), "grounding_receipt_stale");
  });
  it("N-08 C01 freshness rejects future, pre-attempt, overlong and extended receipts", async () => {
    const challenge = await service.issue(taskId, actor, "finish");
    for (const overrides of [
      { evaluatedAt: epoch + 61, issuedAt: epoch + 61 },
      { evaluatedAt: epoch - 61, issuedAt: epoch - 61, expiresAt: epoch + 839 },
      { expiresAt: epoch + 901 },
    ]) {
      await expect(service.ingest(taskId, challenge.attemptId, actor, session, issuer.receipt(challenge, overrides))).rejects.toBeInstanceOf(Error);
      expect(await db.groundingReceipt.count({ where: { taskId } })).toBe(0);
      expect((await db.groundingAttempt.findUniqueOrThrow({ where: { id: challenge.attemptId } })).sessionId).toBeNull();
    }
    await service.ingest(taskId, challenge.attemptId, actor, session, issuer.receipt(challenge, { evaluatedAt: epoch - 60, issuedAt: epoch - 60, expiresAt: epoch + 840 }));
  });
  it("N-09 new issuance supersedes green immediately, including after a producer failure", async () => {
    const first = await service.issue(taskId, actor, "finish"); const raw = issuer.receipt(first);
    await service.ingest(taskId, first.attemptId, actor, session, raw);
    const next = await service.issue(taskId, actor, "finish");
    await expect(service.ingest(taskId, next.attemptId, actor, session, "producer failed")).rejects.toMatchObject({ code: "grounding_receipt_invalid" });
    await blocked(() => service.ingest(taskId, first.attemptId, actor, session, raw), "grounding_receipt_stale");
  });
  it("N-23 missing trust, malformed keys and provider failures roll back all protected storage", async () => {
    const originalTrust = issuer.trust;
    issuer.trust = [];
    await blocked(() => service.issue(taskId, actor, "finish"), "grounding_verification_unavailable");
    issuer.trust = [{ ...originalTrust[0], publicKeyPem: "invalid" }];
    await blocked(() => service.issue(taskId, actor, "finish"), "grounding_verification_unavailable");
    issuer.trust = originalTrust;
    provider.mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    await blocked(() => service.issue(taskId, actor, "finish"), "grounding_verification_unavailable");
    const challenge = await service.issue(taskId, actor, "finish"); const raw = issuer.receipt(challenge);
    await service.ingest(taskId, challenge.attemptId, actor, session, raw);
    issuer.trust[0].revoked = true;
    await blocked(() => service.ingest(taskId, challenge.attemptId, actor, session, raw), "grounding_verification_unavailable");
  });
  it("single-connection issue and ingest use real transaction-scoped GitHub delegation", async () => {
    const connection = await separate();
    await db.user.update({ where: { id: ids.user }, data: { githubAccessToken: "test-only", githubConnectedAt: new Date(), allowAgentPrCreate: true } });
    const fetcher = vi.fn(async () => Response.json({ number: 42, html_url: "https://github.com/acme/repo/pull/42", base: { repo: { full_name: "acme/repo" } }, head: { sha: headSha } }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const realProvider = new GroundingAttemptsService({ db: connection.client, config: { audience: "consumer.test", trust: () => issuer.trust }, now: () => now });
      const challenge = await realProvider.issue(taskId, actor, "finish");
      await realProvider.ingest(taskId, challenge.attemptId, actor, session, issuer.receipt(challenge));
      expect(fetcher).toHaveBeenCalledTimes(2);
      await unchangedTask();
    } finally {
      vi.unstubAllGlobals();
      await db.user.update({ where: { id: ids.user }, data: { githubAccessToken: null, githubConnectedAt: null, allowAgentPrCreate: false } });
    }
  });
  it("N-11 accepted bytes and tuple survive reconnect; identical retry is idempotent and changed wire conflicts", async () => {
    const challenge = await service.issue(taskId, actor, "finish"); const raw = issuer.receipt(challenge);
    await service.ingest(taskId, challenge.attemptId, actor, session, raw);
    const original = await snapshot();
    const connection = await separate();
    await connection.client.$disconnect();
    const restarted = makeService(store.connect());
    await expect(restarted.ingest(taskId, challenge.attemptId, actor, session, raw)).resolves.toMatchObject({ replayed: true });
    expect(await snapshot()).toEqual(original);
    await blocked(() => restarted.ingest(taskId, challenge.attemptId, actor, session, ` ${raw}`), "grounding_receipt_mismatch");
  });
  it("N-11 database uniqueness and same-task foreign keys reject direct duplicate/cross-task storage", async () => {
    const challenge = await service.issue(taskId, actor, "finish"); await service.ingest(taskId, challenge.attemptId, actor, session, issuer.receipt(challenge));
    const row = await db.groundingReceipt.findUniqueOrThrow({ where: { attemptId: challenge.attemptId } });
    await expect(db.groundingReceipt.create({ data: { ...row, id: randomUUID(), evidence: row.evidence as Prisma.InputJsonValue } })).rejects.toMatchObject({ code: "P2002" });
    const other = await db.task.create({ data: { projectId, title: "Other", status: "in_progress", claimedByAgentId: ids.agent } });
    await service.provision({ taskId: other.id, projectId, subjectMode: "TASK_SPEC" });
    const next = await service.issue(taskId, actor, "finish");
    await expect(db.groundingBinding.update({ where: { taskId: other.id }, data: { activeAttemptId: challenge.attemptId } })).rejects.toMatchObject({ code: "P2003" });
    await expect(service.ingest(taskId, next.attemptId, actor, session, issuer.receipt(next, { receiptId: row.id }))).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
    expect((await db.groundingAttempt.findUniqueOrThrow({ where: { id: next.attemptId } })).sessionId).toBeNull();
    await unchangedTask();
  });
});

describe("real controlled PostgreSQL interleavings", () => {
  it("concurrent issue serializes, retries CAS and leaves exactly one authoritative active attempt", async () => {
    const gate = barrier(); const other = await separate(); const observer = store.connect();
    const retryErrors: { code: string; sqlstate: unknown }[] = [];
    const transact = other.client.$transaction.bind(other.client);
    vi.spyOn(other.client, "$transaction").mockImplementation(((...args: unknown[]) =>
      Reflect.apply(transact, other.client, args).catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError) retryErrors.push({ code: error.code, sqlstate: error.meta?.code });
        throw error;
      })) as PrismaClient["$transaction"]);
    provider.mockImplementationOnce(async () => { await gate.wait(); return head; });
    const first = service.issue(taskId, actor, "finish"); await gate.reached;
    const second = other.service.issue(taskId, actor, "finish");
    try { await waitForLock(observer, other.pid); } finally { gate.release(); }
    const [a, b] = await Promise.all([first, second]);
    expect(a.attemptId).not.toBe(b.attemptId);
    expect(retryErrors).toContainEqual({ code: "P2010", sqlstate: "40001" });
    expect(await db.groundingAttempt.count({ where: { taskId, state: "ACTIVE" } })).toBe(1);
    expect(await db.groundingAttempt.findUnique({ where: { id: a.attemptId } })).toMatchObject({ state: "SUPERSEDED" });
    expect(await db.groundingBinding.findUnique({ where: { taskId } })).toMatchObject({ activeAttemptId: b.attemptId });
    await unchangedTask();
  }, 15000);
  it("concurrent identical uploads nominate and create once; waiter returns immutable persisted retry", async () => {
    const challenge = await service.issue(taskId, actor, "finish"); const raw = issuer.receipt(challenge);
    const gate = barrier(); const other = await separate(); const observer = store.connect();
    provider.mockImplementationOnce(async () => { await gate.wait(); return head; });
    const first = service.ingest(taskId, challenge.attemptId, actor, session, raw); await gate.reached;
    const second = other.service.ingest(taskId, challenge.attemptId, actor, session, raw);
    try { await waitForLock(observer, other.pid); } finally { gate.release(); }
    const results = await Promise.all([first, second]);
    expect(results.map(r => r.replayed)).toEqual([false, true]);
    expect(await db.groundingReceipt.count({ where: { taskId } })).toBe(1); await unchangedTask();
  }, 15000);
  it("concurrent competing session nominations have one winner and one mismatch", async () => {
    const challenge = await service.issue(taskId, actor, "finish"); const raw = issuer.receipt(challenge);
    const otherSession = { id: "other.session", revision: 2 }; const otherRaw = issuer.receipt(challenge, { session: otherSession });
    const gate = barrier(); const other = await separate(); const observer = store.connect();
    provider.mockImplementationOnce(async () => { await gate.wait(); return head; });
    const first = service.ingest(taskId, challenge.attemptId, actor, session, raw); await gate.reached;
    const second = other.service.ingest(taskId, challenge.attemptId, actor, otherSession, otherRaw);
    const rejected = expect(second).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
    try { await waitForLock(observer, other.pid); } finally { gate.release(); }
    await first; await rejected;
    expect((await db.groundingAttempt.findUniqueOrThrow({ where: { id: challenge.attemptId } })).sessionId).toBe(session.id);
    expect(await db.groundingReceipt.count({ where: { taskId } })).toBe(1); await unchangedTask();
  }, 15000);
  it("a context update winning the task lock rejects the old upload after the waiter resumes", async () => {
    const challenge = await service.issue(taskId, actor, "finish"); const raw = issuer.receipt(challenge);
    const gate = barrier(); const updater = store.connect(); const other = await separate(); const observer = store.connect();
    const update = updater.$transaction(async tx => {
      await tx.task.update({ where: { id: taskId }, data: { description: "changed while competing" } });
      await gate.wait();
    });
    await gate.reached;
    const upload = other.service.ingest(taskId, challenge.attemptId, actor, session, raw);
    const rejected = expect(upload).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
    try { await waitForLock(observer, other.pid); } finally { gate.release(); }
    await update; await rejected;
    expect(await db.groundingReceipt.count({ where: { taskId } })).toBe(0); await unchangedTask();
  }, 15000);
});
