/**
 * Agent Signal Service
 *
 * Creates and queries durable signals for local agent consumption.
 * Signals are token-scoped, typed, and include inline context
 * per docs/signal-payload-design.md.
 *
 * When the parent project has `notificationWebhookUrl` configured, a
 * successful create also fires an outbound POST via the notification-webhook
 * service (best-effort, void). One event that fans out to several recipients
 * (every eligible reviewer, every claim-eligible agent, ...) writes one Signal
 * row per recipient but sends exactly ONE webhook delivery, carrying the whole
 * recipient list. See docs/notification-webhooks.md.
 */
import type { Prisma, Signal } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { deliverSignalWebhook } from "./notification-webhook.js";

export type SignalType =
  | "review_needed"
  | "changes_requested"
  | "task_approved"
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

/**
 * Insert one Signal row without any push delivery. The building block of
 * `createSignal` and of the fan-out writers: a writer that creates one row per
 * recipient of a single event inserts them with this and then hands the whole
 * set to `maybeDeliverSignalWebhooks`, so the receiver gets one delivery for the
 * event instead of one per recipient.
 */
export async function insertSignalRow(input: CreateSignalInput): Promise<Signal> {
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

/** Create a signal for a specific recipient (one event, one recipient, one delivery) */
export async function createSignal(input: CreateSignalInput) {
  const signal = await insertSignalRow(input);
  // Best-effort push delivery. Fires only when the project has a
  // notification webhook configured. Never throws, never blocks: a network
  // hiccup or a 5xx receiver must not corrupt the originating request.
  void maybeDeliverSignalWebhook(signal);
  return signal;
}

/**
 * Create the signals of ONE event for multiple recipients.
 *
 * Inserts one row per recipient (instead of a single createMany, which cannot
 * return the generated ids the webhook needs) and then fires a single webhook
 * delivery for the whole set once every row exists. The inputs must describe one
 * event (same type and task); `maybeDeliverSignalWebhooks` sends one delivery
 * per (project, task, type) group, so a mixed list still never repeats a group.
 * If a row insert throws, the rows already written are still delivered (as one
 * delivery) before the error propagates, because they exist and are pollable.
 */
export async function createSignals(inputs: CreateSignalInput[]) {
  const created: Signal[] = [];
  try {
    for (const input of inputs) {
      created.push(await insertSignalRow(input));
    }
  } finally {
    void maybeDeliverSignalWebhooks(created);
  }
  return created;
}

/** The Signal columns the webhook delivery reads. */
type DeliverableSignal = {
  id: string;
  type: string;
  taskId: string;
  projectId: string;
  recipientAgentId: string | null;
  recipientUserId: string | null;
  context: unknown;
  createdAt: Date;
};

/**
 * Deliver the webhook for a single freshly created signal. Equivalent to
 * `maybeDeliverSignalWebhooks([signal], db)`.
 */
export async function maybeDeliverSignalWebhook(
  signal: DeliverableSignal,
  db: Pick<Prisma.TransactionClient, "project"> = prisma,
): Promise<void> {
  await maybeDeliverSignalWebhooks([signal], db);
}

/**
 * Look up the parent project's webhook config and dispatch the outbound
 * POST if configured, ONE delivery per event. Signals are grouped by
 * (project, task, type): every group is one event that fanned out to its
 * recipients, so the group gets a single delivery whose payload carries all of
 * its recipients. The first signal of a group is the primary one: its id,
 * recipient fields and createdAt stay the top-level payload fields, so a
 * receiver that only knows the single-recipient shape keeps working.
 *
 * Swallows any unexpected error so the originating write cannot fail.
 */
export async function maybeDeliverSignalWebhooks(
  signals: DeliverableSignal[],
  db: Pick<Prisma.TransactionClient, "project"> = prisma,
): Promise<void> {
  const groups = new Map<string, DeliverableSignal[]>();
  for (const signal of signals) {
    const key = `${signal.projectId}\u0000${signal.taskId}\u0000${signal.type}`;
    const group = groups.get(key);
    if (group) group.push(signal);
    else groups.set(key, [signal]);
  }
  await Promise.all([...groups.values()].map((group) => deliverSignalGroup(group, db)));
}

async function deliverSignalGroup(
  group: DeliverableSignal[],
  db: Pick<Prisma.TransactionClient, "project">,
): Promise<void> {
  const primary = group[0];
  if (!primary) return;
  try {
    const project = await db.project.findUnique({
      where: { id: primary.projectId },
      select: {
        slug: true,
        notificationWebhookUrl: true,
        notificationWebhookSecret: true,
      },
    });
    if (!project?.notificationWebhookUrl) return;
    await deliverSignalWebhook({
      signalId: primary.id,
      signalType: primary.type as SignalType,
      taskId: primary.taskId,
      projectId: primary.projectId,
      projectSlug: project.slug,
      recipientAgentId: primary.recipientAgentId,
      recipientUserId: primary.recipientUserId,
      recipients: group.map((s) => ({
        signalId: s.id,
        recipientAgentId: s.recipientAgentId,
        recipientUserId: s.recipientUserId,
      })),
      context: primary.context as SignalContext,
      createdAt: primary.createdAt,
      webhookUrl: project.notificationWebhookUrl,
      webhookSecret: project.notificationWebhookSecret,
    });
  } catch {
    // deliverSignalWebhook never throws; the only path here is the project
    // lookup. Swallow so the signal writers stay infallible from the caller's
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
