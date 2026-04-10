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
  | "task.imported";

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
  await prisma.auditLog.create({
    data: {
      action: opts.action,
      actorId: opts.actorId ?? null,
      projectId: opts.projectId ?? null,
      taskId: opts.taskId ?? null,
      payload: (opts.payload ?? {}) as object,
    },
  });
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
