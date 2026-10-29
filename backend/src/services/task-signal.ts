/**
 * Task lifecycle signals.
 *
 * Emits signals when tasks become available for agents to claim.
 */
import type { Prisma, Signal } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createSignal, type SignalContext } from "./signal.js";
import { logAuditEvent } from "./audit.js";

/**
 * The agent tokens eligible to receive task_available signals: active
 * (non-revoked, non-expired) tokens of `teamId` with the tasks:claim scope.
 */
function claimEligibleAgentWhere(teamId: string): Prisma.AgentTokenWhereInput {
  return {
    teamId,
    revokedAt: null,
    scopes: { has: "tasks:claim" },
    OR: [
      { expiresAt: null },
      { expiresAt: { gt: new Date() } },
    ],
  };
}

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

  return prisma.agentToken.findMany({
    where: claimEligibleAgentWhere(project.teamId),
    select: { id: true, name: true },
  });
}

/**
 * Write the task_available signals for a task that was just created, on the
 * caller's own transaction client, and return the created rows so the caller
 * can deliver the outbound notification webhooks after commit. Used by a
 * creator that must keep the signals and the task in one commit (the
 * Grounding webhook handler: a replayed delivery returns its stored result
 * and never reaches this call, so it cannot duplicate them).
 *
 * The audit row carries the same `task_available_signal` event as
 * `emitTaskAvailableSignal`. Nothing is written when no agent is eligible.
 */
export async function createTaskAvailableSignalsInTx(
  db: Pick<Prisma.TransactionClient, "agentToken" | "signal" | "auditLog">,
  input: {
    task: { id: string; projectId: string; title: string; status: string; branchName: string | null; prUrl: string | null; prNumber: number | null };
    project: { teamId: string; slug: string; name: string };
    actor: { type: "human" | "agent" | "webhook"; name: string };
  },
): Promise<Signal[]> {
  const { task, project, actor } = input;
  const agents = await db.agentToken.findMany({
    where: claimEligibleAgentWhere(project.teamId),
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (agents.length === 0) return [];

  const context: SignalContext = {
    taskTitle: task.title,
    taskStatus: task.status,
    projectSlug: project.slug,
    projectName: project.name,
    branchName: task.branchName,
    prUrl: task.prUrl,
    prNumber: task.prNumber,
    actor,
  };
  const signals: Signal[] = [];
  for (const agent of agents) {
    signals.push(
      await db.signal.create({
        data: { type: "task_available", taskId: task.id, projectId: task.projectId, recipientAgentId: agent.id, context: context as object },
      }),
    );
  }
  await db.auditLog.create({
    data: { projectId: task.projectId, taskId: task.id, action: "task.created", payload: { event: "task_available_signal", recipientCount: agents.length } },
  });
  return signals;
}

/**
 * Emit task_available signal when a new claimable task appears.
 * Called when a task is created in the workflow's initial state (`open` in the
 * built-in workflow) or transitions to `open`.
 */
export async function emitTaskAvailableSignal(
  taskId: string,
  projectId: string,
  actorType: "human" | "agent" | "webhook",
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
