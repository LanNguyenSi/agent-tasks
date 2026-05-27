/**
 * Audit Log Service
 *
 * Records all significant actions in the system.
 * Every task creation, claim, transition, token creation, etc. is logged here.
 * Audit logs are immutable — never deleted, never edited.
 */
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export type AuditAction =
  | "task.created"
  | "task.claimed"
  | "task.released"
  | "task.transitioned"
  | "task.transitioned.forced"
  | "task.commented"
  | "task.reviewed"
  | "task.review_rejected_self_reviewer"
  | "task.merge_rejected_bad_status"
  | "task.pr_submitted"
  | "project.created"
  | "project.updated"
  | "project.synced"
  | "token.created"
  | "token.revoked"
  | "user.login"
  | "user.logout"
  | "user.registered"
  | "github.pr_created"
  | "github.pr_merged"
  | "github.pr_merge_failed"
  | "github.pr_commented"
  | "task.auto_merged"
  | "task.auto_merge_post_assert_failed"
  | "task.imported"
  | "task.artifact.created"
  | "task.artifact.deleted"
  | "task.merged"
  | "task.pr_merged.blocked_self_merge"
  | "task.self_merge_notice_emitted"
  // Workflow mutations — added so admins editing gates, renaming
  // states, or dropping a custom workflow leave a reconstructible
  // trail. Previously the only record was `updated_at` on the row,
  // which made it impossible to see who disabled a gate or when.
  | "workflow.created"
  | "workflow.customized"
  | "workflow.updated"
  | "workflow.reset"
  | "workflow.template_applied"
  // Phase 3 grounding finish-gate. Fires on `/tasks/:id/finish` work-claim
  // path when a debug-flavored task would have hit the gate but the project
  // is not opted in (`requireGroundingForDebug=false`). Lets operators
  // retroactively see what would have been blocked.
  | "task.grounding_gate.bypassed"
  // Per-project sharing. Track invite lifecycle and member removal so
  // the audit trail shows who shared a project with whom and why a
  // ProjectMember row appeared or vanished.
  | "project.invite_created"
  | "project.invite_consumed"
  | "project.invite_revoked"
  | "project.member_removed"
  // Auto-flip emitted by the invite accept-handler when the first
  // ProjectMember consumes an invite on a previously-soloMode project.
  // soloMode bypasses the distinct-reviewer gate; once a second human is
  // in the loop, the gate must become real.
  | "project.solo_mode_disabled_by_share"
  // ADR-0011 confidence-gate events. Blocked: agent claim refused
  // because score < threshold. Override: agent claim allowed via
  // ?force=true + forceReason where the score would have been blocked.
  // Override-with-passing-score is NOT recorded (force is a no-op).
  | "task.claim_blocked_low_readiness"
  | "task.claim_override_used"
  // Outbound Signal-webhook delivery. Fired by
  // services/notification-webhook.ts after every POST attempt the project's
  // `notificationWebhookUrl` produces. `delivered` records the final
  // success (2xx after at most one retry); `failed` records the give-up
  // after the retry. Both carry the signalId so operators can correlate
  // with the originating Signal row.
  | "signal.webhook_delivered"
  | "signal.webhook_failed";

export interface AuditPayload {
  [key: string]: unknown;
}

export async function logAuditEvent(opts: {
  action: AuditAction;
  actorId?: string;
  projectId?: string;
  taskId?: string;
  payload?: AuditPayload;
}): Promise<void> {
  // Audit writes are fire-and-forget (`void logAuditEvent(...)`) from
  // every call site so the 200 response isn't blocked on audit latency.
  // That means any rejection here becomes an unhandled promise rejection,
  // which crashes the Node process under the default `throw` policy.
  // Swallow the rejection with a structured log line so a DB hiccup or
  // constraint violation can't take the backend down — audit is
  // supplementary, not load-bearing.
  try {
    await prisma.auditLog.create({
      data: {
        action: opts.action,
        actorId: opts.actorId ?? null,
        projectId: opts.projectId ?? null,
        taskId: opts.taskId ?? null,
        payload: (opts.payload ?? {}) as object,
      },
    });
  } catch (err) {
    logger.error(
      {
        component: "audit",
        action: opts.action,
        actorId: opts.actorId ?? null,
        projectId: opts.projectId ?? null,
        taskId: opts.taskId ?? null,
        errMessage: (err as Error).message,
      },
      "audit log write failed",
    );
  }
}

export async function getAuditLogs(opts: {
  projectId?: string;
  taskId?: string;
  actorId?: string;
  action?: string;
  actionPrefix?: string;
  limit?: number;
  offset?: number;
}) {
  return prisma.auditLog.findMany({
    where: {
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.actorId ? { actorId: opts.actorId } : {}),
      ...(opts.action ? { action: opts.action } : {}),
      ...(opts.actionPrefix ? { action: { startsWith: opts.actionPrefix } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
    skip: opts.offset ?? 0,
  });
}
