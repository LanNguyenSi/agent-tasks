/**
 * Review Signal Service
 *
 * Emits review-needed signals when a task enters the review state.
 * Determines eligible reviewers (team agents + humans, excluding the assignee).
 */
import { prisma } from "../lib/prisma.js";
import { logAuditEvent } from "./audit.js";
import { createSignal, type SignalContext } from "./signal.js";

export interface ReviewRecipient {
  type: "agent" | "human";
  id: string;
  name: string;
}

/**
 * Find eligible reviewers for a task.
 *
 * Eligibility (MVP):
 *   - Agents: active (non-revoked, non-expired) tokens in the same team with tasks:transition scope
 *   - Humans: team members with REVIEWER or ADMIN role
 *   - Excluded: the current task assignee (no self-review)
 */
export async function findEligibleReviewers(
  projectId: string,
  excludeUserId: string | null,
  excludeAgentId: string | null,
): Promise<ReviewRecipient[]> {
  // Find the team(s) for this project
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { teamId: true },
  });
  if (!project) return [];

  const now = new Date();

  // Find eligible agent tokens
  const agents = await prisma.agentToken.findMany({
    where: {
      teamId: project.teamId,
      revokedAt: null,
      scopes: { has: "tasks:transition" },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
      ...(excludeAgentId ? { id: { not: excludeAgentId } } : {}),
    },
    select: { id: true, name: true },
  });

  // Find eligible human reviewers (REVIEWER or ADMIN role)
  const humans = await prisma.teamMember.findMany({
    where: {
      teamId: project.teamId,
      role: { in: ["REVIEWER", "ADMIN"] },
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
    },
    select: { userId: true, user: { select: { name: true, login: true } } },
  });

  const recipients: ReviewRecipient[] = [
    ...agents.map((a) => ({ type: "agent" as const, id: a.id, name: a.name })),
    ...humans.map((m) => ({
      type: "human" as const,
      id: m.userId,
      name: m.user.name ?? m.user.login ?? "Unknown",
    })),
  ];

  return recipients;
}

/** Build inline signal context from a task */
async function buildSignalContext(
  taskId: string,
  actorType: "human" | "agent" | "webhook",
  actorName: string,
  extra?: Partial<SignalContext>,
): Promise<SignalContext | null> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { project: { select: { slug: true, name: true } } },
  });
  if (!task) return null;

  return {
    taskTitle: task.title,
    taskStatus: task.status,
    projectSlug: task.project.slug,
    projectName: task.project.name,
    branchName: task.branchName,
    prUrl: task.prUrl,
    prNumber: task.prNumber,
    actor: { type: actorType, name: actorName },
    ...extra,
  };
}

/**
 * Emit review-needed signals for a task.
 * Called when a task transitions to "review".
 *
 * Side effects:
 *   - Creates durable Signal per eligible reviewer
 *   - Adds a [system] timeline comment listing eligible reviewers
 *   - Logs a task.review_needed audit event with recipient list
 */
export async function emitReviewSignal(
  taskId: string,
  projectId: string,
  assigneeUserId: string | null,
  assigneeAgentId: string | null,
): Promise<ReviewRecipient[]> {
  const recipients = await findEligibleReviewers(projectId, assigneeUserId, assigneeAgentId);

  // Build signal context
  const assigneeName = assigneeAgentId
    ? (await prisma.agentToken.findUnique({ where: { id: assigneeAgentId }, select: { name: true } }))?.name ?? "Agent"
    : "Human";
  const context = await buildSignalContext(taskId, "agent", assigneeName, { assigneeName });

  // Create durable signals for each recipient
  if (context) {
    for (const r of recipients) {
      await createSignal({
        type: "review_needed",
        taskId,
        projectId,
        recipientAgentId: r.type === "agent" ? r.id : null,
        recipientUserId: r.type === "human" ? r.id : null,
        context,
      });
    }
  }

  // Timeline comment
  if (recipients.length > 0) {
    const names = recipients.map((r) => `${r.name} (${r.type})`).join(", ");
    await prisma.comment.create({
      data: {
        taskId,
        content: `[system] Review requested — eligible reviewers: ${names}`,
      },
    });
  } else {
    await prisma.comment.create({
      data: {
        taskId,
        content: `[system] Review requested — no eligible reviewers found`,
      },
    });
  }

  void logAuditEvent({
    action: "task.reviewed",
    projectId,
    taskId,
    payload: {
      event: "review_needed",
      recipientCount: recipients.length,
      recipients: recipients.map((r) => ({ type: r.type, id: r.id, name: r.name })),
    },
  });

  return recipients;
}

/**
 * Emit changes-requested signal to the original assignee.
 * Called when a reviewer requests changes (review → in_progress).
 *
 * Side effects:
 *   - Creates durable Signal for the original assignee
 *   - Logs audit event
 */
export async function emitChangesRequestedSignal(
  taskId: string,
  projectId: string,
  assigneeUserId: string | null,
  assigneeAgentId: string | null,
  reviewerName: string,
  reviewComment?: string,
): Promise<void> {
  if (!assigneeUserId && !assigneeAgentId) return;

  const context = await buildSignalContext(taskId, "agent", reviewerName, { reviewComment });
  if (!context) return;

  await createSignal({
    type: "changes_requested",
    taskId,
    projectId,
    recipientAgentId: assigneeAgentId,
    recipientUserId: assigneeUserId,
    context,
  });

  void logAuditEvent({
    action: "task.reviewed",
    projectId,
    taskId,
    payload: {
      event: "changes_requested_signal",
      recipientAgentId: assigneeAgentId,
      recipientUserId: assigneeUserId,
      reviewer: reviewerName,
    },
  });
}

/**
 * Emit task-approved signal to the original assignee.
 * Called when a reviewer approves (review → done).
 */
export async function emitTaskApprovedSignal(
  taskId: string,
  projectId: string,
  assigneeUserId: string | null,
  assigneeAgentId: string | null,
  reviewerName: string,
  reviewComment?: string,
): Promise<void> {
  if (!assigneeUserId && !assigneeAgentId) return;

  const context = await buildSignalContext(taskId, "agent", reviewerName, { reviewComment });
  if (!context) return;

  await createSignal({
    type: "task_approved",
    taskId,
    projectId,
    recipientAgentId: assigneeAgentId,
    recipientUserId: assigneeUserId,
    context,
  });
}
