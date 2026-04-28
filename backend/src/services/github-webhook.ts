/**
 * GitHub Webhook Handler
 *
 * Processes incoming GitHub webhook events to sync repo data:
 * - push: update last sync timestamp
 * - issues.opened → create task
 * - issues.closed → transition task to done
 * - pull_request.opened → create task
 */
import { createHmac } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logAuditEvent } from "./audit.js";
import { acknowledgeSignalsForTask } from "./signal.js";
import {
  GovernanceMode,
  resolveGovernanceMode,
  type GovernanceFlagsLike,
} from "../lib/governance-mode.js";

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
 * Matching strategy (priority order per ADR 0001):
 *   1. prNumber field  — strongest, set by agents or webhook
 *   2. prUrl field     — set by agents or webhook
 *   3. branchName      — matches head branch from PR payload
 *   4. title pattern   — legacy fallback ([PR #N])
 *
 * Results are deduplicated and ordered by match strength.
 * Only non-done tasks are returned (idempotency).
 */
export interface PrBindingHint {
  prNumber: number;
  prUrl?: string;
  headBranch?: string;
}

export async function findTasksByPr(projectId: string, hint: PrBindingHint) {
  const { prNumber, prUrl, headBranch } = hint;

  // Run all matching strategies in parallel
  const queries = [
    // 1. prNumber (strongest)
    prisma.task.findMany({
      where: { projectId, prNumber, status: { not: "done" } },
    }),
    // 2. prUrl
    prUrl
      ? prisma.task.findMany({
          where: { projectId, prUrl, status: { not: "done" } },
        })
      : Promise.resolve([]),
    // 3. branchName
    headBranch
      ? prisma.task.findMany({
          where: { projectId, branchName: headBranch, status: { not: "done" } },
        })
      : Promise.resolve([]),
    // 4. title pattern (legacy fallback)
    prisma.task.findMany({
      where: {
        projectId,
        title: { contains: `[PR #${prNumber}]` },
        status: { not: "done" },
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

/** Add a webhook timeline comment to a task */
async function addTimelineComment(taskId: string, message: string) {
  await prisma.comment.create({
    data: { taskId, content: `[webhook] ${message}` },
  });
}

/** Verify the GitHub webhook signature */
export function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  // Timing-safe comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
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
      // Find and close tasks that match this issue
      const tasks = await prisma.task.findMany({
        where: {
          projectId: project.id,
          title: { contains: `[GH #${payload.issue.number}]` },
          status: { not: "done" },
        },
      });

      for (const task of tasks) {
        await prisma.task.update({
          where: { id: task.id },
          data: { status: "done" },
        });
        await acknowledgeSignalsForTask(task.id);
        await logAuditEvent({
          action: "task.transitioned",
          projectId: project.id,
          taskId: task.id,
          payload: { source: "github_webhook", issue_number: payload.issue.number, to: "done" },
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
 * - AUTONOMOUS → always target `done` (preserves ADR-0010 auto-merge semantics).
 * - Custom workflows (task.workflowId set) → legacy `done` until
 *   custom-workflow webhook policy lands, since we can't safely pick a
 *   target state machine we don't know.
 * - AWAITS_CONFIRMATION / REQUIRES_DISTINCT_REVIEWER, default workflow:
 *     - `review` or `done` → no transition (explicit approval required).
 *     - anything else (open/in_progress) → `review` to hand off for review.
 */
export function pickMergeTargetStatus(input: {
  project: GovernanceFlagsLike;
  hasCustomWorkflow: boolean;
  currentStatus: string;
}): string | null {
  const { project, hasCustomWorkflow, currentStatus } = input;
  if (currentStatus === "done") return null;
  if (resolveGovernanceMode(project) === GovernanceMode.AUTONOMOUS) return "done";
  if (hasCustomWorkflow) return "done";
  if (currentStatus === "review") return null;
  return "review";
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
        // Policy: PR merged → done (soloMode) OR → review (non-solo, default
        // workflow, pre-review state). Projects with a custom workflow keep
        // the legacy "→ done" behavior until custom-workflow policy lands.
        //
        // Rationale: soloMode projects skip review by design (ADR-0010). For
        // non-solo projects the review state is a real gate — merging the PR
        // on GitHub should hand the task off for explicit approval via
        // task_finish({ outcome: "approve" }), not terminate it silently.
        const mergedBy = payload.pull_request.merged_by?.login ?? "unknown";
        for (const task of tasks) {
          const toStatus = pickMergeTargetStatus({
            project,
            hasCustomWorkflow: task.workflowId !== null,
            currentStatus: task.status,
          });

          if (toStatus !== null && toStatus !== task.status) {
            await prisma.task.update({
              where: { id: task.id },
              data: { status: toStatus },
            });
            if (toStatus === "done") {
              await acknowledgeSignalsForTask(task.id);
            }
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
              from: task.status,
              to: toStatus ?? task.status,
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
          // Policy: review → in_progress
          if (task.status === "review") {
            await prisma.task.update({
              where: { id: task.id },
              data: { status: "in_progress" },
            });
          }
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
              ...(task.status === "review" ? { from: "review", to: "in_progress" } : {}),
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

/** Update project sync timestamp */
export async function updateProjectSyncAt(githubRepo: string): Promise<void> {
  await prisma.project.updateMany({
    where: { githubRepo },
    data: { githubSyncAt: new Date() },
  });
}
