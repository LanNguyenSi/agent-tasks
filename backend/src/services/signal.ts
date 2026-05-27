/**
 * Agent Signal Service
 *
 * Creates and queries durable signals for local agent consumption.
 * Signals are token-scoped, typed, and include inline context
 * per docs/signal-payload-design.md.
 *
 * When the parent project has `notificationWebhookUrl` configured, every
 * successful create also fires an outbound POST via the
 * notification-webhook service (best-effort, void). See
 * docs/notification-webhooks.md.
 */
import { prisma } from "../lib/prisma.js";
import { deliverSignalWebhook } from "./notification-webhook.js";

export type SignalType =
  | "review_needed"
  | "changes_requested"
  | "task_approved"
  | "task_assigned"
  | "task_available"
  | "task_force_transitioned"
  | "self_merge_notice";

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
  const signal = await prisma.signal.create({
    data: {
      type: input.type,
      taskId: input.taskId,
      projectId: input.projectId,
      recipientAgentId: input.recipientAgentId ?? null,
      recipientUserId: input.recipientUserId ?? null,
      context: input.context as object,
    },
  });
  // Best-effort push delivery. Fires only when the project has a
  // notification webhook configured. Never throws, never blocks: a network
  // hiccup or a 5xx receiver must not corrupt the originating request.
  void maybeDeliverSignalWebhook(signal);
  return signal;
}

/**
 * Create signals for multiple recipients.
 *
 * Loops createSignal per recipient (instead of a single createMany) so
 * webhook delivery fires per row. Real callers (review-signal,
 * task-signal, force-transition-signal, self-merge-notice) already loop
 * createSignal themselves; this verb is kept as a convenience for
 * callers that prefer a single batch entry point.
 */
export async function createSignals(inputs: CreateSignalInput[]) {
  const created = [];
  for (const input of inputs) {
    created.push(await createSignal(input));
  }
  return created;
}

/**
 * Look up the parent project's webhook config and dispatch the outbound
 * POST if configured. Swallows any unexpected error so the originating
 * `createSignal` call cannot fail.
 */
async function maybeDeliverSignalWebhook(signal: {
  id: string;
  type: string;
  taskId: string;
  projectId: string;
  recipientAgentId: string | null;
  recipientUserId: string | null;
  context: unknown;
  createdAt: Date;
}): Promise<void> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: signal.projectId },
      select: {
        slug: true,
        notificationWebhookUrl: true,
        notificationWebhookSecret: true,
      },
    });
    if (!project?.notificationWebhookUrl) return;
    await deliverSignalWebhook({
      signalId: signal.id,
      signalType: signal.type as SignalType,
      taskId: signal.taskId,
      projectId: signal.projectId,
      projectSlug: project.slug,
      recipientAgentId: signal.recipientAgentId,
      recipientUserId: signal.recipientUserId,
      context: signal.context as SignalContext,
      createdAt: signal.createdAt,
      webhookUrl: project.notificationWebhookUrl,
      webhookSecret: project.notificationWebhookSecret,
    });
  } catch {
    // deliverSignalWebhook never throws; the only path here is the project
    // lookup. Swallow so createSignal stays infallible from the caller's
    // perspective.
  }
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

/**
 * Ack every pending signal targeting a task. Called on the status-transition
 * paths that land a task in `done`, so `review_needed` / `task_available` /
 * etc. don't linger in the pickup queue after their underlying task is
 * terminal.
 *
 * Idempotent: `updateMany` with the same task_id is a no-op after the first
 * call.
 */
export async function acknowledgeSignalsForTask(taskId: string) {
  return prisma.signal.updateMany({
    where: { taskId, acknowledgedAt: null },
    data: { acknowledgedAt: new Date() },
  });
}
