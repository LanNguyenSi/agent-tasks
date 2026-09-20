import { createHmac, randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { completionFixture, completionStore, completionActor as actor } from "../helpers/grounding-completion-fixtures.js";
import { barrier } from "../helpers/grounding-postgres.js";
import { ids } from "../helpers/grounding-fixtures.js";
import { GroundingGithubWebhookService } from "../../src/services/grounding-github-webhook.js";
import { GroundingGithubMergeService } from "../../src/services/grounding-github-merge.js";
import { createGroundingGithubWebhookRouter } from "../../src/routes/grounding-github-webhooks.js";

const secret = "webhook-integration-secret";
let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
let repo: string;
let prefix: string;
beforeAll(async () => { store = await completionStore(); }, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => {
  f = await completionFixture(store); repo = `acme/webhook_${randomUUID().replaceAll("-", "")}`; prefix = randomUUID();
  await store.db.project.update({ where: { id: f.projectId }, data: { githubRepo: repo } });
  await store.db.task.update({ where: { id: f.taskId }, data: { title: "[GH #17] [PR #42] Protected task", prUrl: `https://github.com/${repo}/pull/42` } });
  vi.stubEnv("REDIS_URL", "");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function app(db: PrismaClient = store.db, settings: { secret?: string; requireSecret?: boolean } = {}) {
  return new Hono().route("/webhooks", createGroundingGithubWebhookRouter({ service: new GroundingGithubWebhookService(db), secret, requireSecret: true, ...settings }));
}
function payload(kind: "merged" | "opened" | "reopened" | "changes_requested" | "approved" | "issue_closed" | "issue_reopened" | "issue_opened" = "merged", head = f.head) {
  const repository = { full_name: repo };
  const pull_request = { number: 42, title: "PR", html_url: `https://github.com/${repo}/pull/42`, head: { ref: "branch", sha: head } };
  if (kind.startsWith("issue_")) return { repository, action: kind.slice(6), issue: { number: 17, title: "Issue", body: "Description", html_url: `https://github.com/${repo}/issues/17`, state: kind === "issue_closed" ? "closed" : "open" } };
  if (kind === "changes_requested" || kind === "approved") return { repository, action: "submitted", pull_request, review: { state: kind, user: { login: "external-reviewer" }, html_url: `https://github.com/${repo}/pull/42#review` } };
  return { repository, action: kind === "merged" ? "closed" : kind, pull_request: { ...pull_request, state: kind === "merged" ? "closed" : "open", merged: kind === "merged", merged_by: kind === "merged" ? { login: "external-merger" } : null } };
}
function request(body: unknown = payload(), suffix = "event", target = app(), headers: Record<string, string> = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const parsed = typeof body === "string" ? null : body as Record<string, unknown>;
  const event = parsed?.issue ? "issues" : parsed?.review ? "pull_request_review" : "pull_request";
  return target.request("/webhooks/github", { method: "POST", body: raw, headers: { "Content-Type": "application/json", "X-GitHub-Delivery": `${prefix}:${suffix}`, "X-GitHub-Event": event, "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`, ...headers } });
}
async function snapshot() {
  return { ...await f.snapshot(), comments: await store.db.comment.findMany({ where: { taskId: f.taskId }, orderBy: { id: "asc" } }), signals: await store.db.signal.findMany({ where: { taskId: f.taskId }, orderBy: { id: "asc" } }), observations: await store.db.groundingGithubObservation.findMany({ where: { taskId: f.taskId }, orderBy: { id: "asc" } }), deliveries: await store.db.groundingGithubWebhookDelivery.findMany({ where: { deliveryId: { startsWith: prefix } }, orderBy: { deliveryId: "asc" } }) };
}
async function signal(taskId: string = f.taskId, projectId: string = f.projectId) { return store.db.signal.create({ data: { taskId, projectId, type: "review_needed", recipientAgentId: ids.agent, context: {} } }); }
async function unprovisioned(status = "in_progress") {
  return store.db.task.create({ data: { projectId: f.projectId, title: "[GH #17] Legacy", status, claimedByAgentId: ids.agent, prNumber: 42, prUrl: `https://github.com/${repo}/pull/42`, branchName: "branch" } });
}

it.each(["missing", "wrong", "no_secret"])("HOOK %s signature rejects before delivery insertion or task effects", async condition => {
  const before = await snapshot();
  const target = condition === "no_secret" ? app(store.db, { secret: "", requireSecret: true }) : app();
  const response = await request(payload(), "auth", target, condition === "missing" ? { "X-Hub-Signature-256": "" } : condition === "wrong" ? { "X-Hub-Signature-256": "sha256=wrong" } : {});
  expect(response.status).toBe(401); expect(await snapshot()).toEqual(before);
});

it("HOOK missing delivery identity and invalid JSON fail before claiming or effects", async () => {
  expect((await request(payload(), "invalid", app(), { "X-GitHub-Delivery": "" })).status).toBe(400);
  expect((await request("{invalid", "json")).status).toBe(400);
  expect((await snapshot()).deliveries).toHaveLength(0);
  expect((await f.task()).status).toBe("in_progress");
});

it.each(["no", "wrong", "valid"])("HOOK %s receipt never grants completion on a protected merged PR", async receipt => {
  await signal();
  if (receipt !== "no") await f.evidence(receipt === "valid" ? "merge" : "finish");
  const before = await snapshot();
  const response = await request(); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ received: true, observed: 1, changed: 0 });
  const after = await snapshot();
  expect(after.task).toEqual(before.task); expect(after.binding).toEqual(before.binding); expect(after.attempts).toEqual(before.attempts); expect(after.signals).toEqual(before.signals);
  expect(after.observations).toHaveLength(1);
  expect(after.observations[0]).toMatchObject({ state: "PENDING", reason: "authenticated_completion_required", matchKind: "EXACT", event: "pr_merged", repo, prNumber: 42, operationId: null });
  expect(after.comments).toHaveLength(1); expect(after.comments[0].content).toContain("completion pending");
  expect(after.comments[0].authorAgentId).toBeNull(); expect(after.comments[0].authorUserId).toBeNull();
  expect(after.audit).toHaveLength(1); expect(after.audit[0]).toMatchObject({ action: "task.grounding.external_pending", actorId: null, payload: expect.objectContaining({ actorType: "system_observation", githubLogin: "external-merger" }) });
});

it("HOOK protected issue close is a visible pending fact without status, claim or signal changes", async () => {
  await f.evidence("merge"); await signal(); const before = await snapshot();
  expect((await request(payload("issue_closed"))).status).toBe(200);
  const after = await snapshot();
  expect(after.task).toEqual(before.task); expect(after.signals).toEqual(before.signals); expect(after.attempts).toEqual(before.attempts);
  expect(after.observations[0]).toMatchObject({ event: "issue_closed", state: "PENDING", issueNumber: 17, prNumber: null, reason: "weak_binding" });
});

it("HOOK provisioned OFF and partial enrollment never fall through to legacy positive status", async () => {
  const off = await completionFixture(store, "OFF");
  await store.db.project.update({ where: { id: off.projectId }, data: { githubRepo: repo, soloMode: true } });
  await store.db.task.update({ where: { id: off.taskId }, data: { prUrl: `https://github.com/${repo}/pull/42` } });
  await store.db.groundingCohort.delete({ where: { taskId: f.taskId } });
  expect((await request()).status).toBe(200);
  expect((await off.task()).status).toBe("in_progress"); expect((await f.task()).status).toBe("in_progress");
  expect((await snapshot()).observations[0]).toMatchObject({ state: "PENDING", reason: "invalid_enrollment" });
});

it("HOOK active finalization reservation is referenced but never consumed by an observed merge", async () => {
  await f.evidence("merge");
  const grouped = new GroundingGithubMergeService({ db: store.db, config: { audience: "consumer.test", trust: () => f.issuer.trust }, now: () => f.now, headProvider: f.headProvider });
  const operation = await grouped.reserveMerge(f.taskId, actor, "merge");
  const before = await snapshot(); expect((await request()).status).toBe(200);
  const after = await snapshot();
  expect(after.observations[0].operationId).toBe(operation.operationId);
  expect(after.operations).toEqual(before.operations); expect(after.cohort).toEqual(before.cohort); expect(after.attempts).toEqual(before.attempts); expect(after.task).toEqual(before.task);
});

it("HOOK legacy positive effects cannot bypass another task's active repository fence", async () => {
  const legacy = await unprovisioned(); const beforeLegacy = await store.db.task.findUniqueOrThrow({ where: { id: legacy.id } });
  await f.evidence("merge");
  const grouped = new GroundingGithubMergeService({ db: store.db, config: { audience: "consumer.test", trust: () => f.issuer.trust }, now: () => f.now, headProvider: f.headProvider });
  await grouped.reserveMerge(f.taskId, actor, "merge"); const before = await snapshot();
  expect((await request()).status).toBe(503);
  expect(await snapshot()).toEqual(before);
  expect(await store.db.task.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(beforeLegacy);
});

it("HOOK exact duplicate delivery returns saved result without duplicate audit, comment or observation", async () => {
  expect((await request()).status).toBe(200); const before = await snapshot();
  const duplicate = await request(); expect(duplicate.status).toBe(200); expect(await duplicate.json()).toMatchObject({ duplicate: true, received: true });
  expect(await snapshot()).toEqual(before);
});

it("HOOK duplicate concurrent deliveries across connections apply one transaction", async () => {
  const gate = barrier();
  const client = store.connect().$extends({ query: { auditLog: { async create({ args, query }) { const row = await query(args); if (args.data.action === "task.grounding.external_pending") await gate.wait(); return row; } } } });
  const first = request(payload(), "concurrent", app(client as unknown as PrismaClient)); await gate.reached;
  const second = request(payload(), "concurrent", app(store.connect())); gate.release();
  const responses = await Promise.all([first, second]); expect(responses.map(response => response.status)).toEqual([200, 200]);
  expect((await Promise.all(responses.map(response => response.json()))).filter(body => (body as { duplicate?: boolean }).duplicate)).toHaveLength(1);
  const after = await snapshot(); expect(after.deliveries).toHaveLength(1); expect(after.observations).toHaveLength(1); expect(after.comments).toHaveLength(1); expect(after.audit).toHaveLength(1);
});

it("HOOK mandatory audit failure rolls back delivery claim and partial effects; same delivery retries successfully", async () => {
  let fail = true;
  const client = store.connect().$extends({ query: { auditLog: { async create({ args, query }) { if (fail && args.data.action === "task.grounding.external_pending") { fail = false; throw new Error("mandatory audit unavailable"); } return query(args); } } } });
  const target = app(client as unknown as PrismaClient); const before = await snapshot();
  expect((await request(payload(), "retry", target)).status).toBe(503);
  expect(await snapshot()).toEqual(before);
  expect((await request(payload(), "retry", target)).status).toBe(200);
  const after = await snapshot(); expect(after.deliveries).toHaveLength(1); expect(after.comments).toHaveLength(1); expect(after.observations).toHaveLength(1); expect(after.audit).toHaveLength(1);
});

it("HOOK enrollment read failure aborts instead of masquerading as invalid enrollment and remains retryable", async () => {
  let reads = 0;
  const client = store.connect().$extends({ query: { groundingCohort: { async findUnique({ args, query }) { if (++reads === 2) throw new Error("enrollment database unavailable"); return query(args); } } } });
  const target = app(client as unknown as PrismaClient); const before = await snapshot();
  expect((await request(payload(), "retry-read", target)).status).toBe(503);
  expect(await snapshot()).toEqual(before);
  expect((await request(payload(), "retry-read", target)).status).toBe(200);
});

it("HOOK same delivery with changed bytes or event cannot replay another result", async () => {
  expect((await request()).status).toBe(200); const before = await snapshot();
  expect((await request(JSON.stringify(payload()) + " ")).status).toBe(409);
  expect((await request(payload(), "event", app(), { "X-GitHub-Event": "ping" })).status).toBe(409);
  expect(await snapshot()).toEqual(before);
});

it("HOOK PR-open backfill invalidates protected binding exactly once and semantic no-op preserves a fresh attempt", async () => {
  await f.evidence("merge");
  await store.db.task.update({ where: { id: f.taskId }, data: { prUrl: null } });
  const before = await snapshot();
  expect((await request(payload("opened"), "open")).status).toBe(200);
  const after = await snapshot();
  expect(after.task?.prUrl).toBe(`https://github.com/${repo}/pull/42`);
  expect(after.binding?.contextRevision).toBe(before.binding!.contextRevision + 1); expect(after.binding?.activeAttemptId).toBeNull(); expect(after.attempts[0].state).toBe("SUPERSEDED");
  expect(after.audit.filter(row => row.action === "task.grounding.context_observed")).toHaveLength(1);
  expect((await request(payload("opened"), "open")).status).toBe(200); expect(await snapshot()).toEqual(after);
  await f.evidence("merge"); const refreshed = await snapshot();
  expect((await request(payload("opened"), "noop")).status).toBe(200);
  const noop = await snapshot();
  expect(noop.task).toEqual(refreshed.task); expect(noop.binding).toEqual(refreshed.binding); expect(noop.attempts).toEqual(refreshed.attempts);
  expect(noop.audit.filter(row => row.action === "task.grounding.context_observed")).toHaveLength(1);
});

it("HOOK PR-open all-task batch rolls back when one member has a finalization reservation", async () => {
  await f.evidence("merge"); await f.service.reserveMerge(f.taskId, actor, "reserved");
  await store.db.task.update({ where: { id: f.taskId }, data: { branchName: null } });
  const second = await store.db.task.create({ data: { projectId: f.projectId, title: "[PR #42] Other", status: "in_progress", branchName: "branch" } });
  const before = await snapshot();
  expect((await request(payload("opened"))).status).toBe(409);
  expect(await snapshot()).toEqual(before);
  expect(await store.db.task.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ prNumber: null, prUrl: null });
});

it("HOOK PR-open conflicting binding blocks the entire otherwise valid backfill batch", async () => {
  await store.db.task.update({ where: { id: f.taskId }, data: { prUrl: null } });
  const second = await store.db.task.create({ data: { projectId: f.projectId, title: "[PR #42] Conflicting", status: "in_progress", prNumber: 43, prUrl: `https://github.com/${repo}/pull/43`, branchName: "branch" } });
  const before = await snapshot();
  expect((await request(payload("opened"))).status).toBe(409);
  expect(await snapshot()).toEqual(before); expect((await store.db.task.findUniqueOrThrow({ where: { id: second.id } })).prNumber).toBe(43);
});

it("HOOK unrelated review comment and no-op open can be observed during reservation without invalidation", async () => {
  await f.evidence("merge"); await f.service.reserveMerge(f.taskId, actor, "reserved"); const before = await snapshot();
  expect((await request(payload("approved"), "comment")).status).toBe(200);
  expect((await request(payload("opened"), "noop")).status).toBe(200);
  const after = await snapshot(); expect(after.task).toEqual(before.task); expect(after.binding).toEqual(before.binding); expect(after.attempts).toEqual(before.attempts); expect(after.cohort).toEqual(before.cohort);
});

it.each([false, true])("HOOK changes-requested invalidates changed status and reservation collision=%s rolls everything back", async reserved => {
  await store.db.task.update({ where: { id: f.taskId }, data: { status: "review" } }); await f.evidence("merge");
  if (reserved) await f.service.reserveMerge(f.taskId, actor, "reserved");
  const before = await snapshot(); const response = await request(payload("changes_requested"));
  expect(response.status).toBe(reserved ? 409 : 200);
  const after = await snapshot();
  if (reserved) { expect(after).toEqual(before); return; }
  expect(after.task?.status).toBe("in_progress"); expect(after.task?.claimedByAgentId).toBe(before.task?.claimedByAgentId);
  expect(after.attempts[0].state).toBe("SUPERSEDED"); expect(after.binding?.activeAttemptId).toBeNull(); expect(after.binding?.contextRevision).toBe(before.binding!.contextRevision + 1);
});

it.each(["same", "changed", "reserved"])("HOOK reopen %s head observes without invented status and invalidates only changed authoritative context", async variant => {
  await f.evidence("merge"); if (variant === "reserved") await f.service.reserveMerge(f.taskId, actor, "reserved");
  const before = await snapshot(); const response = await request(payload("reopened", variant === "same" ? f.head : "c".repeat(40)));
  expect(response.status).toBe(variant === "reserved" ? 409 : 200);
  const after = await snapshot();
  if (variant === "reserved") { expect(after).toEqual(before); return; }
  expect(after.task).toEqual(before.task);
  if (variant === "same") { expect(after.binding).toEqual(before.binding); expect(after.attempts).toEqual(before.attempts); }
  else { expect(after.binding?.activeAttemptId).toBeNull(); expect(after.attempts[0].state).toBe("SUPERSEDED"); }
});

it.each([false, true])("HOOK exact unprovisioned PR merge preserves legacy review/done behavior, autonomous=%s", async autonomous => {
  await store.db.project.update({ where: { id: f.projectId }, data: { soloMode: autonomous } });
  const legacy = await unprovisioned(); await signal(legacy.id);
  expect((await request()).status).toBe(200);
  const task = await store.db.task.findUniqueOrThrow({ where: { id: legacy.id } });
  expect(task.status).toBe(autonomous ? "done" : "review"); expect(task.claimedByAgentId).toBe(ids.agent);
  const row = await store.db.signal.findFirstOrThrow({ where: { taskId: legacy.id } }); expect(row.acknowledgedAt !== null).toBe(autonomous);
  expect((await f.task()).status).toBe("in_progress");
});

it("HOOK legacy issue-close status and signal acknowledgement stay transactional and claims remain unchanged", async () => {
  const legacy = await unprovisioned(); await signal(legacy.id);
  expect((await request(payload("issue_closed"))).status).toBe(200);
  const task = await store.db.task.findUniqueOrThrow({ where: { id: legacy.id } }); expect(task.status).toBe("done"); expect(task.claimedByAgentId).toBe(ids.agent);
  expect((await store.db.signal.findFirstOrThrow({ where: { taskId: legacy.id } })).acknowledgedAt).not.toBeNull();
  expect((await f.task()).status).toBe("in_progress");
});

it("HOOK weak legacy PR hints are visible pending observations rather than positive transitions", async () => {
  const legacy = await unprovisioned(); await store.db.task.update({ where: { id: legacy.id }, data: { prNumber: null, prUrl: null } });
  expect((await request()).status).toBe(200);
  expect((await store.db.task.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe("in_progress");
  expect(await store.db.groundingGithubObservation.findFirstOrThrow({ where: { taskId: legacy.id } })).toMatchObject({ state: "PENDING", reason: "weak_binding" });
});

it("HOOK canonical cross-project foreign-repo binding is observed and malformed incoming identity has no effects", async () => {
  const project = await store.db.project.create({ data: { teamId: ids.team, name: "Foreign", slug: randomUUID(), githubRepo: "other/repo" } });
  const task = await store.db.task.create({ data: { projectId: project.id, title: "Foreign", status: "in_progress", deliverableRepo: repo.toUpperCase(), prNumber: 42, prUrl: `https://github.com/${repo.toUpperCase()}/pull/42` } });
  const bad = payload(); if ("pull_request" in bad && bad.pull_request) bad.pull_request.html_url = `https://github.com/${repo}/pull/43`;
  expect((await request(bad, "bad")).status).toBe(400);
  expect((await snapshot()).deliveries).toHaveLength(0);
  expect((await request()).status).toBe(200);
  expect(await store.db.groundingGithubObservation.findFirstOrThrow({ where: { taskId: task.id } })).toMatchObject({ repo, matchKind: "EXACT" });
});

it("HOOK opened issues are created once per delivery and issue-reopen invents no status change", async () => {
  const count = await store.db.task.count({ where: { projectId: f.projectId } });
  expect((await request(payload("issue_opened"), "created")).status).toBe(200);
  expect((await request(payload("issue_opened"), "created")).status).toBe(200);
  expect(await store.db.task.count({ where: { projectId: f.projectId } })).toBe(count + 1);
  const before = await f.task(); expect((await request(payload("issue_reopened"), "reopen")).status).toBe(200); expect(await f.task()).toEqual(before);
});
