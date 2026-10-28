/**
 * Inventory of the Grounding `forbidden` refusals behind pull_requests_create
 * (PRC), pull_requests_merge (PRM), task_merge (TM), task_finish approve /
 * request_changes / work (TFA / TFR / TFW), task_abandon (TAB) and
 * task_grounding_attempt_create (TGA). The table in this comment is the
 * inventory: one line per site with its id, file:line, verbs and decision.
 * Row id = inventory id: every row of the table-driven test below pins
 * the exact response body of one reachable messaged site. Every message is
 * raised only after the caller's access to the project was verified (the
 * route's own canWrite / hasProjectAccess, the TGA admit step, or the
 * operation-access step that precedes the decision), so none reveals more
 * than the caller may see.
 *
 * id   site (backend/src/...:line)                          verbs                 decision
 * I01  routes/grounding-github.ts:69                        PRC                   message: absent scopes / Agent token required
 * I02  routes/grounding-github.ts:115                       PRM                   message: absent scopes / Agent token required
 * I03  routes/grounding-task-completion.ts:98               TM TF* TAB            message: absent admission scope
 * I04  routes/grounding-task-completion.ts:103              TM TF* TAB            message: No write access to this project
 * I05  routes/grounding-task-completion.ts:153              TF*                   message: neither claim held
 * I06  services/grounding-context.ts:101 (builder :88-92)   TM PRM                message: review lock missing / held by claimant
 * I07  services/grounding-context.ts:105                    TM PRM                message: transition role
 * I08  services/grounding-context.ts:106                    TM PRM                message: allowAgentPrMerge consent
 * I09  services/grounding-completion.ts:122                 TM PRM TF+autoMerge   message: self-merge blocked
 * I10  services/grounding-completion-gates.ts:28            TM PRM TF+autoMerge   message: foreign deliverable
 * I11  services/grounding-context.ts:130                    TFA                   message: review claim required
 * I12  services/grounding-context.ts:133                    TFA                   message: review approval gate
 * I13  services/grounding-context.ts:149                    TFW TFA               message: transition role
 * I14  services/grounding-completion.ts:131 and :133        TFR                   message: review claim / approval gate
 * I15  services/grounding-completion-gates.ts:26            TFR                   message: transition role
 * I16  services/grounding-completion.ts:165                 TAB                   message: neither claim held
 * I17  services/grounding-completion.ts:188                 TM PRM TF TAB         message: active attempt belongs to another caller
 * I18  services/grounding-operations.ts:46                  TM PRM TF TAB         message: Idempotency-Key used by another caller
 * I19  services/grounding-github-merge.ts:106               PRM                   message: Idempotency-Key used by another caller
 * I20  services/grounding-merge-provider.ts:17 and :19      TF+autoMerge          message: github:pr_merge scope / merge consent
 * I21  services/grounding-github-create.ts:46               PRC                   message: allowAgentPrCreate consent
 * I22  services/grounding-github-create.ts:50               PRC replay            message: allowAgentPrCreate consent
 * I23  services/grounding-github-create.ts:38               PRC replay            message: Idempotency-Key used by another caller
 * I24  services/grounding-attempts.ts:85                    TGA                   message: absent scope
 * I25  services/grounding-attempts.ts:87                    TGA                   message: neither claim held
 * I26  services/grounding-context.ts:106 via TGA            TGA                   message: merge consent (routes/grounding.ts error handler carries it)
 * I27  services/grounding-attempts.ts:81                    TGA                   deliberately bare: no access, one 403 whatever the task's state
 * RE   services/grounding-context.ts:139                    TGA intent merge      message: self-merge blocked (work claimant, work state)
 * RF   services/grounding-completion.ts:122, LEGACY_LOCAL   TM                    message: self-merge blocked on an admin-migrated task
 * RA-RD, RG, RH, RI-RX  TGA admission precedence (grounding-attempts.ts authorizeRouteIssue). The rule is written in
 *      docs/agent-workflow.md (the single source; this table maps it to rows):
 *      Per combination of {holds a claim, has tasks:transition, has github:pr_merge} the route sees, for an agent token:
 *        claim, tasks:transition, any pr_merge       -> admitted by the claim path (the later policy decides)
 *        claim, no tasks:transition, no pr_merge     -> the tasks:transition scope (RB)
 *        claim, no tasks:transition, pr_merge        -> admitted when merge eligibility admits, else the tasks:transition scope
 *                                                       (RD, RN), except 409 bad_state on the initial or a terminal state or
 *                                                       an ambiguous review workflow (RP, RQ)
 *        no claim, tasks:transition, no pr_merge     -> the claim refusal (RA, RC)
 *        no claim, tasks:transition, pr_merge        -> admitted when merge eligibility admits, else the claim refusal (RG),
 *                                                       except the same 409 bad_state (RH)
 *        no claim, no tasks:transition, no pr_merge  -> the tasks:transition scope (RK: not merge-capable)
 *        no claim, no tasks:transition, pr_merge     -> the merge-only token: admitted by merge eligibility when it admits (I24: then the
 *                                                       later policy of intent finish refuses with the scope), else its own
 *                                                       refusal whatever the intent: RI consent, RJ review lock,
 *                                                       RL / RR 409 bad_state on in_progress, RM transition role, RS consent
 *                                                       for intent finish; RT is the bare 403 without project access
 *      A human has no scope: with a claim, admitted by the claim path; without one, admitted when merge eligibility admits (RW),
 *      else the claim refusal (RO), except the same 409 bad_state (RV).
 *      An unavailable workflow definition keeps its own answer (RX: grounding_verification_unavailable).
 *      RU: an unexpected error of the merge-actor check on the merge-only path propagates as the service's
 *      grounding_verification_unavailable error; it is not a scope refusal.
 *
 * Deliberately bare or unreachable, not rows of this table:
 *  - PRC / PRM callers without access, and a missing task: the legacy handler's own answer via next()
 *    (grounding-github.ts:81-82 and :129-130); pinned by grounding-github-routes.test.ts.
 *  - Reachable only when access, the token or a claim changes between the route's own check and the locked
 *    decision (TOCTOU): grounding-github.ts:158, grounding-github-create.ts:42, grounding-operations.ts:49,
 *    grounding-attempts.ts:86, grounding-route-effects.ts:85, grounding-direct-authority.ts:15,
 *    grounding-context.ts:73, :74 and :136 (the last pinned by the unit test in grounding-context.test.ts).
 *  - Unreachable from these routes because an earlier identical predicate refuses first or no route builds the
 *    request: grounding-context.ts:99, :120, :122, grounding-completion.ts:91 (route scope check first),
 *    :78, :93, :103, :106 (direct-route descriptors and override reasons exist only on the direct routes),
 *    :146, :156, :160 (creator_abandon, reopen, release are built by no route), grounding-github-create.ts:15,
 *    grounding-merge-provider.ts:17 on PRM and TM (decide checks the scope first).
 *  - A linked task of another project in a multi-task merge that the caller cannot write: bare from
 *    grounding-operations.ts:49, so the group's membership of a project the caller cannot see stays unobservable.
 *  - Other verbs, not behind these routes: grounding-direct-*.ts, grounding-creation.ts, grounding-migration.*,
 *    the receipt upload (grounding-attempts.ts:166 and :296) and direct attempt issue (:234).
 */
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
const harness = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: new Proxy({}, { get: (_target, property) => { const value = Reflect.get(harness.db!, property); return typeof value === "function" ? value.bind(harness.db) : value; } }) }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("../../src/services/confidence-telemetry.js", () => ({ recordBounceBack: vi.fn(), recordTerminalSnapshot: vi.fn(), recordClarification: vi.fn(), recordAbandonDisposition: vi.fn(), clearDisposition: vi.fn() }));
import { createApp } from "../../src/app.js";
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { GroundingGithubMergeService } from "../../src/services/grounding-github-merge.js";
import { GroundingGithubCreateService } from "../../src/services/grounding-github-create.js";
import { githubCreateCorrelationMarker, type GroundingGithubCreateProvider } from "../../src/services/grounding-github-create-provider.js";
import { createGroundingRemoteTargetGuard, type GroundingEnforcedScope } from "../../src/services/grounding-scope.js";
import { defaultWorkflowDefinition } from "../../src/services/default-workflow.js";
import { completionFixture, completionStore, completionActor } from "../helpers/grounding-completion-fixtures.js";
import { ids } from "../helpers/grounding-fixtures.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;
let repo: string;
const token = "refusal-inventory-test-token";
const actor = { ...completionActor, scopes: [...completionActor.scopes, "github:pr_create"] };
const foreign = { user: randomUUID(), team: randomUUID(), agent: randomUUID(), token: "refusal-inventory-foreign-token" };
beforeAll(async () => {
  store = await completionStore(); harness.db = store.db;
  await store.db.user.create({ data: { id: foreign.user, login: "foreign", githubAccessToken: "test-only", githubConnectedAt: new Date(), allowAgentPrCreate: true, allowAgentPrMerge: true } });
  await store.db.team.create({ data: { id: foreign.team, name: "Foreign", slug: `foreign-${foreign.team}` } });
  await store.db.teamMember.create({ data: { teamId: foreign.team, userId: foreign.user, role: "ADMIN" } });
  await store.db.agentToken.create({ data: { id: foreign.agent, teamId: foreign.team, createdById: foreign.user, name: "Foreign", tokenHash: createHash("sha256").update(foreign.token).digest("hex"), scopes: actor.scopes } });
}, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => {
  vi.stubEnv("REDIS_URL", ""); vi.stubEnv("GITHUB_WEBHOOK_SECRET", "configured-test-secret");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("external HTTP disabled")));
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { tokenHash: createHash("sha256").update(token).digest("hex"), scopes: actor.scopes, revokedAt: null } });
  await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrCreate: true, allowAgentPrMerge: true } });
  f = await completionFixture(store, "EXTERNAL_V1", deps => new GroundingGithubMergeService(deps));
  repo = `inventory_${randomUUID().replaceAll("-", "")}`;
  await store.db.project.update({ where: { id: f.projectId }, data: { githubRepo: `acme/${repo}`, governanceMode: "AUTONOMOUS" } });
  await store.db.task.update({ where: { id: f.taskId }, data: { prUrl: `https://github.com/acme/${repo}/pull/42` } });
  f.proof.repo = `acme/${repo}`;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const defaultScope = (): GroundingEnforcedScope => ({ projectIds: new Set([f.projectId]), repos: new Set([`acme/${repo}`]) });
const app = (githubCreate?: GroundingGithubCreateService, scope: GroundingEnforcedScope = defaultScope()) =>
  createApp("", f.attempts, { db: store.db, service: f.service, githubCreate, scope, remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope }) });
function request(body: unknown, path: string, key: string | null = "inventory-key", auth: string | null = token) {
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(key === null ? {} : { "Idempotency-Key": key }), ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }) }, body: JSON.stringify(body) });
}
const task = (endpoint: string) => `/api/tasks/${f.taskId}/${endpoint}`;
const mergeBody = () => ({ taskId: f.taskId, owner: "acme", repo });
const createBody = () => ({ taskId: f.taskId, owner: "acme", repo, head: "new", title: "Create" });
const refused = (message: string) => ({ status: 403, body: { error: "forbidden", message } });
const data = (patch: Record<string, unknown>) => store.db.task.update({ where: { id: f.taskId }, data: patch });
const scopes = (value: string[]) => store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: value } });
const governance = (mode: "AUTONOMOUS" | "AWAITS_CONFIRMATION" | "REQUIRES_DISTINCT_REVIEWER") => store.db.project.update({ where: { id: f.projectId }, data: { governanceMode: mode } });
async function otherAgent() {
  const id = randomUUID(); const secret = `other-${id}`;
  await store.db.agentToken.create({ data: { id, teamId: ids.team, createdById: ids.user, name: "Other", tokenHash: createHash("sha256").update(secret).digest("hex"), scopes: actor.scopes } });
  return { id, token: secret };
}
/** The agent is a third-party merger of a task whose work claim is the human's. */
async function mergerOfReview(mode: Parameters<typeof governance>[0] = "AUTONOMOUS") {
  await governance(mode);
  await data({ status: "review", claimedByAgentId: null, claimedByUserId: ids.user });
}
/** An ambiguous review workflow: two terminal edges leave review, so the merge route cannot pick a target. */
async function twoTerminalEdges() {
  const definition = defaultWorkflowDefinition();
  definition.states.push({ name: "cancelled", label: "Cancelled", terminal: true, agentInstructions: "" });
  definition.transitions.push({ from: "review", to: "cancelled", label: "Cancel", requiredRole: "any" });
  await store.db.workflow.create({ data: { projectId: f.projectId, name: "Two terminal edges", isDefault: true, definition: definition as object } });
}
async function gatedWorkflow(match: (edge: { from: string; to: string }) => boolean) {
  const definition = defaultWorkflowDefinition();
  for (const edge of definition.transitions) if (match(edge)) (edge as { requiredRole?: string }).requiredRole = "HUMAN_MEMBER";
  await store.db.workflow.create({ data: { projectId: f.projectId, name: "Role gated", isDefault: true, definition: definition as object } });
}
function createFixture() {
  const raw = { number: 43, html_url: `https://github.com/acme/${repo}/pull/43`, title: "Create", head: { label: "acme:new", ref: "new", sha: f.head, repo: { full_name: `acme/${repo}`, owner: { login: "acme" } } }, base: { ref: "main", repo: { full_name: `acme/${repo}` } } };
  const proof = (operationId: string) => ({ ...structuredClone(raw), body: `\n\n${githubCreateCorrelationMarker(operationId)}` });
  const create = vi.fn<GroundingGithubCreateProvider["create"]>(async (_request, _token, operationId) => proof(operationId));
  const read = vi.fn<GroundingGithubCreateProvider["read"]>(async (_request, _token, operationId) => ({ complete: true, pullRequests: [proof(operationId)] }));
  return new GroundingGithubCreateService({ db: store.db, provider: { create, read } });
}
async function unenroll() {
  await store.db.groundingBinding.delete({ where: { taskId: f.taskId } });
  await store.db.groundingCohort.delete({ where: { taskId: f.taskId } });
}

interface Row { id: string; label: string; run: () => Promise<Response>; expected: { status: number; body: unknown } }
const rows: Row[] = [
  { id: "I01", label: "PRC names every absent scope",
    run: async () => { await scopes(["tasks:comment"]); return app().fetch(request(createBody(), "/api/github/pull-requests", null)); },
    expected: refused("Token missing scope: tasks:update, github:pr_create") },
  { id: "I02", label: "PRM names the absent scope",
    run: async () => { await scopes(["github:pr_merge"]); return app().fetch(request(mergeBody(), "/api/github/pull-requests/42/merge")); },
    expected: refused("Token missing scope: tasks:transition") },
  { id: "I03", label: "TM names the absent admission scope",
    run: async () => { await scopes(["tasks:transition", "tasks:claim"]); return app().fetch(request({}, task("merge"))); },
    expected: refused("Token missing scope: github:pr_merge") },
  { id: "I03", label: "TF names the absent admission scope",
    run: async () => { await scopes(["tasks:claim", "github:pr_merge"]); return app().fetch(request({}, task("finish"))); },
    expected: refused("Token missing scope: tasks:transition") },
  { id: "I03", label: "TAB names the absent admission scope",
    run: async () => { await scopes(["tasks:transition", "github:pr_merge"]); return app().fetch(request({}, task("abandon"))); },
    expected: refused("Token missing scope: tasks:claim") },
  { id: "I04", label: "a completion route names the missing project write access",
    run: async () => app().fetch(request({}, task("finish"), "inventory-key", foreign.token)),
    expected: refused("No write access to this project") },
  { id: "I05", label: "TF without either claim",
    run: async () => { await data({ claimedByAgentId: null, claimedByUserId: null, reviewClaimedByAgentId: null, reviewClaimedByUserId: null }); return app().fetch(request({ result: "done" }, task("finish"))); },
    expected: refused("You hold neither the work claim nor the review claim on this task") },
  { id: "I06", label: "TM names the missing review lock",
    run: async () => { await mergerOfReview("REQUIRES_DISTINCT_REVIEWER"); return app().fetch(request({}, task("merge"))); },
    expected: refused("Review approval is blocked: no review lock is held on this task") },
  { id: "I06", label: "TM names a review lock held by the work claimant",
    run: async () => { await mergerOfReview("REQUIRES_DISTINCT_REVIEWER"); await data({ reviewClaimedByUserId: ids.user }); return app().fetch(request({}, task("merge"))); },
    expected: refused("Review approval is blocked: the review lock is held by the work claimant") },
  { id: "I07", label: "TM names the transition role",
    run: async () => { await mergerOfReview(); await gatedWorkflow(edge => edge.to === "done"); return app().fetch(request({}, task("merge"))); },
    expected: refused("The transition to done requires the HUMAN_MEMBER project role") },
  { id: "I08", label: "TM names the missing merge consent",
    run: async () => { await mergerOfReview(); await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } }); return app().fetch(request({}, task("merge"))); },
    expected: refused("No team member allows agent PR merges (allowAgentPrMerge)") },
  { id: "I09", label: "TM names the self-merge gate",
    run: async () => { await mergerOfReview("REQUIRES_DISTINCT_REVIEWER"); await data({ claimedByUserId: null, claimedByAgentId: ids.agent }); return app().fetch(request({}, task("merge"))); },
    expected: refused("Self-merge is blocked: a distinct reviewer must merge") },
  { id: "I10", label: "TM names the foreign deliverable repository",
    run: async () => { await mergerOfReview(); await data({ deliverableRepo: "acme/other", prUrl: "https://github.com/acme/other/pull/9", prNumber: 9 }); return app().fetch(request({}, task("merge"))); },
    expected: refused("The task's PR lives in a repository foreign to this project, so this project's delegation cannot merge it") },
  { id: "I11", label: "TFA names the review claim requirement",
    run: async () => { const other = await otherAgent(); await data({ status: "review", reviewClaimedByAgentId: other.id }); return app().fetch(request({ outcome: "approve" }, task("finish"))); },
    expected: refused("Approving or requesting changes requires the review claim on this task, or the work claim while no review claim is held") },
  { id: "I12", label: "TFA names the review approval gate",
    run: async () => { await governance("REQUIRES_DISTINCT_REVIEWER"); await data({ status: "review", reviewClaimedByAgentId: ids.agent }); return app().fetch(request({ outcome: "approve" }, task("finish"))); },
    expected: refused("Review approval is blocked: the work claimant cannot approve their own work") },
  { id: "I13", label: "TFW names the transition role",
    run: async () => { await gatedWorkflow(edge => edge.to === "review"); return app().fetch(request({ result: "done" }, task("finish"))); },
    expected: refused("The transition to review requires the HUMAN_MEMBER project role") },
  { id: "I13", label: "TFA names the transition role",
    run: async () => { await gatedWorkflow(edge => edge.from === "review" && edge.to === "done"); await data({ status: "review", reviewClaimedByAgentId: ids.agent, claimedByAgentId: null, claimedByUserId: ids.user }); return app().fetch(request({ outcome: "approve" }, task("finish"))); },
    expected: refused("The transition to done requires the HUMAN_MEMBER project role") },
  { id: "I14", label: "TFR names the review claim requirement",
    run: async () => { const other = await otherAgent(); await data({ status: "review", reviewClaimedByAgentId: other.id }); return app().fetch(request({ outcome: "request_changes" }, task("finish"))); },
    expected: refused("Approving or requesting changes requires the review claim on this task, or the work claim while no review claim is held") },
  { id: "I14", label: "TFR names the review approval gate for an unclaimed review",
    run: async () => { await governance("REQUIRES_DISTINCT_REVIEWER"); await data({ status: "review" }); return app().fetch(request({ outcome: "request_changes" }, task("finish"))); },
    expected: refused("Review approval is blocked: the work claimant cannot approve their own work") },
  { id: "I15", label: "TFR names the transition role",
    run: async () => { await gatedWorkflow(edge => edge.from === "review" && edge.to === "in_progress"); await data({ status: "review", claimedByAgentId: null, claimedByUserId: ids.user, reviewClaimedByAgentId: ids.agent }); return app().fetch(request({ outcome: "request_changes" }, task("finish"))); },
    expected: refused("The transition to in_progress requires the HUMAN_MEMBER project role") },
  { id: "I16", label: "TAB without either claim",
    run: async () => { await data({ claimedByAgentId: null, claimedByUserId: null }); return app().fetch(request({}, task("abandon"))); },
    expected: refused("You hold neither the work claim nor the review claim on this task") },
  { id: "I17", label: "an active grounding attempt issued to another caller",
    run: async () => {
      await f.evidence("finish");
      const other = await otherAgent(); await data({ claimedByAgentId: other.id });
      return app().fetch(request({ result: "done" }, task("finish"), "inventory-key", other.token));
    },
    expected: refused("The active grounding attempt was issued to a different caller; issue a new one with task_grounding_attempt_create") },
  { id: "I18", label: "an Idempotency-Key already used by another caller on a completion route",
    run: async () => {
      const other = await otherAgent();
      await store.db.groundingOperation.create({ data: { taskId: f.taskId, key: "shared-key", actorType: "agent", actorId: other.id, fingerprint: "other", request: {}, decision: {}, state: "COMPLETED" } });
      return app().fetch(request({ result: "done" }, task("finish"), "shared-key"));
    },
    expected: refused("This Idempotency-Key was already used on this task by a different caller") },
  { id: "I19", label: "a merge group recorded for another caller",
    run: async () => {
      await data({ status: "review", claimedByAgentId: null, claimedByUserId: ids.user, reviewClaimedByAgentId: ids.agent });
      await f.evidence("merge");
      const a = app(); const first = await a.fetch(request(mergeBody(), "/api/github/pull-requests/42/merge")); expect(first.status).toBe(200);
      await store.db.groundingGithubMergeGroup.updateMany({ where: { seedTaskId: f.taskId }, data: { actorId: randomUUID() } });
      return a.fetch(request(mergeBody(), "/api/github/pull-requests/42/merge"));
    },
    expected: refused("This Idempotency-Key was already used on this task by a different caller") },
  { id: "I20", label: "TF with autoMerge names the absent github:pr_merge scope",
    run: async () => {
      await data({ status: "review", claimedByAgentId: null, claimedByUserId: ids.user, reviewClaimedByAgentId: ids.agent });
      await f.evidence("approve"); await scopes(["tasks:transition"]);
      return app().fetch(request({ outcome: "approve", autoMerge: true }, task("finish")));
    },
    expected: refused("Token missing scope: github:pr_merge") },
  { id: "I20", label: "TF with autoMerge names the missing merge consent",
    run: async () => {
      await data({ status: "review", claimedByAgentId: null, claimedByUserId: ids.user, reviewClaimedByAgentId: ids.agent });
      await f.evidence("approve"); await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } });
      return app().fetch(request({ outcome: "approve", autoMerge: true }, task("finish")));
    },
    expected: refused("No team member allows agent PR merges (allowAgentPrMerge)") },
  { id: "I21", label: "PRC names the missing create consent",
    run: async () => { await unenroll(); await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrCreate: false } }); return app(createFixture()).fetch(request(createBody(), "/api/github/pull-requests")); },
    expected: refused("No team member with a connected GitHub account allows agent PR creation (allowAgentPrCreate)") },
  { id: "I22", label: "PRC replay after the delegating member withdrew consent",
    run: async () => {
      await unenroll(); const a = app(createFixture());
      expect((await a.fetch(request(createBody(), "/api/github/pull-requests"))).status).toBe(201);
      await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrCreate: false } });
      return a.fetch(request(createBody(), "/api/github/pull-requests"));
    },
    expected: refused("No team member with a connected GitHub account allows agent PR creation (allowAgentPrCreate)") },
  { id: "I23", label: "PRC replay of a key another caller created",
    run: async () => {
      await unenroll(); const a = app(createFixture());
      expect((await a.fetch(request(createBody(), "/api/github/pull-requests"))).status).toBe(201);
      const other = await otherAgent();
      return a.fetch(request(createBody(), "/api/github/pull-requests", "inventory-key", other.token));
    },
    expected: refused("This Idempotency-Key was already used on this task by a different caller") },
  { id: "I24", label: "TGA names the absent tasks:transition scope",
    run: async () => { await mergerOfReview(); await scopes(["github:pr_merge"]); return app().fetch(request({ intent: "finish" }, task("grounding-attempts"), null)); },
    expected: refused("Token missing scope: tasks:transition") },
  { id: "I25", label: "TGA without either claim",
    run: async () => { await mergerOfReview(); return app().fetch(request({ intent: "finish" }, task("grounding-attempts"), null)); },
    expected: refused("You hold neither the work claim nor the review claim on this task") },
  { id: "I26", label: "TGA intent merge by the review claimant surfaces the missing merge consent of the merge eligibility check",
    run: async () => { await mergerOfReview(); await data({ reviewClaimedByAgentId: ids.agent }); await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } }); return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null)); },
    expected: refused("No team member allows agent PR merges (allowAgentPrMerge)") },
  { id: "I27", label: "TGA stays one bare 403 for a caller without project access",
    run: async () => app().fetch(request({ intent: "finish" }, task("grounding-attempts"), null, foreign.token)),
    expected: { status: 403, body: { error: "forbidden" } } },
  // TGA admission precedence (before the intent is read): the claim and scope check wins over a merge-eligibility
  // refusal, and over the merge route's bad_state on a work state outside review; any other merge-eligibility
  // error keeps its own answer. A merge-only token (RI-RM, RR, RS) is the exception and gets merge eligibility's refusal.
  { id: "RA", label: "TGA finish on an in_progress task the agent did not claim, token without github:pr_merge: the claim refusal, not the merge scope",
    run: async () => { await data({ claimedByAgentId: null, claimedByUserId: null }); await scopes(["tasks:transition", "tasks:update", "tasks:claim"]); return app().fetch(request({ intent: "finish" }, task("grounding-attempts"), null)); },
    expected: refused("You hold neither the work claim nor the review claim on this task") },
  { id: "RB", label: "TGA finish by the work claimant whose token lacks tasks:transition and github:pr_merge: the tasks:transition scope",
    run: async () => { await scopes(["tasks:update", "tasks:claim"]); return app().fetch(request({ intent: "finish" }, task("grounding-attempts"), null)); },
    expected: refused("Token missing scope: tasks:transition") },
  { id: "RC", label: "TGA finish on an in_progress task the agent did not claim, full scopes: the claim refusal, not the merge route's bad_state",
    run: async () => { await data({ claimedByAgentId: null, claimedByUserId: null }); return app().fetch(request({ intent: "finish" }, task("grounding-attempts"), null)); },
    expected: refused("You hold neither the work claim nor the review claim on this task") },
  { id: "RD", label: "TGA approve by the work claimant without tasks:transition on a review task under REQUIRES_DISTINCT_REVIEWER: the scope, not the self-merge gate",
    run: async () => { await governance("REQUIRES_DISTINCT_REVIEWER"); await data({ status: "review", reviewClaimedByAgentId: null, reviewClaimedByUserId: null }); await scopes(["tasks:update", "tasks:claim", "github:pr_merge"]); return app().fetch(request({ intent: "approve" }, task("grounding-attempts"), null)); },
    expected: refused("Token missing scope: tasks:transition") },
  { id: "RG", label: "TGA intent merge by a non-claimant that merge eligibility refuses too (no merge consent): the claim refusal",
    run: async () => { await mergerOfReview(); await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } }); return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null)); },
    expected: refused("You hold neither the work claim nor the review claim on this task") },
  { id: "RH", label: "TGA by a non-claimant on a review task with two terminal edges: the merge route's bad_state stays",
    run: async () => { await twoTerminalEdges(); await mergerOfReview(); return app().fetch(request({ intent: "finish" }, task("grounding-attempts"), null)); },
    expected: { status: 409, body: { error: "bad_state" } } },
  // Merge-only token (github:pr_merge, no tasks:transition, no claim): the gate merge eligibility refused with, whatever the intent.
  { id: "RI", label: "TGA by a merge-only non-claimant without merge consent: the consent, not the tasks:transition scope",
    run: async () => { await mergerOfReview(); await scopes(["github:pr_merge"]); await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } }); return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null)); },
    expected: refused("No team member allows agent PR merges (allowAgentPrMerge)") },
  { id: "RJ", label: "TGA by a merge-only non-claimant under REQUIRES_DISTINCT_REVIEWER without a review lock: the review lock, not the tasks:transition scope",
    run: async () => { await mergerOfReview("REQUIRES_DISTINCT_REVIEWER"); await scopes(["github:pr_merge"]); return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null)); },
    expected: refused("Review approval is blocked: no review lock is held on this task") },
  { id: "RK", label: "TGA by a token with no scopes at all (not merge-capable): the tasks:transition scope, no merge gate",
    run: async () => { await mergerOfReview(); await scopes([]); return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null)); },
    expected: refused("Token missing scope: tasks:transition") },
  { id: "RL", label: "TGA by a merge-only non-claimant on an in_progress task: the merge route's bad_state 409, as task_merge answers",
    run: async () => { await data({ claimedByAgentId: null, claimedByUserId: null }); await scopes(["github:pr_merge"]); return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null)); },
    expected: { status: 409, body: { error: "bad_state" } } },
  { id: "RM", label: "TGA by a merge-only non-claimant on a role-gated terminal edge: the transition role, not the tasks:transition scope",
    run: async () => { await mergerOfReview(); await scopes(["github:pr_merge"]); await gatedWorkflow(edge => edge.to === "done"); return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null)); },
    expected: refused("The transition to done requires the HUMAN_MEMBER project role") },
  { id: "RN", label: "TGA by a merge-only non-claimant that holds the review claim and has no merge consent: the tasks:transition scope, not the consent",
    run: async () => { await mergerOfReview(); await data({ reviewClaimedByAgentId: ids.agent }); await scopes(["github:pr_merge"]); await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } }); return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null)); },
    expected: refused("Token missing scope: tasks:transition") },
  { id: "RP", label: "TGA by a review-claim holder with only github:pr_merge on a review task with two terminal edges: the merge route's bad_state, not the tasks:transition scope",
    run: async () => { await twoTerminalEdges(); await mergerOfReview(); await data({ reviewClaimedByAgentId: ids.agent }); await scopes(["github:pr_merge"]); return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null)); },
    expected: { status: 409, body: { error: "bad_state" } } },
  { id: "RQ", label: "TGA by the work claimant with only github:pr_merge on a done task: the merge route's bad_state, not the tasks:transition scope",
    run: async () => { await data({ status: "done" }); await scopes(["github:pr_merge"]); return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null)); },
    expected: { status: 409, body: { error: "bad_state" } } },
  { id: "RR", label: "TGA intent finish by a merge-only non-claimant on an in_progress task: the same bad_state 409 as intent merge, the intent does not matter",
    run: async () => { await data({ claimedByAgentId: null, claimedByUserId: null }); await scopes(["github:pr_merge"]); return app().fetch(request({ intent: "finish" }, task("grounding-attempts"), null)); },
    expected: { status: 409, body: { error: "bad_state" } } },
  { id: "RS", label: "TGA intent finish by a merge-only non-claimant on a review task without merge consent: the consent, the intent does not matter",
    run: async () => { await mergerOfReview(); await scopes(["github:pr_merge"]); await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } }); return app().fetch(request({ intent: "finish" }, task("grounding-attempts"), null)); },
    expected: refused("No team member allows agent PR merges (allowAgentPrMerge)") },
  { id: "RT", label: "TGA by a merge-only token of another team: one bare 403 without a message, whatever the task's state",
    run: async () => {
      await mergerOfReview();
      const id = randomUUID(); const secret = `foreign-merge-only-${id}`;
      await store.db.agentToken.create({ data: { id, teamId: foreign.team, createdById: foreign.user, name: "Foreign merge-only", tokenHash: createHash("sha256").update(secret).digest("hex"), scopes: ["github:pr_merge"] } });
      return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null, secret));
    },
    expected: { status: 403, body: { error: "forbidden" } } },
  { id: "RE", label: "TGA intent merge on an in_progress task by its work claimant under REQUIRES_DISTINCT_REVIEWER",
    run: async () => { await governance("REQUIRES_DISTINCT_REVIEWER"); return app().fetch(request({ intent: "merge" }, task("grounding-attempts"), null)); },
    expected: refused("Self-merge is blocked: a distinct reviewer must merge") },
];

it.each(rows.map(row => [`${row.id} ${row.label}`, row] as const))("%s", async (_name, row) => {
  const response = await row.run();
  expect({ status: response.status, body: await response.json() }).toEqual(row.expected);
  // I19 performs one real merge first to create the group it then corrupts.
  expect(f.merge).toHaveBeenCalledTimes(row.id === "I19" ? 1 : 0); expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("RO TGA by a human non-claimant that merge eligibility refuses too: the claim refusal, not the merge gate", async () => {
  await mergerOfReview(); await data({ claimedByUserId: null });
  await store.db.user.update({ where: { id: ids.user }, data: { allowAgentPrMerge: false } });
  await expect(f.attempts.authorizeRouteIssue(f.taskId, { type: "human", userId: ids.user })).rejects.toMatchObject({ code: "forbidden", status: 403, detail: "You hold neither the work claim nor the review claim on this task" });
});

it("RV TGA by a human non-claimant on a done task: merge eligibility's bad_state, not the claim refusal", async () => {
  await data({ status: "done", claimedByAgentId: null, claimedByUserId: null });
  await expect(f.attempts.authorizeRouteIssue(f.taskId, { type: "human", userId: ids.user })).rejects.toMatchObject({ code: "bad_state", status: 409 });
});

it("RW TGA by a human non-claimant on a review task that merge eligibility admits: admitted, not the claim refusal", async () => {
  await mergerOfReview(); await data({ claimedByUserId: null });
  await expect(f.attempts.authorizeRouteIssue(f.taskId, { type: "human", userId: ids.user })).resolves.not.toThrow();
});

it("RX TGA by a review-claim holder with only github:pr_merge when the default workflow definition is unavailable: the unavailable answer, not the tasks:transition scope", async () => {
  await mergerOfReview(); await data({ reviewClaimedByAgentId: ids.agent });
  await store.db.workflow.create({ data: { projectId: f.projectId, name: "Broken", isDefault: true, definition: { broken: true } as object } });
  const reviewHolder = { ...completionActor, scopes: ["github:pr_merge"] };
  await expect(f.attempts.authorizeRouteIssue(f.taskId, reviewHolder)).rejects.toMatchObject({ name: "GroundingReceiptVerificationError", code: "grounding_verification_unavailable" });
});

it("RU an unexpected error of the merge-actor check on the merge-only path propagates as the service's grounding_verification_unavailable error; it is not the tasks:transition scope refusal", async () => {
  await data({ claimedByAgentId: null, claimedByUserId: null });
  const mergeOnly = { ...completionActor, scopes: ["github:pr_merge"] };
  // Write checks in order: the route admission (1), the merge eligibility fallback (2), the merge-only classification (3).
  const service = (failOn: number) => {
    let calls = 0;
    const canWrite = vi.fn(async () => { if (++calls === failOn) throw new Error("authority unavailable"); return true; });
    return { canWrite, attempts: new GroundingAttemptsService({ db: store.db, config: { audience: "consumer.test", trust: () => f.issuer.trust }, now: () => f.now, headProvider: f.headProvider, authority: { canWrite, hasRole: async () => true } }) };
  };
  const control = service(0);
  await expect(control.attempts.authorizeRouteIssue(f.taskId, mergeOnly)).rejects.toMatchObject({ code: "bad_state", status: 409 });
  expect(control.canWrite).toHaveBeenCalledTimes(3);
  const failing = service(3);
  await expect(failing.attempts.authorizeRouteIssue(f.taskId, mergeOnly)).rejects.toMatchObject({ name: "GroundingReceiptVerificationError", code: "grounding_verification_unavailable" });
  expect(failing.canWrite).toHaveBeenCalledTimes(3);
});

it("RF an admin-migrated LEGACY_LOCAL task takes the Grounding path: task_merge's self-merge answer is forbidden with the message, not self_merge_blocked", async () => {
  const migrated = await completionFixture(store, "LEGACY_LOCAL", deps => new GroundingGithubMergeService(deps));
  await store.db.project.update({ where: { id: migrated.projectId }, data: { governanceMode: "REQUIRES_DISTINCT_REVIEWER" } });
  await store.db.task.update({ where: { id: migrated.taskId }, data: { status: "review", claimedByAgentId: ids.agent } });
  const response = await app().fetch(request({}, `/api/tasks/${migrated.taskId}/merge`));
  expect({ status: response.status, body: await response.json() }).toEqual(refused("Self-merge is blocked: a distinct reviewer must merge"));
});
