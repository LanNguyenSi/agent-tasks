/**
 * GitHub Webhook Handler
 *
 * Processes incoming GitHub webhook events to sync repo data:
 * - push: update last sync timestamp
 * - issues.opened → create task
 * - issues.closed → transition task to done
 * - pull_request.opened → backfill PR fields on matching tasks
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logAuditEvent } from "./audit.js";
import { acknowledgeSignalsForTask } from "./signal.js";
import { STATUS_VERSION_BUMP, taskStatusVersionWhere } from "./task-status-cas.js";
import { logger } from "../lib/logger.js";
import {
  GovernanceMode,
  resolveGovernanceMode,
  type GovernanceFlagsLike,
} from "../lib/governance-mode.js";
import {
  BACKLOG_STATE,
  defaultWorkflowDefinition,
  isReviewState,
  isTerminalState,
  requestChangesTarget,
  resolveEffectiveDefinition,
  reviewStates,
  terminalStates,
  type WorkflowDefinitionShape,
} from "./default-workflow.js";
import { taskStatusByWorkflow } from "./workflow-status-filter.js";
import { clearAllClaims } from "./task-claim-fields.js";

export type GitHubWebhookEvent = "push" | "issues" | "pull_request" | "pull_request_review" | "ping";

export interface GitHubIssuePayload {
  action: "opened" | "closed" | "reopened" | "edited";
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: "open" | "closed";
  };
  repository: { full_name: string };
}

export interface GitHubPullRequestPayload {
  action: "opened" | "closed" | "reopened";
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: "open" | "closed";
    merged: boolean;
    merged_by?: { login: string } | null;
    head?: { ref?: string };
  };
  repository: { full_name: string };
}

export interface GitHubPullRequestReviewPayload {
  action: "submitted" | "edited" | "dismissed";
  review: {
    state: "approved" | "changes_requested" | "commented" | "dismissed";
    user: { login: string };
    html_url: string;
  };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    head?: { ref?: string };
  };
  repository: { full_name: string };
}

/**
 * Find tasks bound to a PR within a project.
 *
 * Matching strategy (priority order per ADR 0014):
 *   1. prNumber field  — strongest, set by agents or webhook
 *   2. prUrl field     — set by agents or webhook
 *   3. branchName      — matches head branch from PR payload
 *   4. title pattern   — legacy fallback ([PR #N])
 *
 * Results are deduplicated and ordered by match strength.
 * Only non-done, non-backlog tasks are returned (idempotency, and — v1
 * backlog gate — an unpromoted backlog task must never be moved by a webhook
 * event; only an operator promotion (PATCH backlog->open) takes it out of
 * backlog).
 */
export interface PrBindingHint {
  prNumber: number;
  prUrl?: string;
  headBranch?: string;
}

/**
 * Where-fragment for the tasks of one project that a webhook event may still
 * move: not in a terminal state of the task's own workflow, and never in
 * `backlog`.
 */
async function openTaskStatusFilter(projectId: string): Promise<Prisma.TaskWhereInput> {
  const notTerminal = await taskStatusByWorkflow(prisma, {
    kind: "terminal",
    match: "notIn",
    scope: { projectId },
  });
  return { status: { not: BACKLOG_STATE }, AND: [notTerminal] };
}

export async function findTasksByPr(projectId: string, hint: PrBindingHint) {
  const { prNumber, prUrl, headBranch } = hint;

  // The task's own workflow decides which statuses are terminal, so the
  // filter is built per workflow (see workflow-status-filter.ts); `backlog`
  // stays excluded for every workflow. The decide functions that run on the
  // fresh row (`writeWebhookStatus`) remain the safety net.
  const open = await openTaskStatusFilter(projectId);

  // Run all matching strategies in parallel
  const queries = [
    // 1. prNumber (strongest)
    prisma.task.findMany({
      where: { projectId, prNumber, ...open },
    }),
    // 2. prUrl
    prUrl
      ? prisma.task.findMany({
          where: { projectId, prUrl, ...open },
        })
      : Promise.resolve([]),
    // 3. branchName
    headBranch
      ? prisma.task.findMany({
          where: { projectId, branchName: headBranch, ...open },
        })
      : Promise.resolve([]),
    // 4. title pattern (legacy fallback)
    prisma.task.findMany({
      where: {
        projectId,
        title: { contains: `[PR #${prNumber}]` },
        ...open,
      },
    }),
  ];

  const [byNumber, byUrl, byBranch, byTitle] = await Promise.all(queries);

  // Deduplicate, preserving priority order
  const seen = new Set<string>();
  return [...byNumber, ...byUrl, ...byBranch, ...byTitle].filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

/** How many times a webhook status write re-reads and re-decides after losing a race. */
const WEBHOOK_STATUS_WRITE_ATTEMPTS = 3;

interface WebhookStatusRow {
  id: string;
  status: string;
  statusVersion: number;
}

/**
 * The outcome of `writeWebhookStatus`: `written` is true when this call moved
 * the task; `from` is the status the row had when the decision was taken (the
 * one that was written over when `written`, otherwise the last one seen);
 * `to` is the status written, or null when nothing was written.
 */
interface WebhookStatusWrite {
  written: boolean;
  from: string;
  to: string | null;
}

/**
 * Compare-and-swap status write for the legacy webhook handlers. A handler
 * decides a target from the status of the row it read (`decide`, null for
 * "no transition") and the write lands only while the row still has that
 * status and status version, so a concurrent writer (an approval, a finish, an
 * admin write) between the read and the write is not written over.
 *
 * A webhook delivery is at-most-once and reports a fact that already happened
 * on GitHub, so a lost write is not answered with an error: the row is read
 * again and the decision is taken again against it (a task another writer
 * already moved to the target simply needs no transition). After
 * `WEBHOOK_STATUS_WRITE_ATTEMPTS` lost races the write is given up with a
 * warning and `written: false`.
 *
 * A write into a terminal state of `definition` (the task's effective
 * workflow) also clears the work claim and the review claim, like the finish
 * and approve paths: the task is over, and a claim left on it would count as
 * an active claim again once its workflow stops treating that status as
 * terminal.
 */
async function writeWebhookStatus(
  task: WebhookStatusRow,
  definition: WorkflowDefinitionShape,
  decide: (status: string) => string | null,
): Promise<WebhookStatusWrite> {
  let current: WebhookStatusRow = task;
  for (let attempt = 0; attempt < WEBHOOK_STATUS_WRITE_ATTEMPTS; attempt++) {
    const target = decide(current.status);
    if (target === null || target === current.status) {
      return { written: false, from: current.status, to: null };
    }
    const result = await prisma.task.updateMany({
      where: { id: current.id, ...taskStatusVersionWhere(current) },
      data: { status: target, ...STATUS_VERSION_BUMP, ...(isTerminalState(definition, target) ? clearAllClaims : {}) },
    });
    if (result.count === 1) return { written: true, from: current.status, to: target };
    const fresh = await prisma.task.findUnique({
      where: { id: task.id },
      select: { id: true, status: true, statusVersion: true },
    });
    if (!fresh) return { written: false, from: current.status, to: null };
    current = fresh;
  }
  logger.warn(
    { component: "github-webhook", taskId: task.id, status: current.status },
    "webhook status write lost its compare-and-swap repeatedly; task left as is",
  );
  return { written: false, from: current.status, to: null };
}

/** Add a webhook timeline comment to a task */
async function addTimelineComment(taskId: string, message: string) {
  await prisma.comment.create({
    data: { taskId, content: `[webhook] ${message}` },
  });
}

// Ephemeral per-process key for the length-independent constant-time compare
// below. It only needs to be unknown to the attacker (so the attacker can't
// precompute either side's digest); it does not need to persist or rotate.
const HMAC_COMPARE_KEY = randomBytes(32);

/**
 * Constant-time string equality that does not branch on length. Both inputs
 * are re-HMAC'd under an ephemeral key to a fixed 32-byte digest before
 * timingSafeEqual, so a length mismatch produces unequal digests in constant
 * time instead of an early return (which would leak whether the candidate is
 * the right length). Mirrors the double-HMAC verification pattern.
 *
 * The timing property is not unit-testable (a plain `a === b` would pass the
 * behavioral tests), so keep the timingSafeEqual call intact on any refactor.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", HMAC_COMPARE_KEY).update(a).digest();
  const hb = createHmac("sha256", HMAC_COMPARE_KEY).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Verify the GitHub webhook signature */
export function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  return constantTimeEqual(expected, signature);
}

/** Process a GitHub issues event — create or transition tasks */
export async function handleIssuesEvent(payload: GitHubIssuePayload): Promise<void> {
  const repoFullName = payload.repository.full_name;

  // Find all projects linked to this repo
  const projects = await prisma.project.findMany({
    where: { githubRepo: repoFullName },
    select: { id: true, teamId: true },
  });

  if (projects.length === 0) return;

  for (const project of projects) {
    if (payload.action === "opened") {
      // Create a new task for the opened issue
      const task = await prisma.task.create({
        data: {
          projectId: project.id,
          title: `[GH #${payload.issue.number}] ${payload.issue.title}`,
          description: payload.issue.body ?? undefined,
          status: "open",
        },
      });

      await logAuditEvent({
        action: "task.created",
        projectId: project.id,
        taskId: task.id,
        payload: { source: "github_webhook", issue_number: payload.issue.number },
      });
    } else if (payload.action === "closed") {
      // Find and close tasks that match this issue. v1 backlog gate: an
      // unpromoted backlog task must never be moved by a webhook event, so
      // it is excluded here the same way findTasksByPr excludes it below.
      // The status filter follows each task's own workflow, as in findTasksByPr.
      const tasks = await prisma.task.findMany({
        where: {
          projectId: project.id,
          title: { contains: `[GH #${payload.issue.number}]` },
          ...(await openTaskStatusFilter(project.id)),
        },
      });

      for (const task of tasks) {
        const definition = await resolveEffectiveDefinition(task, prisma);
        // Re-decided against the fresh row after a lost race: a task another
        // writer already finished (or demoted to backlog) is left alone.
        const moved = await writeWebhookStatus(task, definition, (status) =>
          isTerminalState(definition, status) || status === BACKLOG_STATE
            ? null
            : (terminalStates(definition)[0] ?? null),
        );
        if (!moved.written) continue;
        await acknowledgeSignalsForTask(task.id);
        await logAuditEvent({
          action: "task.transitioned",
          projectId: project.id,
          taskId: task.id,
          payload: { source: "github_webhook", issue_number: payload.issue.number, to: moved.to },
        });
      }
    }
  }
}

/**
 * Decide the post-merge status for a task when a webhook reports its PR
 * was merged. Returns null to mean "no transition" (idempotent or explicit
 * approval still required).
 *
 * The states are read from `definition`, the task's effective workflow
 * (default: the built-in four-state workflow, where the terminal state is
 * `done` and the review state is `review`).
 *
 * - AUTONOMOUS → always target the first terminal state (preserves ADR-0010
 *   auto-merge semantics).
 * - AWAITS_CONFIRMATION / REQUIRES_DISTINCT_REVIEWER (any workflow):
 *     - a review-like or terminal state → no transition (explicit approval
 *       required).
 *     - anything else (open/in_progress) → the first review-like state to
 *       hand off for review; null when the workflow has none.
 *
 * Custom workflows get no terminal carve-out here. A confirmation-required
 * project must keep its review gate on a webhook merge regardless of
 * workflow — the old carve-out (M3) let custom-workflow non-solo projects
 * auto-complete and silently bypass the review gate that default-workflow
 * non-solo projects get.
 *
 * `backlog` short-circuits the same way a terminal state does, regardless of
 * governance mode: an unpromoted backlog task leaves backlog only through an
 * operator's explicit PATCH promotion, never through a webhook-observed PR
 * merge. (findTasksByPr already excludes backlog tasks from its query, so in
 * practice this branch is a defense-in-depth backstop for any caller that
 * looks up currentStatus another way.)
 */
export function pickMergeTargetStatus(input: {
  project: GovernanceFlagsLike;
  currentStatus: string;
  definition?: WorkflowDefinitionShape;
}): string | null {
  const { project, currentStatus } = input;
  const definition = input.definition ?? defaultWorkflowDefinition();
  if (isTerminalState(definition, currentStatus)) return null;
  if (currentStatus === BACKLOG_STATE) return null;
  if (resolveGovernanceMode(project) === GovernanceMode.AUTONOMOUS) {
    return terminalStates(definition)[0] ?? null;
  }
  if (isReviewState(definition, currentStatus)) return null;
  return reviewStates(definition)[0] ?? null;
}

/** Process a GitHub pull_request event — per review-automation-policy.md */
export async function handlePullRequestEvent(payload: GitHubPullRequestPayload): Promise<void> {
  const repoFullName = payload.repository.full_name;

  const projects = await prisma.project.findMany({
    where: { githubRepo: repoFullName },
    select: {
      id: true,
      soloMode: true,
      requireDistinctReviewer: true,
      governanceMode: true,
    },
  });

  if (projects.length === 0) return;

  const prNumber = payload.pull_request.number;
  const hint: PrBindingHint = {
    prNumber,
    prUrl: payload.pull_request.html_url,
    headBranch: payload.pull_request.head?.ref,
  };

  for (const project of projects) {
    if (payload.action === "opened") {
      // Backfill binding fields on existing tasks; do NOT create new tasks.
      // Task creation is a deliberate agent/human action, not a webhook side effect.
      const existing = await findTasksByPr(project.id, hint);
      if (existing.length > 0) {
        for (const task of existing) {
          const updates: Record<string, unknown> = {};
          if (!task.prNumber) updates.prNumber = prNumber;
          if (!task.prUrl) updates.prUrl = payload.pull_request.html_url;
          if (!task.branchName && hint.headBranch) updates.branchName = hint.headBranch;
          if (Object.keys(updates).length > 0) {
            await prisma.task.update({ where: { id: task.id }, data: updates });
          }
          await addTimelineComment(task.id, `PR #${prNumber} opened: ${payload.pull_request.html_url}`);
        }
      } else {
        // No matching task — log but do not create a task
        await logAuditEvent({
          action: "task.reviewed",
          projectId: project.id,
          payload: { source: "github_webhook", event: "pr_opened_unmatched", pr_number: prNumber },
        });
      }
    } else if (payload.action === "closed") {
      const tasks = await findTasksByPr(project.id, hint);

      if (payload.pull_request.merged) {
        // Policy: PR merged → terminal state (AUTONOMOUS) OR → review-like
        // state (confirmation-required, pre-review state), regardless of
        // workflow (custom workflows get no terminal carve-out; see
        // pickMergeTargetStatus).
        //
        // Rationale: AUTONOMOUS projects skip review by design (ADR-0010). For
        // confirmation-required projects the review state is a real gate —
        // merging the PR on GitHub should hand the task off for explicit
        // approval via task_finish({ outcome: "approve" }), not terminate it
        // silently.
        //
        // The target comes from the task's effective workflow definition, so
        // it is always a state of that workflow; a workflow without a
        // review-like state gets no confirmation-required transition.
        const mergedBy = payload.pull_request.merged_by?.login ?? "unknown";
        for (const task of tasks) {
          const definition = await resolveEffectiveDefinition(task, prisma);
          const moved = await writeWebhookStatus(task, definition, (currentStatus) =>
            pickMergeTargetStatus({ project, currentStatus, definition }),
          );
          if (moved.written && moved.to !== null && isTerminalState(definition, moved.to)) {
            await acknowledgeSignalsForTask(task.id);
          }
          await addTimelineComment(task.id, `PR #${prNumber} merged by ${mergedBy}`);
          await logAuditEvent({
            action: "task.transitioned",
            projectId: project.id,
            taskId: task.id,
            payload: {
              source: "github_webhook",
              event: "pr_merged",
              pr_number: prNumber,
              merged_by: mergedBy,
              from: moved.from,
              to: moved.to ?? moved.from,
            },
          });
        }
      } else {
        // Policy: closed without merge → no transition, timeline entry only
        for (const task of tasks) {
          await addTimelineComment(task.id, `PR #${prNumber} closed without merge`);
          await logAuditEvent({
            action: "task.reviewed",
            projectId: project.id,
            taskId: task.id,
            payload: { source: "github_webhook", event: "pr_closed", pr_number: prNumber },
          });
        }
      }
    }
  }
}

/** Process a GitHub pull_request_review event — per review-automation-policy.md */
export async function handlePullRequestReviewEvent(payload: GitHubPullRequestReviewPayload): Promise<void> {
  if (payload.action !== "submitted" && payload.action !== "dismissed") return;

  const repoFullName = payload.repository.full_name;
  const projects = await prisma.project.findMany({
    where: { githubRepo: repoFullName },
    select: { id: true },
  });
  if (projects.length === 0) return;

  const prNumber = payload.pull_request.number;
  const reviewer = payload.review.user.login;
  const reviewState = payload.action === "dismissed" ? "dismissed" : payload.review.state;
  const hint: PrBindingHint = {
    prNumber,
    prUrl: payload.pull_request.html_url,
    headBranch: payload.pull_request.head?.ref,
  };

  for (const project of projects) {
    const tasks = await findTasksByPr(project.id, hint);

    for (const task of tasks) {
      switch (reviewState) {
        case "approved": {
          // Policy: no auto-transition, timeline entry only
          await addTimelineComment(task.id, `Review approved by ${reviewer}`);
          await logAuditEvent({
            action: "task.reviewed",
            projectId: project.id,
            taskId: task.id,
            payload: { source: "github_webhook", event: "review_approved", reviewer, pr_number: prNumber },
          });
          break;
        }

        case "changes_requested": {
          // Policy: review-like state → the workflow's request-changes target
          const definition = await resolveEffectiveDefinition(task, prisma);
          const moved = await writeWebhookStatus(task, definition, (status) =>
            isReviewState(definition, status)
              ? (requestChangesTarget(definition, status) ?? null)
              : null,
          );
          await addTimelineComment(task.id, `Changes requested by ${reviewer}`);
          await logAuditEvent({
            action: "task.reviewed",
            projectId: project.id,
            taskId: task.id,
            payload: {
              source: "github_webhook",
              event: "changes_requested",
              reviewer,
              pr_number: prNumber,
              ...(moved.written ? { from: moved.from, to: moved.to } : {}),
            },
          });
          break;
        }

        case "commented": {
          await addTimelineComment(task.id, `Review comment by ${reviewer}`);
          await logAuditEvent({
            action: "task.reviewed",
            projectId: project.id,
            taskId: task.id,
            payload: { source: "github_webhook", event: "review_commented", reviewer, pr_number: prNumber },
          });
          break;
        }

        case "dismissed": {
          await addTimelineComment(task.id, `Review dismissed for ${reviewer}`);
          await logAuditEvent({
            action: "task.reviewed",
            projectId: project.id,
            taskId: task.id,
            payload: { source: "github_webhook", event: "review_dismissed", reviewer, pr_number: prNumber },
          });
          break;
        }
      }
    }
  }
}

/**
 * Claim a GitHub webhook delivery by its X-GitHub-Delivery id.
 *
 * Returns true if the delivery is new and the caller should process it.
 * Returns false if the row already exists (P2002 unique violation), meaning
 * this is a duplicate redelivery and the caller should skip processing.
 * Any other error propagates — the route fails closed (5xx) so the delivery
 * is not dispatched without a dedup guarantee.
 *
 * Semantics are at-most-once: a claimed delivery is never released, so a
 * delivery whose dispatch fails is NOT auto-reprocessed. This is deliberate —
 * the webhook handlers (addTimelineComment, transitions, audit writes) are not
 * idempotent, so re-running a partially-applied handler would double-apply the
 * side effects this dedup exists to prevent. A failed dispatch is logged for
 * operator follow-up instead.
 */
export async function claimWebhookDelivery(deliveryId: string, event: string): Promise<boolean> {
  try {
    await prisma.webhookDelivery.create({ data: { deliveryId, event } });
    return true;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return false;
    }
    throw e;
  }
}

/** Update project sync timestamp */
export async function updateProjectSyncAt(githubRepo: string): Promise<void> {
  await prisma.project.updateMany({
    where: { githubRepo },
    data: { githubSyncAt: new Date() },
  });
}
