import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
const harness = vi.hoisted(() => ({ db: null as PrismaClient | null, wrapper: { start: vi.fn(), getLedgerSummary: vi.fn() }, bounce: vi.fn(), terminal: vi.fn() }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get: (_target, property) => { const value = Reflect.get(harness.db!, property); return typeof value === "function" ? value.bind(harness.db) : value; } }) }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("../../src/services/grounding-client.js", () => ({ getGroundingClient: () => harness.wrapper }));
vi.mock("../../src/services/confidence-telemetry.js", () => ({ recordBounceBack: harness.bounce, recordTerminalSnapshot: harness.terminal }));
import { createApp } from "../../src/app.js";
import { completionStore, completionFixture, completionActor as actor } from "../helpers/grounding-completion-fixtures.js";
import { ids, session } from "../helpers/grounding-fixtures.js";
import { GroundingAttemptsService, type GroundingChallenge } from "../../src/services/grounding-attempts.js";
import { GroundingFinalizationService } from "../../src/services/grounding-finalization.js";
import { barrier } from "../helpers/grounding-postgres.js";
import * as audit from "../../src/services/audit.js";
import * as checks from "../../src/services/github-checks.js";
import { defaultWorkflowDefinition } from "../../src/services/default-workflow.js";
import { createSessionToken } from "../../src/services/session.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
const token = "grounding-route-test-token";
beforeAll(async () => {
  store = await completionStore(); harness.db = store.db;
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { tokenHash: createHash("sha256").update(token).digest("hex") } });
}, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => {
  vi.stubEnv("REDIS_URL", "");
  // Even a deliberately bypassed guard must not reach an external service.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("outbound fetch disabled in grounding route fixture")));
  await store.db.groundingBinding.updateMany({ data: { activeAttemptId: null } });
  await store.db.groundingCohort.updateMany({ data: { reservationId: null } });
  await store.db.groundingFinalization.deleteMany(); await store.db.groundingOperation.deleteMany();
  await store.db.groundingReceipt.deleteMany(); await store.db.groundingAttempt.deleteMany();
  await store.db.groundingBinding.deleteMany(); await store.db.groundingCohort.deleteMany();
  await store.db.task.deleteMany(); await store.db.project.deleteMany();
  f = await completionFixture(store); f.ledger.getLedgerSummary.mockRejectedValue(new Error("legacy must not run"));
  harness.wrapper.start.mockReset().mockRejectedValue(new Error("wrapper must not run"));
  harness.wrapper.getLedgerSummary.mockReset().mockRejectedValue(new Error("legacy must not run"));
  harness.bounce.mockReset().mockResolvedValue(undefined); harness.terminal.mockReset().mockResolvedValue(undefined);
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: [...actor.scopes, "tasks:read"], revokedAt: null } });
  await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrCreate: true, allowAgentPrMerge: true } });
});
afterEach(async () => { await checks._clearCheckCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function app(service = f.service) { return createApp("http://localhost", f.attempts, { db: store.db, service }); }
function request(body: unknown = {}, endpoint = "finish", key: string | null = "operation", authorization: string | null = token) {
  return new Request(`http://localhost/api/tasks/${f.taskId}/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}), ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) }, body: JSON.stringify(body) });
}
async function snapshot() { return { ...await f.snapshot(), signals: await store.db.signal.findMany({ where: { taskId: f.taskId }, orderBy: { id: "asc" } }), comments: await store.db.comment.findMany({ where: { taskId: f.taskId }, orderBy: { id: "asc" } }) }; }
const variants = ["work", "review", "self_approve", "mode_a", "mode_b_review", "mode_b_self", "task_merge", "midflight"] as const;
type Variant = typeof variants[number];
async function setup(variant: Variant, requires: string[] = []) {
  const direct = ["mode_a", "midflight"].includes(variant);
  const review = !direct && variant !== "work";
  if (direct) {
    await store.db.project.update({ where: { id: f.projectId }, data: { governanceMode: "AUTONOMOUS" } });
    await store.db.workflow.create({ data: { projectId: f.projectId, name: "Direct", isDefault: true, definition: { initialState: "open", states: [{ name: "open", label: "Open", terminal: false }, { name: "in_progress", label: "Work", terminal: false }, { name: "done", label: "Done", terminal: true }], transitions: [{ from: "open", to: "in_progress" }, { from: "in_progress", to: "done", requires }] } } });
  } else if (requires.length) {
    const definition = defaultWorkflowDefinition();
    for (const edge of definition.transitions) if (edge.to === "done") edge.requires = requires;
    await store.db.workflow.create({ data: { projectId: f.projectId, name: "Gated", isDefault: true, definition: definition as object } });
  }
  if (review) await store.db.task.update({ where: { id: f.taskId }, data: { status: "review", ...(["review", "mode_b_review"].includes(variant) ? { claimedByAgentId: null, claimedByUserId: ids.user, reviewClaimedByAgentId: ids.agent } : {}) } });
  if (variant === "midflight") await store.db.task.update({ where: { id: f.taskId }, data: { autoMergeSha: "b".repeat(40) } });
  const remote = ["mode_a", "mode_b_review", "mode_b_self", "task_merge", "midflight"].includes(variant);
  const intent = variant === "task_merge" ? "merge" : review ? "approve" : "finish";
  const body = variant === "task_merge" ? {} : { result: "Original result", ...(review ? { outcome: "approve" } : {}), ...(remote ? { autoMerge: true } : {}) };
  return { intent, remote, body, endpoint: variant === "task_merge" ? "merge" : "finish", target: variant === "work" ? "review" : "done" } as const;
}

for (const variant of variants) it.each(["missing", "wrong", "valid"])(`N-01/N-07/N-12 mounted ${variant} with %s receipt`, async evidence => {
  const v = await setup(variant);
  await store.db.task.update({ where: { id: f.taskId }, data: { metadata: { debugFlavor: false, groundingSessionId: "forged-session", pass: true, groundingPhase: "claim-evaluation" } } });
  if (evidence !== "missing") await f.evidence(v.intent);
  if (evidence === "wrong") f.head = "c".repeat(40);
  const before = await snapshot();
  const response = await app().fetch(request(v.body, v.endpoint));
  if (evidence !== "valid") {
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: evidence === "missing" ? "grounding_required" : "grounding_receipt_mismatch", groundingHint: { attempts: { issue: { body: { intent: v.intent } } } } });
    expect(await snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled(); expect(f.deliverSignal).not.toHaveBeenCalled();
  } else {
    expect(response.status).toBe(200); const body = await response.json();
    expect(body).toMatchObject({ task: { status: v.target, ...(v.target === "done" ? { claimedByAgentId: null, claimedByUserId: null, reviewClaimedByAgentId: null } : { claimedByAgentId: ids.agent }) } });
    const after = await snapshot(); expect(after.operations).toHaveLength(1); expect(after.finalizations).toHaveLength(1); expect(after.attempts[0].state).toBe("CONSUMED");
    expect(f.merge).toHaveBeenCalledTimes(v.remote ? 1 : 0);
    expect(await (await app().fetch(request(v.body, v.endpoint))).json()).toEqual(body);
    expect(await snapshot()).toEqual(after);
  }
  expect(harness.wrapper.start).not.toHaveBeenCalled(); expect(harness.wrapper.getLedgerSummary).not.toHaveBeenCalled(); expect(f.ledger.getLedgerSummary).not.toHaveBeenCalled();
});

it("N-09 new attempt with failed producer cannot reuse the previous passing receipt", async () => {
  await f.evidence(); const old = await f.snapshot();
  await f.attempts.issue(f.taskId, actor, "finish");
  const before = await snapshot(); expect(before.attempts).toHaveLength(2); expect(before.receipts[0].id).toBe(old.receipts[0].id);
  const response = await app().fetch(request());
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "grounding_required" });
  expect(await snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
});

it("N-11 normalized transport history precedes new status/claims; actor/body/endpoint changes conflict", async () => {
  await setup("self_approve"); await f.evidence("approve");
  const a = app(); const response = await a.fetch(request({ outcome: "approve", result: "Exact" })); expect(response.status).toBe(200); const body = await response.json();
  const committed = await snapshot(); f.now += 10000; f.issuer.trust = [];
  expect(await (await a.fetch(request({ mergeMethod: "squash", autoMerge: false, result: "Exact", outcome: "approve" }))).json()).toEqual(body);
  expect((await a.fetch(request({ outcome: "approve", result: "Other" }))).status).toBe(409);
  expect((await a.fetch(request({}, "merge"))).status).toBe(409);
  const otherToken = "other-grounding-test-token";
  await store.db.agentToken.create({ data: { id: randomUUID(), teamId: ids.team, createdById: ids.user, name: "Other", tokenHash: createHash("sha256").update(otherToken).digest("hex"), scopes: actor.scopes } });
  expect((await a.fetch(request({ outcome: "approve", result: "Exact" }, "finish", "operation", otherToken))).status).toBe(403);
  expect(await snapshot()).toEqual(committed); expect(harness.terminal).toHaveBeenCalledOnce();
});

it.each([true, false])("N-11 concurrent completion with sameKey=%s consumes once; calibration belongs only to committing invocation", async sameKey => {
  await setup("review"); await f.evidence("approve");
  const first = app(); const second = app(f.make(store.connect()));
  const responses = await Promise.all([first.fetch(request({ outcome: "approve" })), second.fetch(request({ outcome: "approve" }, "finish", sameKey ? "operation" : "second"))]);
  expect(responses.filter(r => r.status === 200)).toHaveLength(sameKey ? 2 : 1);
  expect(responses.filter(r => r.status !== 200).every(r => [403, 409].includes(r.status))).toBe(true);
  const after = await snapshot(); expect(after.operations).toHaveLength(1); expect(after.finalizations).toHaveLength(1); expect(after.signals.filter(s => s.type === "task_approved")).toHaveLength(1);
  expect(harness.terminal).toHaveBeenCalledOnce();
  const deliveries = f.deliverSignal.mock.calls.length;
  await first.fetch(request({ outcome: "approve" }));
  expect(f.deliverSignal).toHaveBeenCalledTimes(deliveries); expect(harness.terminal).toHaveBeenCalledOnce();
});

it("calibration observer failure preserves committed success and does not retry on history", async () => {
  await setup("self_approve"); await f.evidence("approve"); harness.terminal.mockRejectedValue(new Error("telemetry unavailable"));
  const a = app(); const first = await a.fetch(request({ outcome: "approve" })); expect(first.status).toBe(200);
  const body = await first.json(); const committed = await snapshot();
  expect(await (await a.fetch(request({ outcome: "approve" }))).json()).toEqual(body); expect(await snapshot()).toEqual(committed); expect(harness.terminal).toHaveBeenCalledOnce();
});

it.each(["timeout", "database"])("N-13 remote %s recovery retains original route/receipt after expiry and never redispatches", async failure => {
  const v = await setup("mode_b_review"); await f.evidence(v.intent);
  let hook: ReturnType<typeof vi.spyOn> | undefined;
  if (failure === "timeout") f.merge.mockImplementationOnce(async () => { f.proof = { ...f.proof, merged: true, mergeCommitSha: "b".repeat(40) }; throw new Error("lost response"); });
  else hook = vi.spyOn(audit, "logGroundingDecision").mockRejectedValueOnce(new Error("database unavailable"));
  const first = await app().fetch(request(v.body)); hook?.mockRestore();
  expect(first.status).toBe(failure === "timeout" ? 202 : 503);
  expect((await snapshot()).operations[0].state).toBe("DISPATCHED"); expect((await f.task()).status).toBe("review"); expect(f.deliverSignal).not.toHaveBeenCalled(); expect(harness.terminal).not.toHaveBeenCalled();
  f.now += 10000; f.issuer.trust = [];
  const restarted = app(f.make(store.connect())); const recovered = await restarted.fetch(request(v.body));
  expect(recovered.status).toBe(200); expect(await recovered.json()).toMatchObject({ kind: "review", outcome: "approve", autoMergeSha: "b".repeat(40) });
  const after = await snapshot(); await restarted.fetch(request(v.body));
  expect(await snapshot()).toEqual(after); expect(f.merge).toHaveBeenCalledOnce(); expect(harness.terminal).toHaveBeenCalledOnce();
});

it("N-13 wrong source-head recovery proof remains pending and cannot consume reserved receipt", async () => {
  const v = await setup("mode_a"); await f.evidence(v.intent); f.merge.mockRejectedValueOnce(new Error("uncertain"));
  expect((await app().fetch(request(v.body))).status).toBe(202);
  f.proof = { ...f.proof, merged: true, headSha: "c".repeat(40), mergeCommitSha: "b".repeat(40) };
  const before = await snapshot(); expect((await app(f.make(store.connect())).fetch(request(v.body))).status).toBe(202);
  expect(await snapshot()).toEqual(before); expect(f.merge).toHaveBeenCalledOnce();
});

it("N-12 fresh terminal merge with naked autoMergeSha has no durable authority", async () => {
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "done", autoMergeSha: "b".repeat(40) } });
  const before = await snapshot(); const response = await app().fetch(request({}, "merge"));
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "bad_state" }); expect(await snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
});

it.each(["abandon", "request_changes"])("N-16 mounted %s needs no pass, invalidates active generation, persists audit and retries", async action => {
  if (action === "request_changes") await setup("review");
  await f.attempts.issue(f.taskId, actor, action === "request_changes" ? "approve" : "finish");
  const a = app(); const endpoint = action === "abandon" ? "abandon" : "finish"; const body = action === "abandon" ? {} : { outcome: "request_changes", result: "Needs changes" };
  const response = await a.fetch(request(body, endpoint)); expect(response.status).toBe(200);
  const json = await response.json(); const after = await snapshot(); expect(after.binding).toMatchObject({ activeAttemptId: null, contextRevision: 2 }); expect(after.attempts[0].state).toBe("SUPERSEDED"); expect(after.audit.some(a => a.action === "task.grounding.disposed")).toBe(true);
  expect(await (await a.fetch(request(body, endpoint))).json()).toEqual(json); expect(await snapshot()).toEqual(after);
  expect(harness.bounce).toHaveBeenCalledTimes(action === "request_changes" ? 1 : 0);
});

it("N-16 pending remote reservation blocks dispositions and competing completion without effects", async () => {
  const v = await setup("mode_b_review"); await f.evidence(v.intent); f.merge.mockRejectedValueOnce(new Error("uncertain"));
  expect((await app().fetch(request(v.body))).status).toBe(202); const before = await snapshot();
  for (const [endpoint, body] of [["abandon", {}], ["finish", { outcome: "request_changes" }], ["finish", { outcome: "approve" }]] as const) {
    const response = await app().fetch(request(body, endpoint, randomUUID())); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "grounding_finalization_pending" });
  }
  expect(await snapshot()).toEqual(before);
});

it.each(["missing-service", "orphan-binding", "missing-binding", "invalid-cohort", "database"])("provisioned admission %s fails closed without entering legacy routes", async denial => {
  await f.evidence();
  if (denial === "orphan-binding") await store.db.groundingCohort.delete({ where: { taskId: f.taskId } });
  if (denial === "missing-binding") {
    await store.db.groundingBinding.update({ where: { taskId: f.taskId }, data: { activeAttemptId: null } });
    await store.db.groundingReceipt.deleteMany({ where: { taskId: f.taskId } }); await store.db.groundingAttempt.deleteMany({ where: { taskId: f.taskId } });
    await store.db.groundingBinding.delete({ where: { taskId: f.taskId } });
  }
  if (denial === "invalid-cohort") await store.db.groundingCohort.update({ where: { taskId: f.taskId }, data: { protected: false } });
  const before = await snapshot();
  const hook = denial === "database" ? vi.spyOn(store.db, "$transaction").mockRejectedValueOnce(new Error("database unavailable")) : null;
  const a = denial === "missing-service" ? createApp("", f.attempts, { db: store.db }) : app();
  const response = await a.fetch(request()); hook?.mockRestore();
  expect(response.status).toBe(503); expect(await snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled(); expect(harness.wrapper.start).not.toHaveBeenCalled();
});

it("per-app trusted injection cannot leak completion capability into another app", async () => {
  await f.evidence(); const ready = app(); const unconfigured = createApp("", f.attempts, { db: store.db });
  expect((await unconfigured.fetch(request())).status).toBe(503);
  expect((await ready.fetch(request())).status).toBe(200);
  expect((await unconfigured.fetch(request())).status).toBe(503);
});

it("provisioned admission checks auth/write/scope and explicit operation key", async () => {
  const a = app(); const before = await snapshot();
  expect((await a.fetch(request({}, "finish", "operation", null))).status).toBe(401);
  expect((await a.fetch(request({}, "finish", null))).status).toBe(400);
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: [] } });
  expect((await a.fetch(request())).status).toBe(403);
  const missing = request();
  expect((await a.fetch(new Request(missing.url.replace(f.taskId, randomUUID()), missing))).status).toBe(403);
  expect(await snapshot()).toEqual(before);
});

it("bound inline PR is accepted and a different PR returns bind-before-assessment guidance", async () => {
  await f.evidence(); const before = await snapshot();
  const denial = await app().fetch(request({ prUrl: "https://github.com/acme/repo/pull/99" })); expect(denial.status).toBe(409); expect(await denial.json()).toMatchObject({ message: expect.stringContaining("Bind the authoritative task PR") }); expect(await snapshot()).toEqual(before);
  expect((await app().fetch(request({ prUrl: "https://github.com/acme/repo/pull/42" }))).status).toBe(200);
});

it.each(["mode_a", "mode_b_review", "mode_b_self", "task_merge"] as const)("mounted %s retains CI-head denial before a merge", async variant => {
  const v = await setup(variant, ["ciGreen", "prMerged"]);
  vi.spyOn(checks, "fetchCheckRunStatus").mockResolvedValue({ state: "success", sha: "c".repeat(40), total: 1, successful: 1, failing: 0, pending: 0 });
  await f.evidence(v.intent); const before = await snapshot();
  const response = await app().fetch(request(v.body, v.endpoint)); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "precondition_failed" }); expect(await snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
});

it("mounted distinct-reviewer/self-merge governance still blocks claimant approval and merge", async () => {
  await setup("mode_b_self"); await f.evidence("approve");
  await store.db.project.update({ where: { id: f.projectId }, data: { governanceMode: "REQUIRES_DISTINCT_REVIEWER" } }); const before = await snapshot();
  expect((await app().fetch(request({ outcome: "approve", autoMerge: true }))).status).toBe(403);
  expect((await app().fetch(request({}, "merge", "merge"))).status).toBe(403);
  expect(await snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
});

it("remote same-key concurrent request never dispatches twice while provider is pending", async () => {
  const v = await setup("mode_a"); await f.evidence(v.intent); const gate = barrier();
  f.merge.mockImplementationOnce(async () => { await gate.wait(); f.proof = { ...f.proof, merged: true, mergeCommitSha: "b".repeat(40) }; });
  const first = app().fetch(request(v.body)); await gate.reached;
  const duplicate = await app(f.make(store.connect())).fetch(request(v.body)); expect(duplicate.status).toBe(202);
  gate.release(); expect((await first).status).toBe(200); expect(f.merge).toHaveBeenCalledOnce();
});

it("N-01 external pickup/start/completion works while wrapper and legacy ledger are unavailable", async () => {
  await store.db.project.update({ where: { id: f.projectId }, data: { enforcementMode: "OFF", requireGroundingForDebug: true } });
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "open", claimedByAgentId: null, metadata: { debugFlavor: true } } });
  const a = app();
  const pickup = await a.fetch(new Request("http://localhost/api/tasks/pickup", { method: "POST", headers: { Authorization: `Bearer ${token}` } }));
  expect(pickup.status).toBe(200); expect(await pickup.json()).toMatchObject({ groundingHint: { kind: "external_grounding_v1", taskId: f.taskId } });
  const start = await a.fetch(request({}, "start", null)); expect(start.status).toBe(200);
  const started = await start.json(); expect(started).toMatchObject({ groundingHint: { kind: "external_grounding_v1", completion: { requiredHeader: "Idempotency-Key" } } });
  expect(JSON.stringify(started)).not.toContain("mcp__grounding-mcp__grounding_start");
  expect((await f.task()).metadata).toEqual({ debugFlavor: true });
  await f.evidence(); expect((await a.fetch(request())).status).toBe(200);
  expect(harness.wrapper.start).not.toHaveBeenCalled(); expect(harness.wrapper.getLedgerSummary).not.toHaveBeenCalled(); expect(f.ledger.getLedgerSummary).not.toHaveBeenCalled();
});

it("N-01 external reviewer pickup/start and idempotent start carry the approve intent without a second session", async () => {
  await store.db.project.update({ where: { id: f.projectId }, data: { enforcementMode: "OFF", requireGroundingForDebug: true } });
  const creator = await store.db.agentToken.create({ data: { teamId: ids.team, createdById: ids.user, name: "Review author", tokenHash: randomUUID(), scopes: actor.scopes } });
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "review", claimedByAgentId: null, claimedByUserId: ids.user, createdByAgentId: creator.id, metadata: { debugFlavor: true } } });
  const a = app();
  const pickup = await a.fetch(new Request("http://localhost/api/tasks/pickup", { method: "POST", headers: { Authorization: `Bearer ${token}` } }));
  expect(pickup.status).toBe(200); expect(await pickup.json()).toMatchObject({ groundingHint: { kind: "external_grounding_v1", attempts: { issue: { body: { intent: "approve" } } } } });
  const start = await a.fetch(request({}, "start", null)); expect(start.status).toBe(200);
  expect(await start.json()).toMatchObject({ groundingHint: { kind: "external_grounding_v1", attempts: { issue: { body: { intent: "approve" } } } } });
  await f.evidence("approve"); const before = await snapshot();
  const retry = await a.fetch(request({}, "start", null)); expect(retry.status).toBe(200);
  const retried = await retry.json(); expect(retried).toMatchObject({ groundingHint: { kind: "external_grounding_v1", attempts: { issue: { body: { intent: "approve" } } } } });
  expect(JSON.stringify(retried)).not.toContain("mcp__grounding-mcp__grounding_start"); expect(await snapshot()).toEqual(before);
  expect((await a.fetch(request({ outcome: "approve" }))).status).toBe(200);
  expect((await f.task()).metadata).toEqual({ debugFlavor: true });
  expect(harness.wrapper.start).not.toHaveBeenCalled(); expect(harness.wrapper.getLedgerSummary).not.toHaveBeenCalled();
});

it("only UNPROVISIONED admission enters actual compatibility finish without a key or injected service", async () => {
  await store.db.groundingBinding.delete({ where: { taskId: f.taskId } }); await store.db.groundingCohort.delete({ where: { taskId: f.taskId } });
  await store.db.task.update({ where: { id: f.taskId }, data: { metadata: { debugFlavor: false } } });
  const response = await createApp("").fetch(request({}, "finish", null)); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ kind: "work", targetStatus: "review" });
  // Wait for the compatibility route's existing best-effort writes before disposing the fixture.
  await vi.waitFor(async () => { expect(await store.db.comment.count({ where: { taskId: f.taskId } })).toBe(1); expect(await store.db.auditLog.count({ where: { taskId: f.taskId, action: "task.reviewed" } })).toBe(1); });
  expect((await snapshot()).operations).toHaveLength(0);
});

it.each(["OFF", "LEGACY_LOCAL"] as const)("explicit %s remains keyed service policy rather than unprovisioned compatibility", async mode => {
  f = await completionFixture(store, mode);
  expect((await app().fetch(request({}, "finish", null))).status).toBe(400);
  const response = await app().fetch(request()); expect(response.status).toBe(200);
  const after = await snapshot(); expect(after.operations).toHaveLength(1); expect(after.receipts).toHaveLength(0);
  expect(f.ledger.getLedgerSummary).toHaveBeenCalledTimes(mode === "LEGACY_LOCAL" ? 1 : 0);
  expect(harness.wrapper.start).not.toHaveBeenCalled();
});

it("project write authorization precedes malformed/keyless request details and effects", async () => {
  const foreignTeam = await store.db.team.create({ data: { name: "Foreign", slug: randomUUID() } });
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { teamId: foreignTeam.id } });
  const before = await snapshot();
  try { expect((await app().fetch(request({}, "finish", null))).status).toBe(403); }
  finally { await store.db.agentToken.update({ where: { id: ids.agent }, data: { teamId: ids.team } }); }
  expect(await snapshot()).toEqual(before);
});

const contextWriters = ["claim", "release", "review/claim", "review/release", "admin-release", "creator-abandon", "reopen"] as const;
type ContextWriter = typeof contextWriters[number];
async function contextWriter(writer: ContextWriter) {
  // Preserve an active generation from the previous working context. These
  // fixture writes arrange each direct route's admission state, without using
  // the mutation helper whose wiring the request below must exercise.
  await f.attempts.issue(f.taskId, actor, "finish");
  if (["claim", "creator-abandon", "reopen"].includes(writer)) {
    await store.db.task.update({ where: { id: f.taskId }, data: { status: writer === "reopen" ? "abandoned" : "open", claimedByAgentId: null } });
  }
  if (writer.startsWith("review/")) {
    await store.db.task.update({ where: { id: f.taskId }, data: { status: "review", claimedByAgentId: null, claimedByUserId: ids.user, reviewClaimedByAgentId: writer === "review/release" ? ids.agent : null } });
  }
  const authorization = ["admin-release", "reopen"].includes(writer)
    ? await createSessionToken(ids.user, "test-secret-which-is-long-enough-1234") : token;
  return () => writer === "reopen"
    ? new Request(`http://localhost/api/tasks/${f.taskId}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${authorization}` }, body: JSON.stringify({ status: "open" }) })
    : request(writer === "admin-release" ? { releaseWorkClaim: true } : {}, writer, null, authorization);
}

it.each(contextWriters)("N-16 actual %s writer supersedes generation without requiring a positive receipt", async writer => {
  const makeRequest = await contextWriter(writer); const before = await snapshot();
  const response = await app().fetch(makeRequest()); expect(response.status).toBe(200);
  const after = await snapshot();
  expect(after.binding).toMatchObject({ activeAttemptId: null, contextRevision: before.binding!.contextRevision + 1 });
  expect(after.attempts[0]).toMatchObject({ id: before.attempts[0].id, state: "SUPERSEDED" });
  expect(after.receipts).toHaveLength(0); expect(after.operations).toHaveLength(0); expect(after.finalizations).toHaveLength(0);
  const expected = {
    claim: { status: "in_progress", claimedByAgentId: ids.agent },
    release: { status: "open", claimedByAgentId: null },
    "review/claim": { status: "review", reviewClaimedByAgentId: ids.agent },
    "review/release": { status: "review", reviewClaimedByAgentId: null },
    "admin-release": { status: "in_progress", claimedByAgentId: null },
    "creator-abandon": { status: "abandoned", claimedByAgentId: null },
    reopen: { status: "open", claimedByAgentId: null },
  }[writer];
  expect(after.task).toMatchObject(expected);
  const contextAudit = await store.db.auditLog.findMany({ where: { projectId: f.projectId, action: "project.grounding.context_mutated" } });
  expect(contextAudit).toHaveLength(1);
  const routeAudit = { claim: "task.claimed", release: "task.released", "review/claim": "task.reviewed", "review/release": "task.reviewed", "admin-release": "task.claim_released_by_admin", "creator-abandon": "task.creator_abandoned", reopen: "task.unabandoned" }[writer];
  await vi.waitFor(async () => { expect(await store.db.auditLog.count({ where: { taskId: f.taskId, action: routeAudit } })).toBe(1); });
  expect(f.merge).not.toHaveBeenCalled(); expect(harness.wrapper.start).not.toHaveBeenCalled();
});

it.each(["release", "review/release", "admin-release"] as const)("N-16 actual %s writer cannot alter a reserved generation", async writer => {
  const v = await setup("mode_b_review"); await f.evidence(v.intent);
  await f.service.reserveMerge(f.taskId, actor, "reserved", { action: "approve", method: "squash" });
  const authorization = writer === "review/release" ? token : await createSessionToken(ids.user, "test-secret-which-is-long-enough-1234");
  const before = await snapshot(); const response = await app().fetch(request(writer === "admin-release" ? { releaseWorkClaim: true, releaseReviewClaim: true } : {}, writer, null, authorization));
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "conflict", message: "Task state changed before the request completed" });
  expect(await snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
});

it.each(["review/claim", "admin-release"] as const)("N-16 actual %s no-op retains its active generation", async writer => {
  const makeRequest = await contextWriter(writer);
  await store.db.task.update({ where: { id: f.taskId }, data: writer === "review/claim" ? { reviewClaimedByAgentId: ids.agent } : { claimedByAgentId: null } });
  const before = await snapshot(); const response = await app().fetch(makeRequest()); expect(response.status).toBe(200);
  if (writer === "admin-release") expect(await response.json()).toMatchObject({ released: { workClaim: false, reviewClaim: false } });
  expect(await snapshot()).toEqual(before);
  expect(await store.db.auditLog.count({ where: { projectId: f.projectId, action: "project.grounding.context_mutated" } })).toBe(0);
});

const mergeActor = { ...actor, scopes: ["github:pr_merge"] };
async function standalone(mode: "AUTONOMOUS" | "AWAITS_CONFIRMATION" | "REQUIRES_DISTINCT_REVIEWER" = "AUTONOMOUS") {
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: mergeActor.scopes } });
  await store.db.project.update({ where: { id: f.projectId }, data: { governanceMode: mode } });
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "review", claimedByAgentId: null, claimedByUserId: ids.user } });
}
async function routeEvidence(a: ReturnType<typeof app>) {
  const issued = await a.fetch(request({ intent: "merge" }, "grounding-attempts", null)); expect(issued.status).toBe(201);
  const challenge = await issued.json() as GroundingChallenge;
  const receipt = f.issuer.receipt(challenge);
  const ingested = await a.fetch(request({ session, receipt }, `grounding-attempts/${challenge.attemptId}/receipt`, null)); expect(ingested.status).toBe(200);
  return { challenge, receipt };
}
const standaloneInput = () => ({ action: "merge" as const, route: { kind: "task_merge" as const, transport: { endpoint: "merge" as const, body: { mergeMethod: "squash" } } } });

for (const mode of ["AUTONOMOUS", "AWAITS_CONFIRMATION"] as const) it.each(["missing", "wrong", "valid"])(`R1-H1 ${mode} github-only nonclaimant with %s receipt`, async evidence => {
  await standalone(mode); const a = app();
  if (evidence !== "missing") await routeEvidence(a);
  if (evidence === "wrong") f.head = "c".repeat(40);
  const before = await snapshot(); const response = await a.fetch(request({}, "merge"));
  if (evidence !== "valid") {
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: evidence === "missing" ? "grounding_required" : "grounding_receipt_mismatch" });
    expect(await snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
  } else {
    expect(response.status).toBe(200); const result = await response.json();
    expect(result).toMatchObject({ merged: true, task: { status: "done", claimedByUserId: null, claimedByAgentId: null } });
    const after = await snapshot(); expect(after.receipts).toHaveLength(1); expect(after.attempts[0].state).toBe("CONSUMED");
    expect(after.signals.filter(s => s.type === "self_merge_notice")).toHaveLength(mode === "AWAITS_CONFIRMATION" ? 1 : 0);
    expect(await (await a.fetch(request({}, "merge"))).json()).toEqual(result); expect(await snapshot()).toEqual(after); expect(f.merge).toHaveBeenCalledOnce();
  }
});

it("R1-H1 distinct-reviewer governance permits a third-party merger with an existing distinct lock", async () => {
  await standalone("REQUIRES_DISTINCT_REVIEWER");
  const reviewer = await store.db.agentToken.create({ data: { teamId: ids.team, createdById: ids.user, name: "Distinct reviewer", tokenHash: randomUUID(), scopes: ["tasks:transition"] } });
  await store.db.task.update({ where: { id: f.taskId }, data: { reviewClaimedByAgentId: reviewer.id } });
  const a = app(); await routeEvidence(a); expect((await a.fetch(request({}, "merge"))).status).toBe(200); expect(f.merge).toHaveBeenCalledOnce();
});

it.each(["scope", "project", "review-lock", "self-merge", "consent", "open", "in_progress", "done"])("R1-H1 standalone retains %s denial before effects", async denial => {
  await standalone(denial === "review-lock" || denial === "self-merge" ? "REQUIRES_DISTINCT_REVIEWER" : "AUTONOMOUS");
  if (denial === "scope") await store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: [] } });
  if (denial === "project") {
    const team = await store.db.team.create({ data: { name: "Other", slug: randomUUID() } });
    await store.db.project.update({ where: { id: f.projectId }, data: { teamId: team.id } });
  }
  if (denial === "self-merge") await store.db.task.update({ where: { id: f.taskId }, data: { claimedByUserId: null, claimedByAgentId: ids.agent } });
  if (denial === "consent") await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } });
  const badState = ["open", "in_progress", "done"].includes(denial);
  if (badState) await store.db.task.update({ where: { id: f.taskId }, data: { status: denial } });
  const a = app(); const before = await snapshot();
  expect((await a.fetch(request({ intent: "merge" }, "grounding-attempts", null))).status).toBe(badState ? 409 : 403);
  expect((await a.fetch(request({}, "merge"))).status).toBe(badState ? 409 : 403);
  expect(await snapshot()).toEqual(before); expect(f.merge).not.toHaveBeenCalled();
});

it("R1-H1 route merge policy cannot authorize finish/approve or relax generic C03 methods", async () => {
  await standalone(); const a = app();
  for (const intent of ["finish", "approve"] as const) {
    expect((await a.fetch(request({ intent }, "grounding-attempts", null))).status).toBe(403);
    await expect(f.attempts.issue(f.taskId, mergeActor, intent)).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.service.complete(f.taskId, mergeActor, intent, { action: intent })).rejects.toMatchObject({ code: "forbidden" });
  }
  await expect(f.attempts.issue(f.taskId, mergeActor, "merge")).rejects.toMatchObject({ code: "forbidden" });
  await expect(f.service.reserveMerge(f.taskId, mergeActor, "generic")).rejects.toMatchObject({ code: "forbidden" });
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: [...mergeActor.scopes, "tasks:transition"] } });
  expect((await a.fetch(request({ intent: "approve" }, "grounding-attempts", null))).status).toBe(403);
  expect((await a.fetch(request({ outcome: "approve" }))).status).toBe(403);
  expect((await snapshot()).attempts).toHaveLength(0);
});

it("R1-H1 receipt and historical merge reject actor substitution", async () => {
  await standalone(); const a = app(); const { challenge, receipt } = await routeEvidence(a);
  const otherToken = randomUUID();
  await store.db.agentToken.create({ data: { teamId: ids.team, createdById: ids.user, name: "Other merger", tokenHash: createHash("sha256").update(otherToken).digest("hex"), scopes: mergeActor.scopes } });
  const before = await snapshot();
  expect((await a.fetch(request({ session, receipt }, `grounding-attempts/${challenge.attemptId}/receipt`, null, otherToken))).status).toBe(403);
  expect((await a.fetch(request({}, "merge", "operation", otherToken))).status).toBe(403); expect(await snapshot()).toEqual(before);
  expect((await a.fetch(request({}, "merge"))).status).toBe(200);
  expect((await a.fetch(request({}, "merge", "operation", otherToken))).status).toBe(403); expect(f.merge).toHaveBeenCalledOnce();
});

it("R1-H1 scope and consent revocation deny direct dispatch/recovery; restored authority recovers once", async () => {
  await standalone(); const a = app(); await routeEvidence(a);
  await f.service.reserveMerge(f.taskId, mergeActor, "operation", standaloneInput());
  const revoked = { ...mergeActor, scopes: [] }; let before = await snapshot();
  await expect(f.service.dispatchMerge(f.taskId, revoked, "operation")).rejects.toMatchObject({ code: "forbidden" }); expect(await snapshot()).toEqual(before);
  f.merge.mockRejectedValueOnce(new Error("uncertain")); expect((await a.fetch(request({}, "merge"))).status).toBe(202);
  before = await snapshot();
  await expect(f.service.recoverMerge(f.taskId, revoked, "operation")).rejects.toMatchObject({ code: "forbidden" }); expect(await snapshot()).toEqual(before);
  await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } });
  await expect(f.service.recoverMerge(f.taskId, mergeActor, "operation")).rejects.toMatchObject({ code: "forbidden" }); expect(await snapshot()).toEqual(before);
  await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: true } });
  f.proof = { ...f.proof, merged: true, mergeCommitSha: "b".repeat(40) };
  const recovered = await a.fetch(request({}, "merge")); expect(recovered.status).toBe(200); const result = await recovered.json(); before = await snapshot();
  expect(await (await a.fetch(request({}, "merge"))).json()).toEqual(result); expect(await snapshot()).toEqual(before); expect(f.merge).toHaveBeenCalledOnce();
  await expect(f.service.recoverMerge(f.taskId, revoked, "operation")).rejects.toMatchObject({ code: "forbidden" });
  await expect(f.service.lookupRouteOperation(f.taskId, revoked, "operation", standaloneInput().route.transport)).rejects.toMatchObject({ code: "forbidden" });
});

it("R1-H1 actual route default head and CI readers use merge-only delegation consent", async () => {
  await standalone(); await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrCreate: false, allowAgentPrMerge: true } });
  const definition = defaultWorkflowDefinition(); for (const edge of definition.transitions) if (edge.to === "done") edge.requires = ["ciGreen"];
  await store.db.workflow.create({ data: { projectId: f.projectId, name: "Merge CI", isDefault: true, definition: definition as object } });
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-only" });
    if (String(url) === "https://api.github.com/repos/acme/repo/pulls/42") return Response.json({ number: 42, html_url: "https://github.com/acme/repo/pull/42", base: { repo: { full_name: "acme/repo" } }, head: { sha: f.head }, state: "open", merged: false });
    if (String(url) === `https://api.github.com/repos/acme/repo/commits/${f.head}/check-runs?per_page=100`) return Response.json({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] });
    throw new Error(`unexpected controlled fetch: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const deps = { db: store.db, config: { audience: "consumer.test", trust: () => f.issuer.trust }, now: () => f.now };
  const attempts = new GroundingAttemptsService(deps);
  const service = new GroundingFinalizationService({ ...deps, mergeProvider: { merge: f.merge, read: f.read }, deliverSignal: f.deliverSignal });
  const a = createApp("", attempts, { db: store.db, service }); await routeEvidence(a);
  expect((await a.fetch(request({}, "merge"))).status).toBe(200); expect(f.merge).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/check-runs"))).toBe(true);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/pulls/42")).length).toBeGreaterThan(1);
});
