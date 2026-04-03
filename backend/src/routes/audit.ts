import { Hono } from "hono";
import { hasProjectAccess } from "../services/team-access.js";
import { getAuditLogs } from "../services/audit.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden } from "../middleware/error.js";

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

  const logs = await getAuditLogs({ taskId, limit: 100 });

  // Access check via first log's projectId (or just return if no logs)
  if (logs.length > 0 && logs[0]!.projectId) {
    if (!(await hasProjectAccess(actor, logs[0]!.projectId))) {
      return forbidden(c, "Access denied");
    }
  }

  return c.json({ logs });
});
