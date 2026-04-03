import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { hasProjectAccess } from "../services/team-access.js";
import { getAuditLogs } from "../services/audit.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";

export const auditRouter = new Hono<{ Variables: AppVariables }>();

auditRouter.get("/projects/:projectId/audit", async (c) => {
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");

  if (!(await hasProjectAccess(actor, projectId))) {
    return forbidden(c, "Access denied");
  }

  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const offset = Number(c.req.query("offset") ?? "0");

  const logs = await getAuditLogs({ projectId, limit, offset });
  return c.json({ logs, limit, offset });
});

auditRouter.get("/tasks/:taskId/audit", async (c) => {
  const actor = c.get("actor");
  const taskId = c.req.param("taskId");

  // Always verify task exists and actor has access — never skip based on log presence
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { projectId: true },
  });

  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied");
  }

  const logs = await getAuditLogs({ taskId, limit: 100 });
  return c.json({ logs });
});
