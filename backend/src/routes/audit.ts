import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { hasProjectAccess } from "../services/team-access.js";
import { getAuditLogs } from "../services/audit.js";
import type { AppVariables } from "../types/hono.js";
import { errorResponse, forbidden, notFound } from "../middleware/error.js";

export const auditRouter = new Hono<{ Variables: AppVariables }>();

// Audit action names are dotted lowercase identifiers such as
// "task.claim_blocked_low_readiness" or "github.pr_created". The prefix filter
// accepts only that alphabet; getAuditLogs matches it literally.
const ACTION_PREFIX_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

auditRouter.get("/projects/:projectId/audit", async (c) => {
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");

  if (!(await hasProjectAccess(actor, projectId))) {
    return forbidden(c, "Access denied");
  }

  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const offset = Number(c.req.query("offset") ?? "0");

  // Optional server-side filter: keep only rows whose `action` starts with the
  // given prefix (for example "workflow." or "signal.webhook_"). A present but
  // malformed value is rejected rather than silently ignored.
  const rawActionPrefix = c.req.query("actionPrefix");
  if (rawActionPrefix !== undefined && !ACTION_PREFIX_PATTERN.test(rawActionPrefix)) {
    return errorResponse(
      c,
      400,
      "bad_request",
      "actionPrefix must be 1-100 characters from A-Z, a-z, 0-9, '.', '_', ':' and '-'",
    );
  }

  const logs = await getAuditLogs({
    projectId,
    ...(rawActionPrefix !== undefined ? { actionPrefix: rawActionPrefix } : {}),
    limit,
    offset,
  });
  return c.json({ logs, limit, offset });
});

auditRouter.get("/projects/:projectId/audit/github-delegation", async (c) => {
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");

  if (!(await hasProjectAccess(actor, projectId))) {
    return forbidden(c, "Access denied");
  }

  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const offset = Number(c.req.query("offset") ?? "0");
  const action = c.req.query("action"); // e.g. "github.pr_created"

  const logs = await getAuditLogs({
    projectId,
    ...(action ? { action } : { actionPrefix: "github." }),
    limit,
    offset,
  });
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
