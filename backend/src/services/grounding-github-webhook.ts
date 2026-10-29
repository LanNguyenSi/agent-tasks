import { groundingTaskHeld } from "./grounding-hold.js";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type Signal } from "@prisma/client";
import { z } from "zod";
import { canonicalGithubRepo } from "./grounding-github-fence.js";
import { requireGroundingCohort } from "./grounding-cohort.js";
import { GroundingAccessError, groundingWorkflow, unavailable, type GroundingTask } from "./grounding-context.js";
import type { GroundingAttemptsService } from "./grounding-attempts.js";
import type { GroundingCreationPolicy } from "../routes/grounding-creation.js";
import { BACKLOG_STATE, isKnownState, isReviewState, isTerminalState, requestChangesTarget, resolveEffectiveDefinition, terminalTargetFrom } from "./default-workflow.js";
import { logger } from "../lib/logger.js";
import { GroundingReceiptVerificationError } from "./grounding-receipt.js";
import { GroundingDecisionError, groundingTransaction, lockGroundingProjects, lockGroundingTaskUnderProject } from "./grounding-transaction.js";
import { applyGithubObservedContext, type GithubObservedContextChange } from "./grounding-github-observation-context.js";
import { pickMergeTargetStatus } from "./github-webhook.js";
import { createInitialStatus } from "./task-status-input.js";
import { createTaskAvailableSignalsInTx } from "./task-signal.js";
import { maybeDeliverSignalWebhook } from "./signal.js";

export class GroundingGithubWebhookError extends Error {
  constructor(readonly code: "grounding_webhook_invalid" | "grounding_webhook_conflict", readonly status: 400 | 409) { super(code); }
}
function invalid(): never { throw new GroundingGithubWebhookError("grounding_webhook_invalid", 400); }
function conflict(): never { throw new GroundingDecisionError("grounding_operation_conflict"); }
const text = z.string().max(32768);
const number = z.number().int().positive().max(2147483647);
const repository = z.object({ full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) });
const pr = z.object({ number, title: text, html_url: text, head: z.object({ ref: text.optional(), sha: z.string().regex(/^[0-9a-f]{40}$/).optional() }).optional() });
const issueSchema = z.object({ action: z.string(), repository, issue: z.object({ number, title: text, body: text.nullable(), html_url: text, state: z.enum(["open", "closed"]) }) });
const prSchema = z.object({ action: z.string(), repository, pull_request: pr.extend({ state: z.enum(["open", "closed"]), merged: z.boolean(), merged_by: z.object({ login: text }).nullable().optional() }) });
const reviewSchema = z.object({ action: z.string(), repository, pull_request: pr, review: z.object({ state: z.enum(["approved", "changes_requested", "commented", "dismissed"]), user: z.object({ login: text }), html_url: text }) });
type Event = { deliveryId: string; event: string; kind: string; repo: string | null; number: number | null; url: string | null; title?: string; body?: string | null; branch?: string; head?: string; login?: string };
type Match = { task: GroundingTask; strength: "EXACT" | "WEAK" | "AMBIGUOUS" };
type EffectResult = { observed: number; changed: number };

function parse(input: { deliveryId: string; event: string; rawBody: string }): Event {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.deliveryId) || !/^[A-Za-z0-9_]{1,128}$/.test(input.event)) invalid();
  let body: unknown;
  try { body = JSON.parse(input.rawBody); } catch { invalid(); }
  const base = { deliveryId: input.deliveryId, event: input.event, kind: "ignored", repo: null, number: null, url: null };
  if (input.event === "issues") {
    const value = issueSchema.safeParse(body); if (!value.success) invalid();
    const { data } = value;
    const kind = ["opened", "closed", "reopened"].includes(data.action) ? `issue_${data.action}` : "ignored";
    return exactEvent({ ...base, kind, repo: canonicalGithubRepo(data.repository.full_name), number: data.issue.number, url: data.issue.html_url, title: data.issue.title, body: data.issue.body }, "issues");
  }
  if (input.event === "pull_request" || input.event === "pull_request_review") {
    const value = input.event === "pull_request" ? prSchema.safeParse(body) : reviewSchema.safeParse(body);
    if (!value.success) invalid();
    const data = value.data;
    let kind = "ignored", login: string | undefined;
    if ("review" in data) {
      if (data.action === "submitted" || data.action === "dismissed") kind = `review_${data.action === "dismissed" ? "dismissed" : data.review.state}`;
      login = data.review.user.login;
    } else {
      if (data.action === "closed") kind = data.pull_request.merged ? "pr_merged" : "pr_closed";
      if (data.action === "opened" || data.action === "reopened") kind = `pr_${data.action}`;
      login = data.pull_request.merged_by?.login;
    }
    return exactEvent({ ...base, kind, repo: canonicalGithubRepo(data.repository.full_name), number: data.pull_request.number, url: data.pull_request.html_url, branch: data.pull_request.head?.ref, head: data.pull_request.head?.sha, login }, "pull");
  }
  if (input.event === "push") {
    const value = z.object({ repository }).safeParse(body); if (!value.success) invalid();
    return { ...base, kind: "push", repo: canonicalGithubRepo(value.data.repository.full_name) };
  }
  return base;
}
function exactEvent(event: Event, path: "pull" | "issues") {
  const match = new RegExp(`^https://github\\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/${path}/([1-9][0-9]*)$`).exec(event.url ?? "");
  if (!match || canonicalGithubRepo(match[1]!) !== event.repo || match[2] !== String(event.number)) invalid();
  return event;
}
function canonicalOrNull(repo: string | null) { try { return repo === null ? null : canonicalGithubRepo(repo); } catch { return null; } }
function prMatch(task: GroundingTask, event: Event): Match["strength"] | null {
  const effective = canonicalOrNull(task.deliverableRepo ?? task.project.githubRepo);
  const url = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(task.prUrl ?? "");
  const strictUrl = url && canonicalOrNull(url[1]!) === event.repo && Number(url[2]) === event.number;
  const recognizable = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([0-9]+)(?:[/?#]|$)/i.exec((task.prUrl ?? "").trim());
  const urlHint = recognizable && canonicalOrNull(recognizable[1]!) === event.repo && Number(recognizable[2]) === event.number;
  if (effective === event.repo && task.prNumber === event.number && strictUrl) return "EXACT";
  if ((effective === event.repo && task.prNumber === event.number) || urlHint) {
    if (effective !== event.repo || (task.prNumber !== null && task.prNumber !== event.number) || (task.prUrl !== null && !strictUrl)) return "AMBIGUOUS";
    return "WEAK";
  }
  if (effective === event.repo && ((event.branch && task.branchName === event.branch) || task.title.includes(`[PR #${event.number}]`))) return "WEAK";
  return null;
}

/** Actorless, DB-only handler. A delivery result never commits without its required effects. */
export class GroundingGithubWebhookService {
  constructor(private readonly db: PrismaClient, private readonly attempts?: GroundingAttemptsService, private readonly creationPolicy: GroundingCreationPolicy = []) {}

  async handle(input: { deliveryId: string; event: string; rawBody: string }) {
    const event = parse(input);
    const fingerprint = createHash("sha256").update(input.rawBody).digest("hex");
    // task_available signals written by this delivery's transaction; delivered to the
    // outbound notification webhooks only after it committed. A replayed delivery returns
    // its stored result before applyEvent runs, so it adds nothing here.
    const signals: Signal[] = [];
    const result = await groundingTransaction(this.db, async tx => {
      signals.length = 0; // the callback may be retried on a serialization failure
      const inserted = await tx.$queryRaw<{ deliveryId: string }[]>`
        INSERT INTO grounding_github_webhook_deliveries ("deliveryId", event, fingerprint)
        VALUES (${input.deliveryId}, ${input.event}, ${fingerprint})
        ON CONFLICT ("deliveryId") DO NOTHING RETURNING "deliveryId"
      `;
      const delivery = await tx.groundingGithubWebhookDelivery.findUniqueOrThrow({ where: { deliveryId: input.deliveryId } });
      if (delivery.event !== input.event || delivery.fingerprint !== fingerprint) conflict();
      if (!inserted.length) {
        if (!delivery.completedAt || !delivery.result) conflict();
        return { ...(delivery.result as Record<string, unknown>), duplicate: true };
      }
      const effects = await this.applyEvent(tx, event, signals);
      const result = { received: true, event: input.event, ...effects };
      await tx.groundingGithubWebhookDelivery.update({ where: { deliveryId: input.deliveryId }, data: { result, completedAt: new Date() } });
      return result;
    });
    for (const signal of signals) void maybeDeliverSignalWebhook(signal, this.db).catch(() => {});
    return result;
  }

  private async projects(tx: Prisma.TransactionClient, event: Event) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM projects p WHERE grounding_github_repo(p."githubRepo") = ${event.repo}
      OR EXISTS (SELECT 1 FROM tasks t WHERE t."projectId" = p.id AND (
        grounding_github_repo(t."deliverableRepo") = ${event.repo} OR grounding_github_pr_repo(t."prUrl") = ${event.repo}
      )) ORDER BY p.id
    `;
    await lockGroundingProjects(tx, rows.map(row => row.id));
    return tx.project.findMany({ where: { id: { in: rows.map(row => row.id) } }, orderBy: { id: "asc" } });
  }

  private async matches(tx: Prisma.TransactionClient, event: Event, projectIds: string[]) {
    const candidates = await tx.task.findMany({ where: { projectId: { in: projectIds } }, include: { project: true }, orderBy: { id: "asc" } });
    const selected: Match[] = [];
    for (const task of candidates) {
      const strength = event.kind.startsWith("issue_")
        ? canonicalOrNull(task.project.githubRepo) === event.repo && task.title.includes(`[GH #${event.number}]`) ? "WEAK" : null
        : prMatch(task, event);
      if (strength) selected.push({ task, strength });
    }
    const locked: Match[] = [];
    for (const match of selected) {
      const task = await lockGroundingTaskUnderProject(tx, match.task.id, projectIds);
      const strength = event.kind.startsWith("issue_") ? match.strength : prMatch(task, event);
      if (!strength) conflict();
      locked.push({ task, strength });
    }
    return locked;
  }

  private async enrollment(tx: Prisma.TransactionClient, task: GroundingTask) {
    const cohort = await tx.groundingCohort.findUnique({ where: { taskId: task.id } });
    const binding = await tx.groundingBinding.findUnique({ where: { taskId: task.id } });
    if (!cohort && !binding) return { provisioned: false, valid: true, operationId: null };
    let valid = true;
    try { await requireGroundingCohort(tx, task.id, task.projectId); }
    catch (error) {
      if (!(error instanceof GroundingAccessError) && !(error instanceof GroundingReceiptVerificationError)) throw error;
      valid = false;
    }
    return { provisioned: true, valid, operationId: cohort?.reservationId ?? null };
  }

  private async observe(tx: Prisma.TransactionClient, match: Match, event: Event, pending: boolean, reason: string, operationId: string | null) {
    const issue = event.kind.startsWith("issue_");
    const fact = await tx.groundingGithubObservation.create({ data: { deliveryId: event.deliveryId, taskId: match.task.id, operationId, repo: event.repo!, prNumber: issue ? null : event.number, issueNumber: issue ? event.number : null, event: event.kind, matchKind: match.strength, state: pending ? "PENDING" : "OBSERVED", reason, observedHeadSha: event.head ?? null } });
    await tx.comment.create({ data: { taskId: match.task.id, content: `[webhook] ${event.kind} observed for ${event.repo} ${issue ? "issue" : "PR"} #${event.number}${pending ? `; completion pending (${reason})` : ""}. Delivery ${event.deliveryId}.` } });
    await tx.auditLog.create({ data: { taskId: match.task.id, projectId: match.task.projectId, actorId: null, action: pending ? "task.grounding.external_pending" : "task.github.observed", payload: { source: "github_webhook", actorType: "system_observation", deliveryId: event.deliveryId, observationId: fact.id, event: event.kind, repo: event.repo, number: event.number, reason, matchKind: match.strength, operationId, ...(event.login ? { githubLogin: event.login } : {}) } } });
  }

  private async changedHead(tx: Prisma.TransactionClient, task: GroundingTask, event: Event) {
    if (!event.head) return false;
    const binding = await tx.groundingBinding.findUnique({ where: { taskId: task.id } });
    if (binding?.subjectMode !== "CODE_HEAD" || !binding.activeAttemptId) return false;
    const attempt = await tx.groundingAttempt.findUnique({ where: { id: binding.activeAttemptId } });
    if (!attempt || attempt.state !== "ACTIVE") return false;
    const context = z.object({ deliverable: z.object({ headSha: z.string() }) }).safeParse(JSON.parse(attempt.contextBytes.toString("utf8")));
    return context.success && context.data.deliverable.headSha !== event.head;
  }

  private async applyEvent(tx: Prisma.TransactionClient, event: Event, signals: Signal[]): Promise<EffectResult> {
    if (!event.repo || event.kind === "ignored") return { observed: 0, changed: 0 };
    const projects = await this.projects(tx, event);
    if (event.kind === "push") {
      const changed = await tx.project.updateMany({ where: { id: { in: projects.filter(project => canonicalOrNull(project.githubRepo) === event.repo).map(project => project.id) } }, data: { githubSyncAt: new Date() } });
      return { observed: 0, changed: changed.count };
    }
    if (event.kind === "issue_opened") {
      let changed = 0;
      for (const project of projects.filter(project => canonicalOrNull(project.githubRepo) === event.repo)) {
        const selected = this.creationPolicy.filter(entry => entry.projectId === project.id);
        if (selected.length > 1 || (selected.length && !this.attempts)) unavailable();
        // The workflow's initial state, not the literal `open`. The webhook carries no workflowId,
        // so this resolves the project default, read on the same transaction as the state check below.
        const initialStatus = await createInitialStatus(tx, project.id, undefined);
        const task = await tx.task.create({ data: { projectId: project.id, title: `[GH #${event.number}] ${event.title}`, description: event.body, status: initialStatus }, include: { project: true } });
        if (selected.length) {
          const { def } = await groundingWorkflow(tx, task);
          if (isReviewState(def, task.status) || isTerminalState(def, task.status)) throw new GroundingReceiptVerificationError("grounding_required");
          if (!def.states.some(state => state.name === task.status)) throw new GroundingAccessError("bad_state", 409);
          await this.attempts!.provisionInTransaction(tx, { taskId: task.id, projectId: project.id, subjectMode: selected[0]!.subjectMode });
        }
        await tx.auditLog.create({ data: { projectId: project.id, taskId: task.id, actorId: null, action: "task.created", payload: { source: "github_webhook", actorType: "system_observation", deliveryId: event.deliveryId, issue_number: event.number } } });
        signals.push(...await createTaskAvailableSignalsInTx(tx, { task, project, actor: { type: "webhook", name: "GitHub" } }));
        changed++;
      }
      return { observed: 0, changed };
    }
    const matches = await this.matches(tx, event, projects.map(project => project.id));
    const changes: GithubObservedContextChange[] = [];
    const observations: Array<{ match: Match; pending: boolean; reason: string; operationId: string | null }> = [];
    const acknowledge: string[] = [];
    for (const match of matches) {
      const { task } = match;
      if (await groundingTaskHeld(tx, task.id, task.projectId)) {
        observations.push({ match, pending: true, reason: "grounding_task_held", operationId: null });
        continue;
      }
      // Every state this handler writes or compares comes from the task's own
      // effective workflow (pinned workflow, else the project default, else the
      // built-in one), as the legacy webhook does. This is deliberately the
      // legacy resolver and not groundingWorkflow: a task that is not
      // provisioned for Grounding is handled here exactly as the legacy webhook
      // handles it, so both resolve the same definition for it.
      const def = await resolveEffectiveDefinition(task, tx);
      const enrollment = await this.enrollment(tx, task);
      if (!enrollment.provisioned && (isTerminalState(def, task.status) || task.status === BACKLOG_STATE)) continue;
      const positive = event.kind === "pr_merged" || event.kind === "issue_closed";
      if (positive && (enrollment.provisioned || (event.kind === "pr_merged" && match.strength !== "EXACT"))) {
        observations.push({ match, pending: true, reason: !enrollment.valid ? "invalid_enrollment" : match.strength !== "EXACT" ? "weak_binding" : "authenticated_completion_required", operationId: enrollment.operationId });
        continue;
      }
      if (!enrollment.valid) {
        if (event.kind === "pr_opened") conflict();
        observations.push({ match, pending: true, reason: "invalid_enrollment", operationId: enrollment.operationId });
        continue;
      }
      if (event.kind === "pr_opened") {
        if (match.strength === "AMBIGUOUS" || (task.prNumber !== null && task.prNumber !== event.number) || (task.prUrl !== null && !/^https:\/\/github\.com\//.test(task.prUrl))) conflict();
        if (task.prUrl !== null) {
          const bound = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(task.prUrl);
          if (!bound || canonicalOrNull(bound[1]!) !== event.repo || Number(bound[2]) !== event.number) conflict();
        }
        const patch: GithubObservedContextChange["patch"] = {};
        if (task.prNumber === null) patch.prNumber = event.number;
        if (task.prUrl === null) patch.prUrl = event.url;
        if (!task.branchName && event.branch) patch.branchName = event.branch;
        changes.push({ task, patch });
      } else if (event.kind === "review_changes_requested" && match.strength === "EXACT" && isReviewState(def, task.status)) {
        // The workflow's request-changes edge out of the review state; a
        // workflow without one leaves the status alone (the observation is
        // still recorded below).
        const target = requestChangesTarget(def, task.status);
        if (target) changes.push({ task, patch: { status: target } });
        else logger.warn({ component: "grounding-github-webhook", taskId: task.id, status: task.status, deliveryId: event.deliveryId }, "review changes requested but the task's workflow has no non-terminal edge out of its review state; status left as is");
      } else if (event.kind === "pr_reopened" && match.strength === "EXACT" && await this.changedHead(tx, task, event)) {
        changes.push({ task, patch: {}, headChanged: true });
      } else if (positive) {
        // issue_closed ends the task along the approve edge out of its current
        // state when there is one, else in the workflow's first terminal state
        // (terminalTargetFrom); a workflow with several terminal states can
        // therefore end in a different one than the first, which is the choice
        // the review approve makes too. A target that is not a state of the
        // definition (terminalTargetFrom falls back to the literal done for a
        // definition without a terminal state) writes nothing, as the legacy
        // webhook does.
        const target = event.kind === "issue_closed" ? terminalTargetFrom(def, task.status) : pickMergeTargetStatus({ project: task.project, currentStatus: task.status, definition: def });
        const known = target !== null && isKnownState(def, target);
        const terminal = known && isTerminalState(def, target);
        if (known && target !== task.status) changes.push({ task, patch: { status: target }, terminalStatus: terminal });
        if (terminal) acknowledge.push(task.id);
      }
      observations.push({ match, pending: false, reason: "external_observation", operationId: enrollment.operationId });
    }
    const changed = await applyGithubObservedContext(tx, changes, { deliveryId: event.deliveryId, reason: event.kind });
    if (acknowledge.length) await tx.signal.updateMany({ where: { taskId: { in: acknowledge }, acknowledgedAt: null }, data: { acknowledgedAt: new Date() } });
    for (const row of observations) await this.observe(tx, row.match, event, row.pending, row.reason, row.operationId);
    return { observed: observations.length, changed };
  }
}
