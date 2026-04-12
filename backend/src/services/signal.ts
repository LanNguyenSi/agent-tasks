/**
 * Agent Signal Service
 *
 * Creates and queries durable signals for local agent consumption.
 * Signals are token-scoped, typed, and include inline context
 * per docs/signal-payload-design.md.
 */
import { prisma } from "../lib/prisma.js";

export type SignalType =
  | "review_needed"
  | "changes_requested"
  | "task_approved"
  | "task_assigned"
  | "task_available"
  | "task_force_transitioned";

export interface SignalContext {
  taskTitle: string;
  taskStatus: string;
  projectSlug: string;
  projectName: string;
  branchName?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  actor: {
    type: "human" | "agent" | "webhook";
    name: string;
  };
  reviewComment?: string;
  assigneeName?: string;
  // Populated on `task_force_transitioned` signals. A team admin forced a
  // transition past one or more failed `requires` rules — recipients (task
  // claimant + active reviewer) are notified so the override is visible
  // without reading the audit log.
  forceTransition?: {
    from: string;
    to: string;
    forcedRules: string[];
    forceReason?: string | null;
  };
}

export interface CreateSignalInput {
  type: SignalType;
  taskId: string;
  projectId: string;
  recipientAgentId?: string | null;
  recipientUserId?: string | null;
  context: SignalContext;
}

/** Create a signal for a specific recipient */
export async function createSignal(input: CreateSignalInput) {
  return prisma.signal.create({
    data: {
      type: input.type,
      taskId: input.taskId,
      projectId: input.projectId,
      recipientAgentId: input.recipientAgentId ?? null,
      recipientUserId: input.recipientUserId ?? null,
      context: input.context as object,
    },
  });
}

/** Create signals for multiple recipients */
export async function createSignals(inputs: CreateSignalInput[]) {
  return prisma.signal.createMany({
    data: inputs.map((input) => ({
      type: input.type,
      taskId: input.taskId,
      projectId: input.projectId,
      recipientAgentId: input.recipientAgentId ?? null,
      recipientUserId: input.recipientUserId ?? null,
      context: input.context as object,
    })),
  });
}

export type SignalStatusFilter = "unread" | "acknowledged" | "all";

function ackFilter(status: SignalStatusFilter) {
  if (status === "unread") return { acknowledgedAt: null };
  if (status === "acknowledged") return { acknowledgedAt: { not: null } };
  return {};
}

/** Fetch signals for an agent token */
export async function getAgentSignals(agentTokenId: string, opts?: { limit?: number; status?: string }) {
  const status = (opts?.status ?? "unread") as SignalStatusFilter;
  return prisma.signal.findMany({
    where: {
      recipientAgentId: agentTokenId,
      ...ackFilter(status),
    },
    orderBy: { createdAt: "asc" },
    take: opts?.limit ?? 50,
  });
}

/** Fetch signals for a human user */
export async function getUserSignals(userId: string, opts?: { limit?: number; status?: string }) {
  const status = (opts?.status ?? "unread") as SignalStatusFilter;
  return prisma.signal.findMany({
    where: {
      recipientUserId: userId,
      ...ackFilter(status),
    },
    orderBy: { createdAt: "asc" },
    take: opts?.limit ?? 50,
  });
}

/** Acknowledge a signal (mark as processed) */
export async function acknowledgeSignal(signalId: string, recipientAgentId?: string, recipientUserId?: string) {
  const signal = await prisma.signal.findUnique({ where: { id: signalId } });
  if (!signal) return null;

  // Verify recipient owns this signal
  if (recipientAgentId && signal.recipientAgentId !== recipientAgentId) return null;
  if (recipientUserId && signal.recipientUserId !== recipientUserId) return null;

  return prisma.signal.update({
    where: { id: signalId },
    data: { acknowledgedAt: new Date() },
  });
}
