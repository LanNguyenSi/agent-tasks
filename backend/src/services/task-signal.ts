/**
 * Task lifecycle signals.
 *
 * Emits signals when tasks become available for agents to claim.
 */
import { prisma } from "../lib/prisma.js";
import { createSignal, type SignalContext } from "./signal.js";
import { logAuditEvent } from "./audit.js";

/**
 * Find agents eligible to receive task_available signals.
 *
 * Eligibility: active (non-revoked, non-expired) tokens in the same team
 * with tasks:claim scope.
 */
async function findClaimEligibleAgents(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { teamId: true },
  });
  if (!project) return [];

  const now = new Date();
  return prisma.agentToken.findMany({
    where: {
      teamId: project.teamId,
      revokedAt: null,
      scopes: { has: "tasks:claim" },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    select: { id: true, name: true },
  });
}

/**
 * Emit task_available signal when a new claimable task appears.
 * Called when a task is created with status "open" or transitions to "open".
 */
export async function emitTaskAvailableSignal(
  taskId: string,
  projectId: string,
  actorType: "human" | "agent",
  actorName: string,
): Promise<void> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { project: { select: { slug: true, name: true } } },
  });
  if (!task) return;

  const agents = await findClaimEligibleAgents(projectId);
  if (agents.length === 0) return;

  const context: SignalContext = {
    taskTitle: task.title,
    taskStatus: task.status,
    projectSlug: task.project.slug,
    projectName: task.project.name,
    branchName: task.branchName,
    prUrl: task.prUrl,
    prNumber: task.prNumber,
    actor: { type: actorType, name: actorName },
  };

  for (const agent of agents) {
    await createSignal({
      type: "task_available",
      taskId,
      projectId,
      recipientAgentId: agent.id,
      context,
    });
  }

  void logAuditEvent({
    action: "task.created",
    projectId,
    taskId,
    payload: {
      event: "task_available_signal",
      recipientCount: agents.length,
    },
  });
}
