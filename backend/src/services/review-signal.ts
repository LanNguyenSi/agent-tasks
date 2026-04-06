/**
 * Review Signal Service
 *
 * Emits review-needed signals when a task enters the review state.
 * Determines eligible reviewers (team agents + humans, excluding the assignee).
 */
import { prisma } from "../lib/prisma.js";
import { logAuditEvent } from "./audit.js";

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

/**
 * Emit a review-needed signal for a task.
 * Called when a task transitions to "review".
 *
 * Side effects:
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
