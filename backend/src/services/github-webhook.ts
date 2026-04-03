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

export type GitHubWebhookEvent = "push" | "issues" | "pull_request" | "ping";

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
  };
  repository: { full_name: string };
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

/** Process a GitHub pull_request event */
export async function handlePullRequestEvent(payload: GitHubPullRequestPayload): Promise<void> {
  const repoFullName = payload.repository.full_name;

  const projects = await prisma.project.findMany({
    where: { githubRepo: repoFullName },
    select: { id: true },
  });

  if (projects.length === 0) return;

  for (const project of projects) {
    if (payload.action === "opened") {
      const task = await prisma.task.create({
        data: {
          projectId: project.id,
          title: `[PR #${payload.pull_request.number}] ${payload.pull_request.title}`,
          description: payload.pull_request.body ?? undefined,
          status: "review",
        },
      });

      await logAuditEvent({
        action: "task.created",
        projectId: project.id,
        taskId: task.id,
        payload: { source: "github_webhook", pr_number: payload.pull_request.number },
      });
    } else if (payload.action === "closed" && payload.pull_request.merged) {
      // PR merged → mark as done
      const tasks = await prisma.task.findMany({
        where: {
          projectId: project.id,
          title: { contains: `[PR #${payload.pull_request.number}]` },
          status: { not: "done" },
        },
      });

      for (const task of tasks) {
        await prisma.task.update({ where: { id: task.id }, data: { status: "done" } });
        await logAuditEvent({
          action: "task.transitioned",
          projectId: project.id,
          taskId: task.id,
          payload: { source: "github_webhook", pr_merged: true },
        });
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
