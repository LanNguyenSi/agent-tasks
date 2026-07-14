/**
 * TTL sweep for the idempotency dedup tables.
 *
 * Follow-up from PR #372 (M2 webhook idempotency), reviewer finding (LOW):
 * both `webhook_deliveries` (services/github-webhook.ts) and the sibling
 * `tool_invocations` (services/idempotency.ts) tables carry an
 * `@@index([createdAt])` "for a future TTL sweep" (see schema.prisma), but
 * nothing pruned them — a row is written per webhook delivery / per
 * idempotent MCP call and never deleted, so both tables grow unbounded.
 *
 * This module deletes rows older than a retention window (env-configurable,
 * default 30 days — see config.IDEMPOTENCY_TTL_DAYS) from both tables and
 * schedules that deletion to run periodically. The retention window is
 * chosen to comfortably exceed GitHub's webhook redelivery window and any
 * realistic MCP client retry window, so pruning never discards a row a
 * legitimate retry could still land against.
 */
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";

export interface IdempotencySweepResult {
  webhookDeliveries: number;
  toolInvocations: number;
}

/**
 * Delete idempotency rows older than `retentionDays` from both dedup
 * tables. Safe to call concurrently with normal traffic — plain
 * `deleteMany` on an indexed `createdAt` column, no locking beyond what
 * Postgres does for the delete itself.
 */
export async function sweepIdempotencyTables(
  retentionDays: number = config.IDEMPOTENCY_TTL_DAYS,
): Promise<IdempotencySweepResult> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const [webhookDeliveries, toolInvocations] = await Promise.all([
    prisma.webhookDelivery.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.toolInvocation.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);

  const result: IdempotencySweepResult = {
    webhookDeliveries: webhookDeliveries.count,
    toolInvocations: toolInvocations.count,
  };

  if (result.webhookDeliveries > 0 || result.toolInvocations > 0) {
    logger.info(result, "idempotency TTL sweep: pruned expired rows");
  }

  return result;
}

// In-process reentrancy guard: if a tick is still running (e.g. a slow
// delete under load) the next timer tick skips rather than overlapping.
//
// Multi-instance risk: this guard is per-process only. Behind more than
// one backend instance, each instance runs its own timer and its own
// guard, so overlapping deletes across instances are possible (the same
// footgun already documented for the in-memory rate-limit store in
// middleware/rate-limit.ts). That's harmless here — concurrent
// `deleteMany` calls on the same predicate are idempotent, just wasted
// work — but if this backend ever runs multi-instance, prefer electing a
// single sweeper (e.g. an advisory lock or a dedicated cron hitting one
// instance) over running the timer on every instance.
let sweepInFlight = false;

/**
 * Start the periodic sweep. Matches the `setInterval(...).unref()` pattern
 * already used for the rate-limit store's cleanup (middleware/rate-limit.ts)
 * — a bare timer registered once at process startup, unref'd so it never
 * keeps the process alive on its own.
 *
 * Call once from the process entrypoint (server.ts), not from `app.ts` /
 * `createApp`, so importing the app for tests never registers a live timer.
 */
export function scheduleIdempotencySweep(
  intervalMs = 6 * 60 * 60 * 1000, // every 6h
  retentionDays: number = config.IDEMPOTENCY_TTL_DAYS,
): NodeJS.Timeout {
  const tick = async () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      await sweepIdempotencyTables(retentionDays);
    } catch (err) {
      logger.error({ err }, "idempotency TTL sweep failed");
    } finally {
      sweepInFlight = false;
    }
  };

  return setInterval(tick, intervalMs).unref();
}
