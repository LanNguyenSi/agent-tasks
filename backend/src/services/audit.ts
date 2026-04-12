/**
 * Audit Log Service
 *
 * Records all significant actions in the system.
 * Every task creation, claim, transition, token creation, etc. is logged here.
 * Audit logs are immutable — never deleted, never edited.
 */
import { prisma } from "../lib/prisma.js";

export type AuditAction =
  | "task.created"
  | "task.claimed"
  | "task.released"
  | "task.transitioned"
  | "task.transitioned.forced"
  | "task.commented"
  | "task.reviewed"
  | "project.created"
  | "project.updated"
  | "project.synced"
  | "token.created"
  | "token.revoked"
  | "user.login"
  | "user.logout"
  | "github.pr_created"
  | "github.pr_merged"
  | "github.pr_commented"
  | "task.imported"
  // Workflow mutations — added so admins editing gates, renaming
  // states, or dropping a custom workflow leave a reconstructible
  // trail. Previously the only record was `updated_at` on the row,
  // which made it impossible to see who disabled a gate or when.
  | "workflow.created"
  | "workflow.customized"
  | "workflow.updated"
  | "workflow.reset";

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
    console.error(
      `[audit] failed to write ${opts.action} for actor=${opts.actorId ?? "-"} project=${opts.projectId ?? "-"} task=${opts.taskId ?? "-"}:`,
      (err as Error).message,
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
