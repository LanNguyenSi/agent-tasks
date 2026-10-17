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

// Pagination parameters go through this one parser on both project audit
// handlers: an absent parameter falls back to the default, a present value
// must be a string of decimal digits only (so empty, negative, fractional,
// exponent, whitespace and non-numeric values are refused with a 400 before
// any database call), and an optional cap such as the limit's 200 clamps a
// larger valid number rather than rejecting it. An uncapped value above
// MAX_PAGINATION_VALUE (the largest 32-bit integer, a deliberately
// conservative policy) is refused too, so a long digit string, which Prisma
// would reject past the 64-bit range, never reaches it.
const MAX_PAGINATION_VALUE = 2_147_483_647;

type ParsedPaginationParam =
  { ok: true; value: number } | { ok: false; error: string };

function parsePaginationParam(
  raw: string | undefined,
  name: string,
  defaultValue: number,
  cap?: number,
): ParsedPaginationParam {
  if (raw === undefined) return { ok: true, value: defaultValue };
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      error: `${name} must be a non-negative integer (digits only)`,
    };
  }
  const value = Number(raw);
  if (value > MAX_PAGINATION_VALUE && cap === undefined) {
    return {
      ok: false,
      error: `${name} must be at most ${MAX_PAGINATION_VALUE}`,
    };
  }
  return { ok: true, value: cap === undefined ? value : Math.min(value, cap) };
}

auditRouter.get("/projects/:projectId/audit", async (c) => {
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");

  if (!(await hasProjectAccess(actor, projectId))) {
    return forbidden(c, "Access denied");
  }

  const parsedLimit = parsePaginationParam(
    c.req.query("limit"),
    "limit",
    50,
    200,
  );
  if (!parsedLimit.ok)
    return errorResponse(c, 400, "bad_request", parsedLimit.error);
  const parsedOffset = parsePaginationParam(c.req.query("offset"), "offset", 0);
  if (!parsedOffset.ok)
    return errorResponse(c, 400, "bad_request", parsedOffset.error);
  const limit = parsedLimit.value;
  const offset = parsedOffset.value;

  // Optional server-side filter: keep only rows whose `action` starts with the
  // given prefix (for example "workflow." or "signal.webhook_"). A present but
  // malformed value is rejected rather than silently ignored.
  const rawActionPrefix = c.req.query("actionPrefix");
  if (
    rawActionPrefix !== undefined &&
    !ACTION_PREFIX_PATTERN.test(rawActionPrefix)
  ) {
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

  const parsedLimit = parsePaginationParam(
    c.req.query("limit"),
    "limit",
    50,
    200,
  );
  if (!parsedLimit.ok)
    return errorResponse(c, 400, "bad_request", parsedLimit.error);
  const parsedOffset = parsePaginationParam(c.req.query("offset"), "offset", 0);
  if (!parsedOffset.ok)
    return errorResponse(c, 400, "bad_request", parsedOffset.error);
  const limit = parsedLimit.value;
  const offset = parsedOffset.value;
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
