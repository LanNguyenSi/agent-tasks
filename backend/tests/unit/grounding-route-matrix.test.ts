import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
const harness = vi.hoisted(() => ({ db: null as PrismaClient | null, wrapper: { start: vi.fn(), getLedgerSummary: vi.fn() } }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get: (_target, property) => { const value = Reflect.get(harness.db!, property); return typeof value === "function" ? value.bind(harness.db) : value; } }) }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("../../src/services/grounding-client.js", () => ({ getGroundingClient: () => harness.wrapper }));
import { createApp } from "../../src/app.js";
import { completionStore, completionFixture, completionActor as actor } from "../helpers/grounding-completion-fixtures.js";
import { ids, session } from "../helpers/grounding-fixtures.js";
import type { GroundingChallenge } from "../../src/services/grounding-attempts.js";
import { createSessionToken } from "../../src/services/session.js";
import type { GroundingCreationPolicy } from "../../src/routes/grounding-creation.js";
import * as audit from "../../src/services/audit.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
let human: string;
const token = "grounding-direct-test-token";
beforeAll(async () => {
  store = await completionStore(); harness.db = store.db;
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { tokenHash: createHash("sha256").update(token).digest("hex") } });
  human = await createSessionToken(ids.user, "test-secret-which-is-long-enough-1234");
}, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => {
  vi.stubEnv("REDIS_URL", ""); vi.stubEnv("MCP_LEGACY_TOOLS_ENABLED", "false");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("outbound fetch disabled even during mutants")));
  await store.db.groundingBinding.updateMany({ data: { activeAttemptId: null } });
  await store.db.groundingCohort.updateMany({ data: { reservationId: null } });
  await store.db.groundingFinalization.deleteMany(); await store.db.groundingOperation.deleteMany();
  await store.db.groundingReceipt.deleteMany(); await store.db.groundingAttempt.deleteMany();
  await store.db.groundingBinding.deleteMany(); await store.db.groundingCohort.deleteMany();
  await store.db.task.deleteMany(); await store.db.project.deleteMany();
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: [...actor.scopes, "tasks:read", "tasks:create"], revokedAt: null, expiresAt: null, teamId: ids.team } });
  await store.db.teamMember.upsert({ where: { teamId_userId: { teamId: ids.team, userId: ids.user } }, create: { teamId: ids.team, userId: ids.user, role: "ADMIN" }, update: { role: "ADMIN" } });
  f = await completionFixture(store);
  f.ledger.getLedgerSummary.mockRejectedValue(new Error("legacy must not run"));
  harness.wrapper.start.mockReset().mockRejectedValue(new Error("wrapper must not run"));
  harness.wrapper.getLedgerSummary.mockReset().mockRejectedValue(new Error("ledger must not run"));
});
afterEach(() => { harness.db = store.db; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function app(creationPolicy?: GroundingCreationPolicy) { return createApp("", f.attempts, { db: store.db, service: f.service, creationPolicy }); }
function request(body: unknown, endpoint = "transition", auth = token, key: string | null = "operation") {
  return new Request(`http://localhost/api/tasks/${f.taskId}${endpoint === "patch" || endpoint === "delete" ? "" : `/${endpoint}`}`, { method: endpoint === "patch" ? "PATCH" : endpoint === "delete" ? "DELETE" : "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}`, ...(key ? { "Idempotency-Key": key } : {}) }, ...(endpoint === "delete" ? {} : { body: JSON.stringify(body) }) });
}
async function snapshot() { return { ...await f.snapshot(), comments: await store.db.comment.findMany({ where: { taskId: f.taskId }, orderBy: { id: "asc" } }), signals: await store.db.signal.findMany({ where: { taskId: f.taskId }, orderBy: { id: "asc" } }) }; }
type Endpoint = "patch" | "transition" | "review";
async function evidence(endpoint: Endpoint, target = "review", auth = endpoint === "patch" ? human : token) {
  const a = app(); const issued = await a.fetch(request({ version: 1, endpoint, target }, "grounding-attempts/direct", auth, null));
  expect(issued.status, JSON.stringify(await issued.clone().json())).toBe(201);
  const challenge = await issued.json() as GroundingChallenge;
  const receipt = f.issuer.receipt(challenge);
  const uploaded = await a.fetch(request({ session, receipt }, `grounding-attempts/${challenge.attemptId}/receipt`, auth, null));
  expect(uploaded.status, JSON.stringify(await uploaded.clone().json())).toBe(200);
  return { challenge, receipt };
}
for (const endpoint of ["transition", "patch", "review"] as const) it.each(["missing", "wrong", "valid"])(`N-07/N-12 mounted ${endpoint} with %s receipt`, async kind => {
  const target = endpoint === "review" ? "done" : "review";
  if (endpoint === "review") await store.db.task.update({ where: { id: f.taskId }, data: { status: "review" } });
  await store.db.task.update({ where: { id: f.taskId }, data: { metadata: { debugFlavor: false, sessionId: "forged", currentPhase: "pass", pass: true, receipt: "forged" } } });
  if (kind !== "missing") await evidence(endpoint, target);
  if (kind === "wrong") f.head = "c".repeat(40);
  const before = await snapshot(); const a = app();
  const call = () => request(endpoint === "review" ? { action: "approve", comment: "Reviewed" } : { status: target }, endpoint, endpoint === "patch" ? human : token);
  const response = await a.fetch(call());
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(kind === "valid" ? 200 : 409);
  if (kind !== "valid") expect(await snapshot()).toEqual(before);
  else {
    const body = await response.json(); expect(body).toMatchObject({ task: { status: target } });
    const after = await snapshot(); expect(after.attempts[0].state).toBe("CONSUMED"); expect(after.operations).toHaveLength(1);
    expect(await (await a.fetch(call())).json()).toEqual(body); expect(await snapshot()).toEqual(after);
    if (endpoint === "review") expect(after.comments).toHaveLength(1);
  }
  expect(harness.wrapper.start).not.toHaveBeenCalled(); expect(harness.wrapper.getLedgerSummary).not.toHaveBeenCalled(); expect(f.ledger.getLedgerSummary).not.toHaveBeenCalled(); expect(f.merge).not.toHaveBeenCalled();
});
it.each(["patch", "transition"] as const)("claimless human %s retains direct write authority while v2 denies", async endpoint => {
  await store.db.task.update({ where: { id: f.taskId }, data: { claimedByAgentId: null } });
  expect((await app().fetch(request({ intent: "finish" }, "grounding-attempts", human, null))).status).toBeGreaterThanOrEqual(400);
  await evidence(endpoint, "review", human);
  expect((await app().fetch(request({ status: "review" }, endpoint, human))).status).toBe(200);
});
it("claimless scoped agent transition retains direct authority", async () => {
  await store.db.task.update({ where: { id: f.taskId }, data: { claimedByAgentId: null } });
  await evidence("transition"); expect((await app().fetch(request({ status: "review" }))).status).toBe(200);
});
it.each(["direct-to-v2", "v2-to-direct", "wrong-endpoint"])("receipt route isolation: %s", async lane => {
  if (lane === "direct-to-v2") await evidence("transition");
  else if (lane === "v2-to-direct") await f.evidence();
  else await evidence("patch", "review", human);
  const before = await snapshot();
  const response = await app().fetch(lane === "direct-to-v2" ? request({}, "finish") : request({ status: "review" }, "transition", lane === "wrong-endpoint" ? human : token));
  expect(response.status).toBe(409); expect(await snapshot()).toEqual(before);
});
it("stored malformed descriptor denies pre-ingest and completion without v2 fallback", async () => {
  const { challenge, receipt } = await evidence("transition");
  await store.db.groundingAttempt.update({ where: { id: challenge.attemptId }, data: { directRoute: { version: 1, endpoint: "finish", target: "review" } } });
  const before = await snapshot();
  expect((await app().fetch(request({ session, receipt }, `grounding-attempts/${challenge.attemptId}/receipt`))).status).toBe(409);
  expect((await app().fetch(request({ status: "review" }))).status).toBe(409); expect(await snapshot()).toEqual(before);
});
it("direct issue rejects unknown selector/target and upload cannot nominate a lane", async () => {
  for (const body of [{ version: 1, endpoint: "finish", target: "review" }, { version: 1, endpoint: "transition", target: "nonexistent" }, { version: 1, endpoint: "transition", target: "review", intent: "finish" }]) expect((await app().fetch(request(body, "grounding-attempts/direct"))).status).toBeGreaterThanOrEqual(400);
  const { challenge, receipt } = await evidence("transition"); const before = await snapshot();
  expect((await app().fetch(request({ session, receipt, endpoint: "transition" }, `grounding-attempts/${challenge.attemptId}/receipt`))).status).toBe(400); expect(await snapshot()).toEqual(before);
});
it.each(["scope", "actor", "permission"])("direct current %s denial at upload and completion", async denial => {
  const { challenge, receipt } = await evidence("transition");
  let auth = token;
  if (denial === "scope") await store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: [] } });
  if (denial === "permission") { const team = await store.db.team.create({ data: { name: "Other", slug: randomUUID() } }); await store.db.agentToken.update({ where: { id: ids.agent }, data: { teamId: team.id } }); }
  if (denial === "actor") auth = human;
  const before = await snapshot();
  expect((await app().fetch(request({ session, receipt }, `grounding-attempts/${challenge.attemptId}/receipt`, auth))).status).toBe(403);
  expect((await app().fetch(request({ status: "review" }, "transition", auth))).status).toBe(403); expect(await snapshot()).toEqual(before);
});
it("N-12 combined specification and success PATCH cannot consume the prior receipt", async () => {
  await evidence("patch"); const before = await snapshot();
  expect((await app().fetch(request({ status: "review", description: "Changed" }, "patch", human))).status).toBe(409); expect(await snapshot()).toEqual(before);
});
const writers = ["title", "description", "templateData", "branchName", "prUrl", "prNumber", "deliverableRepo", "labels", "agent-patch", "respec", "submit-pr"] as const;
async function write(writer: typeof writers[number]) {
  const bodies = { title: { title: "Changed" }, description: { description: "Changed" }, templateData: { templateData: { goal: "Changed" } }, branchName: { branchName: "changed" }, prUrl: { prUrl: "https://github.com/acme/repo/pull/43" }, prNumber: { prNumber: 43 }, deliverableRepo: { deliverableRepo: "acme/other" }, labels: { labels: ["bug"] }, "agent-patch": { branchName: "changed" }, respec: { description: "Changed" }, "submit-pr": { branchName: "changed", prUrl: "https://github.com/acme/repo/pull/43", prNumber: 43 } };
  return app().fetch(request(bodies[writer], writer === "respec" || writer === "submit-pr" ? writer : "patch", ["agent-patch", "submit-pr", "respec"].includes(writer) ? token : human, null));
}
it.each(writers)("N-06 %s mutation after upload atomically invalidates", async writer => {
  await evidence("transition");
  if (writer === "respec") await store.db.task.update({ where: { id: f.taskId }, data: { status: "open", claimedByAgentId: null } });
  const before = await snapshot(); const response = await write(writer); expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  const after = await snapshot(); expect(after.binding!.activeAttemptId).toBeNull(); expect(after.binding!.contextRevision).toBe(before.binding!.contextRevision + 1); expect(after.attempts[0].state).toBe("SUPERSEDED");
  expect(await store.db.auditLog.count({ where: { projectId: f.projectId, action: "project.grounding.context_mutated" } })).toBe(1);
});
it.each(writers.flatMap(writer => (["RESERVED", "DISPATCHED"] as const).map(state => ({ writer, state }))))("N-06 $state generation blocks $writer without effects", async ({ writer, state }) => {
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "review" } });
  await f.evidence("approve"); const reservation = await f.service.reserveMerge(f.taskId, actor, "reserve", { action: "approve" });
  if (state === "DISPATCHED") await store.db.groundingOperation.update({ where: { id: reservation.operationId }, data: { state: "DISPATCHED" } });
  if (writer === "respec") await store.db.task.update({ where: { id: f.taskId }, data: { status: "open", claimedByAgentId: null } });
  const before = await snapshot(); const response = await write(writer); expect(response.status, JSON.stringify(await response.clone().json())).toBe(409); expect(await snapshot()).toEqual(before);
});
it("N-06 no-op, result and comments preserve receipt generation", async () => {
  await evidence("transition"); const before = await f.snapshot();
  expect((await app().fetch(request({ title: "Exact task", branchName: "branch", result: "Progress" }, "patch", human))).status).toBe(200);
  expect((await app().fetch(request({ content: "Progress comment" }, "comments", human, null))).status).toBe(201);
  const after = await f.snapshot(); expect(after.binding).toEqual(before.binding); expect(after.attempts).toEqual(before.attempts);
  expect((await app().fetch(request({ status: "review" }))).status).toBe(200);
});
it("N-07 labels cannot remove persisted protection and agent forged metadata is not authority", async () => {
  await store.db.task.update({ where: { id: f.taskId }, data: { labels: ["bug"], metadata: { debugFlavor: true } } });
  await evidence("transition");
  expect((await app().fetch(request({ labels: [] }, "patch", human))).status).toBe(200);
  expect((await app().fetch(request({ metadata: { debugFlavor: false, pass: true } }, "patch"))).status).toBe(400);
  expect((await f.snapshot()).binding!.protected).toBe(true);
  expect((await app().fetch(request({ status: "review" }))).status).toBe(409);
});
it.each(["patch", "transition"] as const)("N-12 custom semantic %s success requires receipt", async endpoint => {
  await f.workflow(); const auth = endpoint === "patch" ? human : token;
  expect((await app().fetch(request({ status: "checking" }, endpoint, auth))).status).toBe(409);
  await evidence(endpoint, "checking", auth); expect((await app().fetch(request({ status: "checking" }, endpoint, auth))).status).toBe(200);
  await evidence(endpoint, "shipped", auth); expect((await app().fetch(request({ status: "shipped" }, endpoint, auth, "second"))).status).toBe(200);
});
it("N-16 legacy request_changes and backlog discard are non-success dispositions", async () => {
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "review" } }); await evidence("review", "done");
  expect((await app().fetch(request({ action: "request_changes", comment: "Needs work" }, "review", token, null))).status).toBe(200);
  expect((await f.snapshot()).attempts[0].state).toBe("SUPERSEDED");
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "backlog", claimedByAgentId: null } });
  expect((await app().fetch(request({ status: "abandoned" }, "patch", human, null))).status).toBe(200); expect((await f.task()).status).toBe("abandoned");
});
it("N-17 admin force requires right and reason, and mandatory audit rolls back", async () => {
  const body = { status: "review", force: true, forceReason: "Operator reviewed exception" };
  expect((await app().fetch(request(body))).status).toBe(403);
  expect((await app().fetch(request({ ...body, forceReason: " " }, "transition", human))).status).toBe(409);
  const before = await snapshot(); vi.spyOn(audit, "logGroundingDecision").mockRejectedValueOnce(new Error("audit unavailable"));
  expect((await app().fetch(request(body, "transition", human))).status).toBe(503); expect(await snapshot()).toEqual(before);
  expect((await app().fetch(request(body, "transition", human))).status).toBe(200);
  expect(await store.db.auditLog.count({ where: { taskId: f.taskId, action: "task.grounding.overridden" } })).toBe(1); expect((await f.snapshot()).receipts).toHaveLength(0);
});
it("receipt, effects and status roll back together on positive mandatory audit failure", async () => {
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "review" } }); await evidence("review", "done"); const before = await snapshot();
  vi.spyOn(audit, "logGroundingDecision").mockRejectedValueOnce(new Error("audit unavailable"));
  expect((await app().fetch(request({ action: "approve", comment: "Reviewed" }, "review"))).status).toBe(503); expect(await snapshot()).toEqual(before);
  expect((await app().fetch(request({ action: "approve", comment: "Reviewed" }, "review"))).status).toBe(200);
});
it("N-16 enrolled deletion is a locked retention conflict, unprovisioned deletion still works", async () => {
  await evidence("transition"); const before = await snapshot();
  const denied = await app().fetch(request({}, "delete", human, null)); expect(denied.status).toBe(409); expect(await denied.json()).toMatchObject({ error: "grounding_history_retained" }); expect(await snapshot()).toEqual(before);
  const task = await store.db.task.create({ data: { projectId: f.projectId, title: "Historical" } });
  const response = await app().fetch(new Request(`http://localhost/api/tasks/${task.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${human}` } })); expect(response.status).toBe(200);
});
function createRequest(body: unknown, batch = false, auth = human) { return new Request(`http://localhost/api/projects/${f.projectId}/tasks${batch ? "/import" : ""}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) }); }
const selected = (): GroundingCreationPolicy => [{ projectId: f.projectId, subjectMode: "TASK_SPEC" }];
it.each(["missing", "wrong", "valid"])("N-12 selected positive create/import reject %s receipt without partial row", async receipt => {
  const prior = receipt === "missing" ? undefined : (await evidence("transition")).receipt;
  const body = { title: "Success import", status: "done", receipt: receipt === "wrong" ? "wrong" : prior };
  const count = await store.db.task.count();
  const response = await app(selected()).fetch(createRequest(body)); expect(response.status).toBe(409); expect(await store.db.task.count()).toBe(count);
  const imported = await app(selected()).fetch(createRequest({ tasks: [{ title: "Initial" }, body] }, true)); expect(imported.status).toBe(201);
  const result = await imported.json() as { created: number; errors: unknown[] }; expect(result.created).toBe(1); expect(result.errors).toHaveLength(1); expect(await store.db.task.count()).toBe(count + 1);
});
it("N-07 selected agent false creation is atomically protected with unchanged backlog routing", async () => {
  const response = await app(selected()).fetch(createRequest({ title: "No bug label", debugFlavor: false, labels: [] }, false, token)); expect(response.status).toBe(201);
  const body = await response.json() as { task: { id: string; status: string } }; expect(body.task.status).toBe("backlog");
  expect(await store.db.groundingBinding.findUnique({ where: { taskId: body.task.id } })).toMatchObject({ protected: true, subjectMode: "TASK_SPEC" });
  expect(await store.db.groundingCohort.findUnique({ where: { taskId: body.task.id } })).toMatchObject({ mode: "EXTERNAL_V1", protected: true });
  expect((await app(selected()).fetch(createRequest({ title: "Agent bypass", status: "done" }, false, token))).status).toBe(400);
});
it.each([false, true])("N-22 empty creation policy preserves historical project flag=%s defaults", async flag => {
  await store.db.project.update({ where: { id: f.projectId }, data: { requireGroundingForDebug: flag } });
  const response = await app().fetch(createRequest({ title: "Legacy success", status: "done", debugFlavor: true })); expect(response.status).toBe(201);
  const body = await response.json() as { task: { id: string } }; expect(await store.db.groundingCohort.findUnique({ where: { taskId: body.task.id } })).toBeNull();
});

it("selected initial creation retains signals, override audit, confidence settings and import response", async () => {
  await store.db.project.update({ where: { id: f.projectId }, data: { confidenceThreshold: 88, enforcementMode: "WARN" } });
  const response = await app(selected()).fetch(createRequest({ title: "Initial", deliverableRepo: "acme/other" })); expect(response.status).toBe(201);
  const result = await response.json() as { task: { id: string }; confidence: { threshold: number } }; expect(result.confidence.threshold).toBe(88);
  expect(await store.db.signal.count({ where: { taskId: result.task.id, type: "task_available" } })).toBe(1);
  expect(await store.db.auditLog.count({ where: { taskId: result.task.id, action: "task.deliverable_repo_set" } })).toBe(1);
  const imported = await app(selected()).fetch(createRequest({ tasks: [{ title: "Draft", externalRef: "same" }, { title: "Duplicate", externalRef: "same" }] }, true));
  expect(imported.status).toBe(201); expect(await imported.json()).toMatchObject({ created: 1, skipped: 1, failed: 0, ids: [{ index: 0 }], skippedRefs: ["same"], errors: [] });
});

it("N-07 agent reclassify changes display metadata without removing stored protection", async () => {
  await store.db.project.update({ where: { id: f.projectId }, data: { enforcementMode: "OFF" } });
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "open", claimedByAgentId: null, metadata: { debugFlavor: true } } });
  expect((await app().fetch(new Request("http://localhost/api/tasks/pickup?reclassify=true", { method: "POST", headers: { Authorization: `Bearer ${token}` } }))).status).toBe(200);
  expect((await f.snapshot()).binding!.protected).toBe(true);
  expect((await f.task()).metadata).toMatchObject({ debugFlavor: false });
  expect((await app().fetch(request({}, "start", token, null))).status).toBe(200);
  expect((await app().fetch(request({ status: "review" }))).status).toBe(409);
  await evidence("transition");
  expect((await app().fetch(request({ status: "review" }))).status).toBe(200);
});
it("N-17 force from a human without admin rights is denied", async () => {
  await store.db.teamMember.update({ where: { teamId_userId: { teamId: ids.team, userId: ids.user } }, data: { role: "HUMAN_MEMBER" } });
  expect((await app().fetch(request({ status: "review", force: true, forceReason: "Reason" }, "transition", human))).status).toBe(403);
});
it("direct retry rejects changed payload even when status is already the completed target", async () => {
  await evidence("patch"); expect((await app().fetch(request({ status: "review" }, "patch", human))).status).toBe(200); const before = await snapshot();
  expect((await app().fetch(request({ status: "review", title: "Changed" }, "patch", human))).status).toBe(409); expect(await snapshot()).toEqual(before);
});
it("non-success PATCH can change context atomically while discarding backlog", async () => {
  await evidence("transition"); await store.db.task.update({ where: { id: f.taskId }, data: { status: "backlog", claimedByAgentId: null } });
  expect((await app().fetch(request({ status: "abandoned", description: "Discard reason", labels: [] }, "patch", human, null))).status).toBe(200);
  expect((await f.task()).description).toBe("Discard reason"); expect((await f.snapshot()).attempts[0].state).toBe("SUPERSEDED");
  expect(await store.db.auditLog.count({ where: { taskId: f.taskId, action: "task.labels_changed" } })).toBe(0);
});

it.each(["distinct", "review-lock", "role", "CI"] as const)("direct endpoint retains %s policy", async denial => {
  if (denial === "distinct" || denial === "review-lock") {
    await store.db.task.update({ where: { id: f.taskId }, data: { status: "review" } });
    if (denial === "distinct") await store.db.project.update({ where: { id: f.projectId }, data: { governanceMode: "REQUIRES_DISTINCT_REVIEWER" } });
    else {
      const reviewer = await store.db.agentToken.create({ data: { teamId: ids.team, createdById: ids.user, name: "Other reviewer", tokenHash: randomUUID(), scopes: ["tasks:transition"] } });
      await store.db.task.update({ where: { id: f.taskId }, data: { reviewClaimedByAgentId: reviewer.id } });
    }
    expect((await app().fetch(request({ action: "approve" }, "review"))).status).toBe(denial === "distinct" ? 403 : 409);
  } else {
    await store.db.workflow.create({ data: { projectId: f.projectId, name: "Gated", isDefault: true, definition: { initialState: "open", states: [{ name: "open", label: "Open", terminal: false }, { name: "in_progress", label: "Work", terminal: false }, { name: "review", label: "Review", terminal: false }, { name: "done", label: "Done", terminal: true }], transitions: [{ from: "open", to: "in_progress" }, { from: "in_progress", to: "review", ...(denial === "role" ? { requiredRole: "HUMAN_MEMBER" } : { requires: ["ciGreen"] }) }, { from: "review", to: "done" }] } } });
    if (denial === "CI") await evidence("transition");
    expect((await app().fetch(request({ status: "review" }))).status).toBe(denial === "role" ? 403 : 409);
  }
  expect((await f.snapshot()).operations).toHaveLength(0);
});

it("labels reorder is a full no-op including audit and receipt generation", async () => {
  await store.db.task.update({ where: { id: f.taskId }, data: { labels: ["bug", "heavy-pick"] } }); await evidence("transition"); const before = await snapshot();
  expect((await app().fetch(request({ labels: ["heavy-pick", "bug"] }, "patch", human, null))).status).toBe(200); expect(await snapshot()).toEqual(before);
});
it("force replay checks current admin rights", async () => {
  const body = { status: "review", force: true, forceReason: "Operator exception" };
  expect((await app().fetch(request(body, "transition", human))).status).toBe(200);
  await store.db.teamMember.update({ where: { teamId_userId: { teamId: ids.team, userId: ids.user } }, data: { role: "HUMAN_MEMBER" } }); const before = await snapshot();
  expect((await app().fetch(request(body, "transition", human))).status).toBe(403); expect(await snapshot()).toEqual(before);
});
it("nonpositive PATCH cannot link a foreign PR alongside a status disposition", async () => {
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "backlog", claimedByAgentId: null } }); const before = await snapshot();
  expect((await app().fetch(request({ status: "abandoned", prUrl: "https://github.com/foreign/repo/pull/2" }, "patch", human, null))).status).toBe(403); expect(await snapshot()).toEqual(before);
});

// Observe a real PostgreSQL parent-lock wait inside the intended transaction,
// after its Serializable snapshot exists. The proxy only schedules that wait.
async function queuedAuthority(kind: "issue" | "upload" | "complete" | "patch" | "create" | "release", revocation: "team-remove" | "project-demote" | "token-scopes" | "token-revoke" | "token-expire") {
  const isAgent = revocation.startsWith("token"); const auth = isAgent ? token : human;
  if (revocation === "project-demote") {
    await store.db.teamMember.delete({ where: { teamId_userId: { teamId: ids.team, userId: ids.user } } });
    await store.db.projectMember.create({ data: { projectId: f.projectId, userId: ids.user, invitedById: ids.user, role: "PROJECT_CONTRIBUTOR" } });
  }
  const prepared = kind === "complete" || kind === "upload" ? await evidence("transition", "review", auth) : null;
  const waiting = store.connect(); const blocker = store.connect(); const observer = store.connect();
  const { barrier } = await import("../helpers/grounding-postgres.js");
  const entered = barrier(); const held = barrier(); let txCount = 0; let waitingPid = 0; let blockingPid = 0;
  const target = kind === "complete" ? 3 : kind === "create" || kind === "release" ? 1 : 2;
  const scheduled = new Proxy(waiting, { get(client, property) {
    if (property === "$transaction") return (run: (db: import("@prisma/client").Prisma.TransactionClient) => Promise<unknown>, options: unknown) => client.$transaction(async tx => {
      txCount++;
      if (txCount === target) {
        const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; waitingPid = pid!.pid;
        await entered.wait();
      }
      return run(tx);
    }, options as object);
    const value = Reflect.get(client, property); return typeof value === "function" ? value.bind(client) : value;
  } });
  const { GroundingAttemptsService } = await import("../../src/services/grounding-attempts.js");
  const attempts = new GroundingAttemptsService({ db: scheduled, config: { audience: "consumer.test", trust: () => f.issuer.trust }, now: () => f.now, headProvider: f.headProvider });
  const a = createApp("", attempts, { db: scheduled, service: f.make(scheduled), ...(kind === "create" ? { creationPolicy: selected() } : {}) });
  const before = await snapshot(); const count = await store.db.task.count();
  const req = kind === "release" ? request({}, "release", token, null) : kind === "issue" ? request({ version: 1, endpoint: "transition", target: "review" }, "grounding-attempts/direct", auth, null)
    : kind === "upload" ? request({ session, receipt: prepared!.receipt }, `grounding-attempts/${prepared!.challenge.attemptId}/receipt`, auth, null)
      : kind === "patch" ? request(isAgent ? { branchName: "after revoke" } : { description: "after revoke" }, "patch", auth, null)
        : kind === "create" ? createRequest({ title: "After revoke" }, false, auth) : request({ status: "review" }, "transition", auth);
  if (kind === "release") harness.db = scheduled;
  const pending = Promise.resolve(a.fetch(req));
  await Promise.race([entered.reached, pending.then(async response => { throw new Error(`Request returned before the scheduled transaction: ${response.status} ${await response.clone().text()}`); })]);
  const holding = blocker.$transaction(async tx => {
    const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM projects WHERE id = ${f.projectId} FOR UPDATE`; blockingPid = pid!.pid; await held.wait();
  }, { timeout: 15000 });
  await held.reached; entered.release();
  try {
    const deadline = Date.now() + 5000; let blocked = false;
    do { const [row] = await observer.$queryRaw<{ blocked: boolean }[]>`SELECT ${blockingPid}::int = ANY(pg_blocking_pids(${waitingPid}::int)) AS blocked`; blocked = row?.blocked ?? false; if (blocked) break; } while (Date.now() < deadline);
    expect(blocked).toBe(true);
    if (revocation === "team-remove") await observer.teamMember.delete({ where: { teamId_userId: { teamId: ids.team, userId: ids.user } } });
    else if (revocation === "project-demote") await observer.projectMember.update({ where: { projectId_userId: { projectId: f.projectId, userId: ids.user } }, data: { role: "PROJECT_VIEWER" } });
    else await observer.agentToken.update({ where: { id: ids.agent }, data: revocation === "token-scopes" ? { scopes: [] } : revocation === "token-revoke" ? { revokedAt: new Date() } : { expiresAt: new Date(Date.now() - 1000) } });
  } finally { held.release(); await holding; }
  const response = await pending;
  harness.db = store.db;
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(403);
  expect(await snapshot()).toEqual(before); expect(await store.db.task.count()).toBe(count);
}
it.each(["issue", "upload", "complete", "patch", "create"] as const)("queued %s rechecks a removed human grant", async kind => { await queuedAuthority(kind, "team-remove"); }, 20000);
it.each(["token-scopes", "token-revoke", "token-expire", "project-demote"] as const)("queued completion rechecks %s", async revoke => { await queuedAuthority("complete", revoke); }, 20000);

it("queued legacy release rechecks a revoked agent token", async () => { await queuedAuthority("release", "token-revoke"); }, 20000);
