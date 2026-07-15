import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { Prisma } from "@prisma/client";
import { forbidden, notFound, conflict } from "../middleware/error.js";
import {
  hasProjectAccess,
  hasProjectRole,
  isProjectAdmin,
  requireProjectWrite,
  resolveTeamId,
  resolveTeamIdErrorBody,
  type ProjectRole,
} from "../services/team-access.js";
import { logAuditEvent } from "../services/audit.js";
import { emitReviewSignal, emitChangesRequestedSignal, emitTaskApprovedSignal } from "../services/review-signal.js";
import { emitTaskAvailableSignal } from "../services/task-signal.js";
import { acknowledgeSignalsForTask, type SignalType } from "../services/signal.js";
import { emitSelfMergeNoticeIfApplicable } from "../services/self-merge-notice.js";
import { GovernanceMode, resolveGovernanceMode } from "../lib/governance-mode.js";
import { logger, setLogContext } from "../lib/logger.js";
import {
  detectDebugFlavor,
  buildGroundingHint,
  buildGroundingHintWithSession,
  getSessionPhase,
  readMetadata,
  type GroundingHint,
  type TaskMetadata,
} from "../lib/debug-flavor.js";
import { evaluateGroundingGate } from "../services/gates/grounding-gate.js";
import {
  getGroundingClient,
  type GroundingClient,
  type GroundingStartResult,
} from "../services/grounding-client.js";

// Signals that become meaningless once the underlying task is `done`.
// Outcome-notification signals (`task_approved`, `changes_requested`,
// `task_force_transitioned`) are intentionally NOT listed — they are
// emitted against terminal tasks by design and must still reach recipients.
const STALE_WHEN_DONE: SignalType[] = ["review_needed", "task_available", "task_assigned"];
import { templateDataSchema, calculateConfidence, type TemplateData, type TemplateFields } from "../lib/confidence.js";
import { resolveEnforcementMode } from "../lib/enforcement-mode.js";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "../lib/task-creation-readiness.js";
import { evaluateConfidenceGate, deriveNextActions } from "../services/confidence-gate.js";
import {
  DEFAULT_TRANSITIONS,
  findDefaultTransition,
  defaultWorkflowDefinition,
  resolveEffectiveDefinition,
  resolveProjectEffectiveDefinition,
  expectedFinishStateFromDefinition,
  isInitialState,
  isTerminalState,
  isReviewState,
  isWorkState,
  firstTransitionTarget,
  terminalStates,
  reviewStates,
  approveTarget,
  requestChangesTarget,
  type WorkflowDefinitionShape,
} from "../services/default-workflow.js";
import { findDelegationUser } from "../services/github-delegation.js";
import { GITHUB_BACKED_RULES, parseOwnerRepo } from "../services/transition-rules.js";
import { performPrMerge } from "../services/github-merge.js";
import { emitForceTransitionedSignal } from "../services/force-transition-signal.js";
import {
  checkDistinctReviewerGate,
  checkReviewApprovalGate,
  distinctReviewerRejectionMessage,
  checkSelfMergeGate,
  selfMergeRejectionMessage,
  checkPrRepoMatchesProject,
  prRepoMatchesProjectRejectionMessage,
  effectiveDeliverableRepo,
  isForeignDeliverable,
} from "../services/gates/index.js";
import { SCOPES } from "../services/scopes.js";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_BODY_LIMIT_BYTES,
  detectAttachmentType,
  sanitizeDisplayName,
  storedFilename,
  storedFilePath,
  ensureUploadDir,
  contentDisposition,
} from "../services/attachment-files.js";
import { readAttachmentContent, parseIncludeBase64Flag } from "../services/attachment-content.js";
import { httpUrl } from "../lib/url-guard.js";


export const taskRouter = new Hono<{ Variables: AppVariables }>();

// Surface taskId / projectId from the path on every log line emitted within
// these routes — meets the acceptance criterion that
// `docker logs … | jq 'select(.taskId == "<id>")'` returns the full request
// trace without route handlers having to thread context manually.
taskRouter.use("/tasks/:id/*", async (c, next) => {
  const id = c.req.param("id");
  if (id) setLogContext({ taskId: id });
  await next();
});
taskRouter.use("/projects/:projectId/*", async (c, next) => {
  const projectId = c.req.param("projectId");
  if (projectId) setLogContext({ projectId });
  await next();
});

const taskInclude = {
  attachments: {
    orderBy: { createdAt: "desc" as const },
    // Metadata only (no file bytes are stored in the DB). createdByUser gives
    // the UI the uploader without a second round-trip.
    include: {
      createdByUser: { select: { id: true, login: true, name: true, avatarUrl: true } },
    },
  },
  artifacts: {
    orderBy: { createdAt: "desc" as const },
    // Omit `content` in the default task view — artifact payloads can be large
    // (up to ARTIFACT_MAX_BYTES). Clients fetch individual artifacts to get content.
    select: {
      id: true,
      taskId: true,
      type: true,
      name: true,
      description: true,
      url: true,
      mimeType: true,
      sizeBytes: true,
      createdByUserId: true,
      createdByAgentId: true,
      createdAt: true,
      createdByUser: { select: { id: true, login: true, name: true, avatarUrl: true } },
      createdByAgent: { select: { id: true, name: true } },
    },
  },
  comments: {
    orderBy: { createdAt: "asc" as const },
    include: {
      authorUser: { select: { id: true, login: true, name: true, avatarUrl: true } },
      authorAgent: { select: { id: true, name: true } },
    },
  },
  claimedByUser: {
    select: {
      id: true,
      login: true,
      name: true,
      avatarUrl: true,
    },
  },
  claimedByAgent: {
    select: {
      id: true,
      name: true,
    },
  },
  // Mirror the work-claim includes so a task response can NAME the review
  // claim holder (the admin claim-release UI warns with the holder's name,
  // not a raw id). Additive: consumers that ignore these fields are
  // unaffected.
  reviewClaimedByUser: {
    select: {
      id: true,
      login: true,
      name: true,
      avatarUrl: true,
    },
  },
  reviewClaimedByAgent: {
    select: {
      id: true,
      name: true,
    },
  },
  blockedBy: {
    select: { id: true, title: true, status: true },
  },
  blocks: {
    select: { id: true, title: true, status: true },
  },
};

/** Lightweight include for list/dashboard views — no comments or attachments. */
const taskListInclude = {
  claimedByUser: {
    select: { id: true, login: true, name: true, avatarUrl: true },
  },
  claimedByAgent: {
    select: { id: true, name: true },
  },
  blockedBy: {
    select: { id: true, title: true, status: true },
  },
  blocks: {
    select: { id: true, title: true, status: true },
  },
};
// Cross-repo deliverable override (ADR-0010 §5c): exactly one slash, both
// sides non-empty, no whitespace. Deliberately stricter than parseOwnerRepo()
// (which tolerates a repo segment containing a slash, e.g. "a/b/c" parses as
// owner="a" repo="b/c") — task-authored input should not silently accept a
// multi-segment repo pointer.
const deliverableRepoSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(/^[^/\s]+\/[^/\s]+$/, "deliverableRepo must be in 'owner/repo' format");

export const createTaskSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.enum(["open", "in_progress", "review", "done"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  workflowId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
  templateData: templateDataSchema.optional(),
  externalRef: z.string().trim().min(1).max(255).optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  // Task IDs (same project) that must complete before this task is pickable.
  // Informational + gating: task_pickup already filters tasks whose blockers
  // aren't `done`. Post-create dep management lives on the
  // /tasks/:id/dependencies endpoints (human-only).
  dependsOn: z.array(z.string().uuid()).max(50).optional(),
  // Explicit opt-in/out for debug-flavor classification. When omitted the
  // backend leaves `metadata.debugFlavor` unset and the title/description/label
  // heuristic (`detectDebugFlavor`) runs lazily at task_pickup. When set, the
  // value is persisted into `metadata.debugFlavor` at create time and the
  // pickup-time heuristic is skipped — `true` forces the grounding hint,
  // `false` suppresses it deterministically.
  debugFlavor: z.boolean().optional(),
  // Cross-repo deliverable override (ADR-0010 §5c). Accepted from both
  // agents and humans at create time — safe because post-create changes are
  // human-project-admin-only (see updateTaskSchema / agentUpdateTaskSchema
  // below). A value equal to the project's own githubRepo is a harmless
  // no-op and is NOT rejected.
  deliverableRepo: deliverableRepoSchema.optional(),
});

// updateTaskSchema and agentUpdateTaskSchema use httpUrl() from lib/url-guard
// (http(s)-scheme allowlist) rather than a bare string-url to prevent
// stored XSS when the prUrl is rendered as an <a href> in the UI.
// task_finish / submit-pr use the stricter github PR regex below.
const updateTaskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  status: z.enum(["open", "in_progress", "review", "done"]).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  branchName: z.string().max(255).nullable().optional(),
  prUrl: httpUrl().nullable().optional(),
  prNumber: z.number().int().positive().nullable().optional(),
  result: z.string().nullable().optional(),
  templateData: templateDataSchema.nullable().optional(),
  externalRef: z.string().trim().min(1).max(255).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  // Cross-repo deliverable override (ADR-0010 §5c). Human-project-admin-only
  // to set OR clear — enforced in the route handler, not here (this schema
  // has no actor context). Agents never see this field: agentUpdateTaskSchema
  // omits it and the route rejects any agent PATCH body that names it.
  deliverableRepo: deliverableRepoSchema.nullable().optional(),
});

const agentUpdateTaskSchema = z.object({
  branchName: z.string().max(255).nullable().optional(),
  prUrl: httpUrl().nullable().optional(),
  prNumber: z.number().int().positive().nullable().optional(),
  result: z.string().nullable().optional(),
});

const transitionSchema = z.object({
  status: z.string().min(1),
  // When set, bypasses workflow precondition checks (branchPresent, prPresent,
  // …) — but not the transition existence / required-role checks. Only team
  // admins may set this, and every forced transition writes an audit event
  // with the bypassed rules.
  force: z.boolean().optional(),
  // Optional justification surfaced in the audit payload when force=true.
  forceReason: z.string().max(500).optional(),
});

import {
  evaluateTransitionRules,
  RULE_MESSAGES,
  type TransitionRule,
} from "../services/transition-rules.js";

const createAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  // httpUrl() allowlists http(s) at the boundary: a bare string-url also
  // accepts javascript:/data:/vbscript: URLs, which become stored-XSS once
  // rendered as a link in the UI.
  url: httpUrl({ max: 2048 }),
});

// ── Artifact config / validation ─────────────────────────────────────────────
//
// Artifacts are typed, agent-produced task outputs. Distinct from TaskAttachment,
// which is a human-uploaded metadata pointer. See /docs/artifacts.md for details.

const ARTIFACT_TYPES = [
  "build_log",
  "test_report",
  "generated_code",
  "coverage",
  "diff",
  "other",
] as const;

// Cap per artifact when content is stored inline. 1 MiB is large enough for a
// typical test-log / coverage-summary and small enough to keep task rows healthy.
// Larger payloads must be uploaded externally and referenced via `url`.
const ARTIFACT_MAX_BYTES = 1_048_576;

// Per-task aggregate caps — prevent runaway agent loops from filling the DB.
// Both env vars accept a positive integer; invalid / missing values fall back
// to the defaults. Per-project overrides (project.artifactCountCap and
// project.artifactBytesCap) take precedence over these module-level defaults.
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const ARTIFACT_MAX_COUNT_PER_TASK = parsePositiveInt(
  process.env.ARTIFACT_MAX_COUNT_PER_TASK,
  100,
);
const ARTIFACT_MAX_TOTAL_BYTES_PER_TASK = parsePositiveInt(
  process.env.ARTIFACT_MAX_TOTAL_BYTES_PER_TASK,
  52_428_800, // 50 MiB
);
const ATTACHMENT_MAX_COUNT_PER_TASK = parsePositiveInt(
  process.env.ATTACHMENT_MAX_COUNT_PER_TASK,
  20,
);
const ATTACHMENT_MAX_TOTAL_BYTES_PER_TASK = parsePositiveInt(
  process.env.ATTACHMENT_MAX_TOTAL_BYTES_PER_TASK,
  52_428_800, // 50 MiB
);

const createArtifactSchema = z
  .object({
    type: z.enum(ARTIFACT_TYPES),
    name: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    content: z.string().max(ARTIFACT_MAX_BYTES).optional(),
    // Cap URL length so a bogus multi-megabyte "url" string can't reach the DB.
    // 2048 matches the common browser cap for hyperlinks. httpUrl() allowlists
    // http(s): the artifact url is rendered as an <a href> in the UI, so a
    // javascript:/data: URL would be stored XSS (same class as the prUrl/attachment guards).
    url: httpUrl({ max: 2048 }).optional(),
    mimeType: z.string().max(255).optional(),
  })
  .refine((v) => Boolean(v.content) || Boolean(v.url), {
    message: "Either 'content' (inline payload) or 'url' (external pointer) must be provided",
    path: ["content"],
  });

// ── List tasks across all team-accessible projects ──────────────────────────
//
// Aggregation endpoint introduced 2026-05-03 to fix the home-page fan-out
// regression: the home dashboard previously made one HTTP request per
// project (`/projects/:id/tasks`), which after PR #217 added a third DB
// query to `hasProjectAccess` for per-project sharing grants meant a 40-
// project user incurred ~160 DB queries per home render, polled every 15s.
//
// Single-roundtrip alternative: server resolves accessible projects once,
// then issues a single `Task.findMany` keyed on `projectId IN (...)`. ACL
// is enforced at the project-resolution boundary; per-task access is
// implicitly correct because we only query within the resolved project
// set.
//
// Response shape co-locates the projects map so the client can decorate
// each task with its project name without a second roundtrip.
taskRouter.get("/teams/:teamId/tasks", async (c) => {
  const actor = c.get("actor") as Actor;
  const teamIdParam = c.req.param("teamId");

  const resolved = await resolveTeamId(actor, teamIdParam);
  if (!resolved.ok) {
    return c.json(resolveTeamIdErrorBody(resolved), resolved.status);
  }

  // Same access expansion as `/api/projects` (routes/projects.ts:80-118):
  // humans see team projects PLUS any project they have a per-project
  // grant on; agents stay team-scoped (their per-project access is
  // exercised through specific project IDs, not aggregations).
  const projects = await prisma.project.findMany({
    where:
      actor.type === "human"
        ? {
            OR: [
              { teamId: resolved.teamId },
              { projectMembers: { some: { userId: actor.userId } } },
            ],
          }
        : { teamId: resolved.teamId },
    // Stable order: matches /api/projects (createdAt desc) so callers
    // that pick projects[0] (e.g. home page boardHref CTA) see the same
    // first row across both endpoints.
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      teamId: true,
      name: true,
      slug: true,
    },
  });

  if (projects.length === 0) {
    return c.json({
      tasks: [],
      projects: [],
      counts: { open: 0, review: 0, done: 0, doneRecent: 0, doneOlder: 0, priority: 0, mine: 0, total: 0 },
      filteredTotal: 0,
    });
  }

  const projectIds = projects.map((p) => p.id);
  const where: Record<string, unknown> = { projectId: { in: projectIds } };

  const statusFilter = c.req.query("status");
  if (statusFilter) {
    const parsed = statusFilter.split(",").map((s) => s.trim()).filter(Boolean);
    if (parsed.length > 0) where.status = { in: parsed };
  }

  const labelFilter = c.req.query("labels");
  if (labelFilter) {
    const parsed = labelFilter.split(",").map((l) => l.trim()).filter(Boolean);
    if (parsed.length > 0) where.labels = { hasSome: parsed };
  }

  const priorityFilter = c.req.query("priority");
  if (priorityFilter) {
    const parsed = priorityFilter
      .split(",")
      .map((p) => p.trim().toUpperCase())
      .filter((p) => p === "LOW" || p === "MEDIUM" || p === "HIGH" || p === "CRITICAL");
    if (parsed.length > 0) where.priority = { in: parsed };
  }

  // Recency window for the done view (Recent ≤14d vs Older >14d), applied as
  // an updatedAt boundary so the /tasks done scope can page recent vs older
  // completions server-side instead of client-slicing a capped fetch. `all`
  // (or absent) leaves the window open. Mirrors DONE_RECENT_DAYS on the
  // frontend (lib/dashboardPrefs.ts).
  const RECENT_DONE_DAYS = 14;
  const recency = c.req.query("recency");
  if (recency === "recent" || recency === "older") {
    const boundary = new Date(Date.now() - RECENT_DONE_DAYS * 24 * 60 * 60 * 1000);
    where.updatedAt = recency === "recent" ? { gte: boundary } : { lt: boundary };
  }

  // Single-project narrowing — only honoured for a project the actor can
  // already see, so the filter never widens access.
  const projectIdParam = c.req.query("projectId");
  if (projectIdParam && projectIds.includes(projectIdParam)) {
    where.projectId = projectIdParam;
  }

  // "Mine" = tasks claimed by the calling actor. Keys on actor.userId so the
  // row filter agrees with the team-wide `mine` count below (which uses the
  // same field) for every actor type.
  if (c.req.query("mine") === "1") {
    where.claimedByUserId = actor.userId;
  }

  // Search across the human-meaningful string fields. Labels match exactly
  // (clicking a label chip); the rest are case-insensitive substrings.
  const q = c.req.query("q")?.trim();
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
      { externalRef: { contains: q, mode: "insensitive" } },
      { labels: { has: q } },
    ];
  }

  // Hard cap to keep the response bounded even if a caller forgets a sane
  // limit. 500 is enough to feed the dashboard widgets' 10-row preview
  // each; the per-status `counts` block below carries the true totals so
  // the widget badges don't drift when a team's task volume crosses the
  // page size.
  const DEFAULT_LIMIT = 500;
  const HARD_MAX_LIMIT = 1000;
  const limitParam = c.req.query("limit");
  const limit = (() => {
    const n = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(n, HARD_MAX_LIMIT);
  })();

  // Server-side pagination offset (the /tasks browser pages through the full
  // filtered set rather than slicing a single capped fetch client-side).
  const offsetParam = c.req.query("offset");
  const offset = (() => {
    const n = offsetParam ? parseInt(offsetParam, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();

  // Column sort for the /tasks browser; defaults to most-recently-updated.
  // `project` sorts on the related project name, the rest are task columns.
  // Unknown columns fall back to the default.
  const SORT_FIELDS: Record<string, string> = {
    title: "title",
    status: "status",
    due: "dueAt",
    updated: "updatedAt",
    priority: "priority",
  };
  const orderBy = (() => {
    const raw = c.req.query("sort");
    if (!raw) return { updatedAt: "desc" } as Record<string, unknown>;
    const [col, dirRaw] = raw.split(":");
    const dir = dirRaw === "asc" ? "asc" : "desc";
    if (col === "project") return { project: { name: dir } } as Record<string, unknown>;
    const field = SORT_FIELDS[col ?? ""];
    return (field ? { [field]: dir } : { updatedAt: "desc" }) as Record<string, unknown>;
  })();

  // Counts are computed over the team's full task set, independent of the
  // ?status / ?priority / ?labels filter (which only narrows the row
  // slice). The home dashboard widgets need the team-wide totals; if we
  // applied the filter here, a `?status=done` call would zero out every
  // other widget's badge.
  const countWhere = { projectId: { in: projectIds } } as const;

  const doneBoundary = new Date(Date.now() - RECENT_DONE_DAYS * 24 * 60 * 60 * 1000);

  const [tasks, filteredTotal, statusGroups, priorityCount, mineCount, doneRecent, doneOlder] =
    await Promise.all([
      prisma.task.findMany({
        where,
        include: taskListInclude,
        orderBy,
        skip: offset,
        take: limit,
      }),
      // Total rows matching the active filter (status/recency/search/…) —
      // drives server-side pagination so the page count is exact rather than
      // bounded by the row-fetch cap.
      prisma.task.count({ where }),
      prisma.task.groupBy({
        by: ["status"],
        where: countWhere,
        _count: { _all: true },
      }),
      prisma.task.count({
        where: {
          ...countWhere,
          priority: { in: ["HIGH", "CRITICAL"] },
          status: { not: "done" },
        },
      }),
      prisma.task.count({
        where: {
          ...countWhere,
          claimedByUserId: actor.userId,
          status: { not: "done" },
        },
      }),
      // Team-wide done split at the 14-day window, so the home "Recently
      // Done" widget can label its two links authoritatively instead of
      // deriving the counts from a client-side slice.
      prisma.task.count({
        where: { ...countWhere, status: "done", updatedAt: { gte: doneBoundary } },
      }),
      prisma.task.count({
        where: { ...countWhere, status: "done", updatedAt: { lt: doneBoundary } },
      }),
    ]);

  const byStatus: Record<string, number> = Object.fromEntries(
    statusGroups.map((g) => [g.status, g._count._all]),
  );
  const counts = {
    open: (byStatus.open ?? 0) + (byStatus.in_progress ?? 0),
    review: byStatus.review ?? 0,
    done: byStatus.done ?? 0,
    doneRecent,
    doneOlder,
    priority: priorityCount,
    mine: mineCount,
    total: statusGroups.reduce((s, g) => s + g._count._all, 0),
  };

  const projectsAnnotated = projects.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    accessSource:
      actor.type === "human" && p.teamId !== resolved.teamId
        ? ("project" as const)
        : ("team" as const),
  }));

  return c.json({ tasks, projects: projectsAnnotated, counts, filteredTotal });
});

// ── List tasks for a project ─────────────────────────────────────────────────

// Project-scoped task browser. Accepts CSV filters for status, priority,
// labels, plus `unclaimed` and `limit` for the browse case (CLI `tasks list
// --project`, MCP `project_tasks`). When `limit` is omitted the route stays
// unbounded so the frontend dashboard (which fetches every project task
// without query params) keeps working; when supplied, limit is clamped to a
// 500 ceiling.
const PROJECT_TASK_STATUSES = ["open", "in_progress", "review", "done", "abandoned"] as const;
const PROJECT_TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

taskRouter.get("/projects/:projectId/tasks", async (c) => {
  const actor = c.get("actor") as Actor;
  const projectId = c.req.param("projectId");

  if (!(await hasProjectAccess(actor, projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const externalRefFilter = c.req.query("externalRef");
  const detail = c.req.query("detail");

  const statuses = parseCsv(c.req.query("status"));
  const invalidStatus = statuses.find(
    (s) => !PROJECT_TASK_STATUSES.includes(s as (typeof PROJECT_TASK_STATUSES)[number]),
  );
  if (invalidStatus) {
    return c.json(
      {
        error: "bad_request",
        message: `Invalid status '${invalidStatus}'. Expected one of: ${PROJECT_TASK_STATUSES.join(", ")}`,
      },
      400,
    );
  }

  const priorities = parseCsv(c.req.query("priority"));
  const invalidPriority = priorities.find(
    (p) => !PROJECT_TASK_PRIORITIES.includes(p as (typeof PROJECT_TASK_PRIORITIES)[number]),
  );
  if (invalidPriority) {
    return c.json(
      {
        error: "bad_request",
        message: `Invalid priority '${invalidPriority}'. Expected one of: ${PROJECT_TASK_PRIORITIES.join(", ")}`,
      },
      400,
    );
  }

  const labels = parseCsv(c.req.query("labels"));
  const unclaimed = c.req.query("unclaimed") === "true";

  const rawLimit = c.req.query("limit");
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return c.json(
        { error: "bad_request", message: "limit must be a positive integer" },
        400,
      );
    }
    limit = Math.min(parsed, 500);
  }

  const where: Record<string, unknown> = { projectId };
  if (labels.length > 0) {
    where.labels = { hasSome: labels };
  }
  if (externalRefFilter && externalRefFilter.length <= 255) {
    where.externalRef = externalRefFilter;
  }
  if (statuses.length > 0) {
    where.status = { in: statuses };
  }
  if (priorities.length > 0) {
    where.priority = { in: priorities };
  }
  if (unclaimed) {
    // Unclaimed === no active claim by either actor type. Matches the way
    // `tasks pickup` decides whether a task is up for grabs.
    where.claimedByAgentId = null;
    where.claimedByUserId = null;
  }

  const tasks = await prisma.task.findMany({
    where,
    include: detail === "full" ? taskInclude : taskListInclude,
    orderBy: { createdAt: "desc" },
    ...(limit !== undefined ? { take: limit } : {}),
  });
  return c.json({ tasks });
});

// ── Create task ───────────────────────────────────────────────────────────────

taskRouter.post(
  "/projects/:projectId/tasks",
  zValidator("json", createTaskSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;
    const projectId = c.req.param("projectId");
    const body = c.req.valid("json");

    if (!(await hasProjectAccess(actor, projectId))) {
      return forbidden(c, "Access denied to this project");
    }

    // Agents need tasks:create scope
    if (actor.type === "agent" && !actor.scopes.includes("tasks:create")) {
      return forbidden(c, "Missing scope: tasks:create");
    }

    // Creating a task is a write. PROJECT_VIEWER is read-only and must not
    // create tasks. Agents are scope-gated above (tasks:create).
    if (!(await requireProjectWrite(actor, projectId))) {
      return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
    }

    // Validate dependsOn before create: every blocker must exist in the same
    // project. A new task has no incoming edges yet, so no cycle is possible.
    if (body.dependsOn && body.dependsOn.length > 0) {
      const unique = Array.from(new Set(body.dependsOn));
      const blockers = await prisma.task.findMany({
        where: { id: { in: unique }, projectId },
        select: { id: true },
      });
      if (blockers.length !== unique.length) {
        const found = new Set(blockers.map((b) => b.id));
        const missing = unique.filter((id) => !found.has(id));
        return c.json(
          {
            error: "bad_request",
            message: "One or more dependsOn task IDs are missing or not in this project",
            missing,
          },
          400,
        );
      }
    }

    let task;
    try {
      task = await prisma.task.create({
        data: {
          projectId,
          title: body.title,
          description: body.description,
          ...(body.status !== undefined ? { status: body.status } : {}),
          priority: body.priority,
          workflowId: body.workflowId,
          dueAt: body.dueAt ? new Date(body.dueAt) : null,
          ...(body.templateData !== undefined ? { templateData: body.templateData } : {}),
          ...(body.externalRef !== undefined ? { externalRef: body.externalRef } : {}),
          ...(body.labels !== undefined ? { labels: body.labels } : {}),
          // An explicit debugFlavor opt-in/out is persisted into metadata at
          // create time. deriveDebugFlavor at task_pickup treats a pre-set
          // metadata.debugFlavor as authoritative (its isFresh branch), so
          // this skips the title/label heuristic.
          ...(body.debugFlavor !== undefined
            ? { metadata: { debugFlavor: body.debugFlavor } satisfies TaskMetadata }
            : {}),
          ...(body.dependsOn && body.dependsOn.length > 0
            ? { blockedBy: { connect: Array.from(new Set(body.dependsOn)).map((id) => ({ id })) } }
            : {}),
          ...(body.deliverableRepo !== undefined ? { deliverableRepo: body.deliverableRepo } : {}),
          createdByUserId: actor.type === "human" ? actor.userId : null,
          createdByAgentId: actor.type === "agent" ? actor.tokenId : null,
        },
        include: taskInclude,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return conflict(c, `A task with externalRef "${body.externalRef}" already exists in this project`);
      }
      throw e;
    }

    // Emit task_available signal when task is open (claimable)
    const effectiveStatus = body.status ?? "open";
    if (effectiveStatus === "open") {
      const actorName = actor.type === "agent"
        ? (await prisma.agentToken.findUnique({ where: { id: actor.tokenId }, select: { name: true } }))?.name ?? "Agent"
        : (await prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))?.name ?? "Human";
      void emitTaskAvailableSignal(task.id, projectId, actor.type, actorName);
    }

    // Audit the cross-repo override — only when actually set (create-time
    // absence is the common case and would drown the log).
    if (body.deliverableRepo) {
      void logAuditEvent({
        action: "task.deliverable_repo_set",
        actorId: actor.type === "human" ? actor.userId : undefined,
        projectId,
        taskId: task.id,
        payload: { deliverableRepo: body.deliverableRepo, actorType: actor.type, via: "create" },
      });
    }

    // Create-time confidence surfacing (scorer-v2 T4). INFORMATIONAL only — a low
    // score never blocks creation; the hard block stays at task_pickup/task_start.
    // Reuses the same calculateConfidence + deriveNextActions the pickup gate uses
    // (one source), so what's-missing is consistent everywhere. UI rendering of
    // these findings is a follow-up (task 1a925647): the dashboard create form
    // still drives a stale client-side scorer, so consuming the server findings
    // there is tied to syncing the frontend scorer (91e0df67).
    //
    // Confidence is best-effort and must NEVER be the reason a create fails — the
    // task is already persisted above. If the project lookup throws, degrade to
    // defaults (threshold 60, no template; calculateConfidence is template-
    // independent) rather than 500 a successful creation.
    let projectConf:
      | { confidenceThreshold: number; taskTemplate: unknown; enforcementMode: string | null }
      | null = null;
    try {
      projectConf = await prisma.project.findUnique({
        where: { id: projectId },
        select: { confidenceThreshold: true, taskTemplate: true, enforcementMode: true },
      });
    } catch {
      projectConf = null;
    }
    const tpl = projectConf?.taskTemplate as { fields?: TemplateFields } | null;
    const conf = calculateConfidence({
      title: task.title,
      description: task.description,
      templateData: task.templateData as TemplateData | null,
      templateFields: tpl?.fields ?? null,
    });
    const confidence = {
      score: conf.score,
      threshold: projectConf?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      // The effective mode tells the caller whether a `blocking` score will
      // actually be rejected at task_pickup/task_start (BLOCK) or is advisory
      // (OFF/WARN). Create stays informational regardless.
      enforcementMode: resolveEnforcementMode(projectConf ?? {}),
      blocking: conf.blocking,
      missing: conf.missing,
      findings: conf.findings,
      nextActions: deriveNextActions(conf.findings),
    };

    return c.json({ task, confidence }, 201);
  },
);

// ── Batch import tasks ──────────────────────────────────────────────────────

// Batch import deliberately drops `dependsOn`: the field references task IDs
// that the importer can't reasonably know up front, and the partial-failure
// semantics of import (per-row try/catch) don't compose cleanly with the
// "validate all blockers before any insert" rule of the single-create path.
// Set dependencies in a follow-up pass via /tasks/:id/dependencies.
const importTaskSchema = createTaskSchema.omit({ workflowId: true, dependsOn: true }).extend({
  description: z.string().max(50_000).optional(),
});

const batchImportSchema = z.object({
  tasks: z.array(importTaskSchema).min(1).max(200),
});

taskRouter.post(
  "/projects/:projectId/tasks/import",
  zValidator("json", batchImportSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;
    const projectId = c.req.param("projectId");
    const body = c.req.valid("json");

    if (!(await hasProjectAccess(actor, projectId))) {
      return forbidden(c, "Access denied to this project");
    }

    if (actor.type === "agent" && !actor.scopes.includes("tasks:create")) {
      return forbidden(c, "Missing scope: tasks:create");
    }

    // Batch import creates tasks: a write. PROJECT_VIEWER is read-only and
    // must not import tasks. Agents are scope-gated above (tasks:create).
    if (!(await requireProjectWrite(actor, projectId))) {
      return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
    }

    // Deduplicate within the batch itself (keep first occurrence)
    const seenRefs = new Set<string>();
    const dedupedItems: typeof body.tasks = [];
    const inBatchDupes: string[] = [];

    for (const item of body.tasks) {
      if (item.externalRef) {
        if (seenRefs.has(item.externalRef)) {
          inBatchDupes.push(item.externalRef);
          continue;
        }
        seenRefs.add(item.externalRef);
      }
      dedupedItems.push(item);
    }

    const created: Array<{ index: number; id: string }> = [];
    const skipped: string[] = [...inBatchDupes];
    const errors: Array<{ index: number; error: string }> = [];

    const actorName = actor.type === "agent"
      ? (await prisma.agentToken.findUnique({ where: { id: actor.tokenId }, select: { name: true } }))?.name ?? "Agent"
      : (await prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))?.name ?? "Human";

    for (let i = 0; i < dedupedItems.length; i++) {
      const item = dedupedItems[i];

      try {
        const task = await prisma.task.create({
          data: {
            projectId,
            title: item.title,
            description: item.description,
            ...(item.status !== undefined ? { status: item.status } : {}),
            priority: item.priority,
            dueAt: item.dueAt ? new Date(item.dueAt) : null,
            ...(item.externalRef !== undefined ? { externalRef: item.externalRef } : {}),
            ...(item.labels !== undefined ? { labels: item.labels } : {}),
            ...(item.templateData !== undefined ? { templateData: item.templateData } : {}),
            ...(item.debugFlavor !== undefined
              ? { metadata: { debugFlavor: item.debugFlavor } satisfies TaskMetadata }
              : {}),
            ...(item.deliverableRepo !== undefined ? { deliverableRepo: item.deliverableRepo } : {}),
            createdByUserId: actor.type === "human" ? actor.userId : null,
            createdByAgentId: actor.type === "agent" ? actor.tokenId : null,
          },
        });
        created.push({ index: i, id: task.id });

        // Emit signal so agents discover imported tasks
        const effectiveStatus = item.status ?? "open";
        if (effectiveStatus === "open") {
          void emitTaskAvailableSignal(task.id, projectId, actor.type, actorName);
        }

        // Audit log
        void logAuditEvent({
          projectId,
          taskId: task.id,
          actorId: actor.type === "human" ? actor.userId : undefined,
          action: "task.imported",
          payload: { externalRef: item.externalRef ?? null, source: "batch_import" },
        });
        if (item.deliverableRepo) {
          void logAuditEvent({
            action: "task.deliverable_repo_set",
            actorId: actor.type === "human" ? actor.userId : undefined,
            projectId,
            taskId: task.id,
            payload: { deliverableRepo: item.deliverableRepo, actorType: actor.type, via: "batch_import" },
          });
        }
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          skipped.push(item.externalRef ?? item.title);
        } else {
          errors.push({ index: i, error: "Internal error" });
        }
      }
    }

    const statusCode = created.length > 0 ? 201 : errors.length > 0 ? 422 : 200;

    return c.json({
      created: created.length,
      skipped: skipped.length,
      failed: errors.length,
      ids: created,
      skippedRefs: skipped,
      errors,
    }, statusCode);
  },
);

// ── List claimable tasks ─────────────────────────────────────────────────────
//
// Despite the URL, this endpoint doubles as the general task-search verb the
// MCP `tasks_list` tool dispatches to. With no query parameters it preserves
// the original behaviour (status=open, unclaimed, scoped to the actor's team
// or an explicit projectId). Pass `status` or `claimedByAgentId` to broaden
// the search across already-claimed/in-progress/done tasks.
//
// `verbose=false` (the default) returns a SUMMARY projection without the
// long-form `description`, `comments`, `attachments`, or `artifacts`. The
// untruncated description column dominates the byte budget of the full
// `taskInclude`, and the MCP harness saves any tool result over its token
// limit to a side file — defaulting to summary keeps the natural call shape
// inside the agent's context window. Set `verbose=true` to opt into the full
// response.

const CLAIMABLE_VALID_STATUSES = ["open", "in_progress", "review", "done", "abandoned"] as const;
const CLAIMABLE_VALID_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

const claimableSummarySelect = {
  id: true,
  projectId: true,
  title: true,
  status: true,
  priority: true,
  labels: true,
  claimedByAgentId: true,
  claimedByUserId: true,
  reviewClaimedByAgentId: true,
  reviewClaimedByUserId: true,
  branchName: true,
  prUrl: true,
  prNumber: true,
  dueAt: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, name: true, slug: true } },
} as const;

function parseCsvParam(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  const items = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

taskRouter.get("/tasks/claimable", async (c) => {
  const actor = c.get("actor") as Actor;
  const projectId = c.req.query("projectId");
  const teamIdQuery = c.req.query("teamId");
  const limitRaw = c.req.query("limit");
  const verboseRaw = c.req.query("verbose");
  const statusRaw = c.req.query("status");
  const priorityRaw = c.req.query("priority");
  const labelsRaw = c.req.query("labels");
  const claimedByAgentIdRaw = c.req.query("claimedByAgentId");

  const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 25;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 200 ? parsedLimit : 25;

  const verbose = verboseRaw === "true" || verboseRaw === "1";

  const statusList = parseCsvParam(statusRaw);
  if (statusList) {
    for (const s of statusList) {
      if (!(CLAIMABLE_VALID_STATUSES as readonly string[]).includes(s)) {
        return c.json(
          {
            error: "bad_request",
            message: `invalid status: ${s}; must be one of ${CLAIMABLE_VALID_STATUSES.join(", ")}`,
          },
          400,
        );
      }
    }
  }

  const priorityList = parseCsvParam(priorityRaw);
  if (priorityList) {
    for (const p of priorityList) {
      if (!(CLAIMABLE_VALID_PRIORITIES as readonly string[]).includes(p)) {
        return c.json(
          {
            error: "bad_request",
            message: `invalid priority: ${p}; must be one of ${CLAIMABLE_VALID_PRIORITIES.join(", ")}`,
          },
          400,
        );
      }
    }
  }

  const labelsList = parseCsvParam(labelsRaw);

  let claimedByAgentId: string | undefined;
  if (claimedByAgentIdRaw === "me") {
    if (actor.type !== "agent") {
      return c.json(
        {
          error: "bad_request",
          message: 'claimedByAgentId="me" is only supported for agent actors',
        },
        400,
      );
    }
    claimedByAgentId = actor.tokenId;
  } else if (claimedByAgentIdRaw) {
    claimedByAgentId = claimedByAgentIdRaw;
  }

  // The caller is doing an explicit search (rather than the legacy "what can
  // I claim right now?" call) once they pass `status` or `claimedByAgentId`.
  // In that mode we drop the implicit "status=open + null-claim" default so
  // already-claimed and in-progress/review/done tasks are reachable.
  //
  // Key on the *parsed* values so a stray empty query (`?claimedByAgentId=`,
  // `?status=`) does not flip the heuristic without actually narrowing the
  // search — that would broaden the response to every team task.
  const isExplicitSearch = statusList !== undefined || claimedByAgentId !== undefined;

  const where: Prisma.TaskWhereInput = {};

  if (isExplicitSearch) {
    if (statusList) {
      where.status = statusList.length === 1 ? statusList[0] : { in: statusList };
    }
    if (claimedByAgentId) {
      where.claimedByAgentId = claimedByAgentId;
    }
  } else {
    where.status = "open";
    where.claimedByUserId = null;
    where.claimedByAgentId = null;
  }

  if (priorityList) {
    // Values are validated against CLAIMABLE_VALID_PRIORITIES above, so this
    // narrow type cast is safe at runtime.
    const priorities = priorityList as ("LOW" | "MEDIUM" | "HIGH" | "CRITICAL")[];
    where.priority = priorities.length === 1 ? priorities[0] : { in: priorities };
  }
  if (labelsList) {
    where.labels = { hasEvery: labelsList };
  }

  if (projectId) {
    if (!(await hasProjectAccess(actor, projectId))) {
      return forbidden(c, "Access denied to this project");
    }
    where.projectId = projectId;
  } else {
    // No projectId → scope by team. resolveTeamId handles agent (implicit from
    // token), human with explicit teamId (membership-checked), and human with
    // no teamId (defaults to sole membership; 400 if ambiguous).
    const resolved = await resolveTeamId(actor, teamIdQuery);
    if (!resolved.ok) {
      return c.json(
        resolveTeamIdErrorBody(resolved),
        resolved.status,
      );
    }
    where.project = { teamId: resolved.teamId };
  }

  const tasks = verbose
    ? await prisma.task.findMany({
        where,
        orderBy: { createdAt: "asc" },
        take: limit,
        include: {
          ...taskInclude,
          project: { select: { id: true, name: true, slug: true } },
        },
      })
    : await prisma.task.findMany({
        where,
        orderBy: { createdAt: "asc" },
        take: limit,
        select: claimableSummarySelect,
      });

  return c.json({ tasks });
});

// Best-effort attempt to recover Phase 2 session fields from previously
// persisted `groundingSessionState`. The wrapper's session shape uses
// snake_case (id / current_phase / mandatory_sequence / active_guardrails).
// If the stored blob doesn't match that shape we return null and the
// caller falls back to the Phase 1 advisory hint.
function reconstructSessionFromMetadata(
  meta: TaskMetadata,
): GroundingStartResult | null {
  if (!meta.groundingSessionId) return null;
  const state = meta.groundingSessionState;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const s = state as Record<string, unknown>;
    const currentPhase = typeof s.current_phase === "string" ? s.current_phase : null;
    const mandatorySequence = Array.isArray(s.mandatory_sequence)
      ? s.mandatory_sequence.filter((v): v is string => typeof v === "string")
      : null;
    const activeGuardrails = Array.isArray(s.active_guardrails)
      ? s.active_guardrails.filter((v): v is string => typeof v === "string")
      : null;
    if (currentPhase && mandatorySequence && activeGuardrails) {
      return {
        sessionId: meta.groundingSessionId,
        currentPhase,
        mandatorySequence,
        activeGuardrails,
        sessionState: state,
      };
    }
  }
  return null;
}

// Derive the debug-flavor for a task. No DB write; callers persist
// `mergedMetadata` either via a dedicated update (pickup) or by folding it
// into the same update they were already going to issue (start).
//
// `isFresh` distinguishes "we just classified this task" from "the flag was
// already set" so callers can skip the metadata write on subsequent calls.
//
// Phase 2: when an optional `client` is provided AND this is a fresh
// debug-flavored task, the function calls `client.start(...)` to spin up a
// grounding session. The session fields land in `mergedMetadata` (so a
// future request reconstructs the same hint) and on the returned
// `groundingHint`. Any failure (client returns null, throws, etc.) collapses
// to the Phase 1 advisory hint without blocking pickup.
async function deriveDebugFlavor<T extends {
  id: string;
  title: string;
  description: string | null;
  labels: string[] | null;
  metadata: unknown;
  project: { slug: string };
}>(
  task: T,
  client?: GroundingClient,
  forceReclassify?: boolean,
): Promise<{
  debugFlavor: boolean;
  isFresh: boolean;
  // True only when forceReclassify=true AND the persisted debugFlavor value
  // was already set AND the classifier produces a different result. Callers
  // use this to emit the task.debugFlavor.reclassified audit event.
  reclassified: boolean;
  mergedMetadata: TaskMetadata;
  groundingHint: GroundingHint | null;
}> {
  const meta = readMetadata(task.metadata);
  const isFresh = meta.debugFlavor === undefined;
  // When forceReclassify=true we re-run the classifier regardless of whether
  // the flag was already persisted, bypassing the isFresh guard.
  const debugFlavor = isFresh || forceReclassify
    ? detectDebugFlavor({
        title: task.title,
        description: task.description,
        labels: task.labels,
      })
    : meta.debugFlavor === true;

  // reclassified: the persisted value was defined, the caller requested a
  // re-run, and the result is different from what was stored.
  const reclassified = !isFresh && forceReclassify === true && meta.debugFlavor !== debugFlavor;

  const mergedMetadata: TaskMetadata = { ...meta, debugFlavor };
  // When the flag flips from true → false under a forced reclassification,
  // the grounding session state is no longer relevant — clear it.
  if (reclassified && !debugFlavor) {
    delete mergedMetadata.groundingSessionState;
    delete mergedMetadata.groundingSessionId;
  }

  if (!debugFlavor) {
    return { debugFlavor, isFresh, reclassified, mergedMetadata, groundingHint: null };
  }

  // Idempotent path: a session was already started on a prior request.
  // Reconstruct the hint from the persisted state if possible, else fall
  // back to the advisory hint. Either way: no second client.start call.
  if (meta.groundingSessionId !== undefined) {
    const reconstructed = reconstructSessionFromMetadata(meta);
    if (reconstructed) {
      return {
        debugFlavor,
        isFresh,
        reclassified,
        mergedMetadata,
        groundingHint: buildGroundingHintWithSession(task, reconstructed),
      };
    }
    return {
      debugFlavor,
      isFresh,
      reclassified,
      mergedMetadata,
      groundingHint: buildGroundingHint(task),
    };
  }

  // Fresh debug-flavored task, no stored session: try to start one.
  if (client) {
    const session = await client.start({
      keyword: task.project.slug,
      problem: task.title,
      taskId: task.id,
      projectSlug: task.project.slug,
    });
    if (session) {
      mergedMetadata.groundingSessionId = session.sessionId;
      mergedMetadata.groundingSessionState = session.sessionState;
      return {
        debugFlavor,
        isFresh,
        reclassified,
        mergedMetadata,
        groundingHint: buildGroundingHintWithSession(task, session),
      };
    }
  }

  // No client provided, or client returned null: Phase 1 advisory hint.
  return {
    debugFlavor,
    isFresh,
    reclassified,
    mergedMetadata,
    groundingHint: buildGroundingHint(task),
  };
}

// ── Agent pickup (v2 MCP) ────────────────────────────────────────────────────
//
// Single "what should I do next?" endpoint for the v2 MCP surface. Resolution:
//   1. Pending signals for this agent → return the oldest, ack it atomically
//   2. Tasks in status `review` with a free review-claim, author != this agent
//   3. Claimable tasks in status `open`, not blocked, in authorized projects
//   4. Nothing → idle
//
// Hard-limit: agents with an active author-claim OR review-claim are rejected
// upfront. Parallelism is achieved by using multiple agent identities.
//
// See ADR 0008.

taskRouter.post("/tasks/pickup", async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type === "agent" && !actor.scopes.includes("tasks:read")) {
    return forbidden(c, "Missing scope: tasks:read");
  }

  // Hard-limit: reject if the agent already holds any active claim
  if (actor.type === "agent") {
    const existing = await prisma.task.findFirst({
      where: {
        OR: [
          { claimedByAgentId: actor.tokenId, status: { not: "done" } }, // TODO: use terminalStates across team workflows
          { reviewClaimedByAgentId: actor.tokenId, status: "review" }, // TODO: use reviewStates across team workflows
        ],
      },
      select: { id: true, title: true, claimedByAgentId: true, reviewClaimedByAgentId: true },
    });
    if (existing) {
      const role = existing.reviewClaimedByAgentId === actor.tokenId ? "reviewer" : "author";
      return c.json(
        {
          error: "already_claimed",
          message:
            "You already hold an active claim. Call task_finish or task_abandon on it before picking up new work.",
          activeClaim: { taskId: existing.id, title: existing.title, role },
        },
        409,
      );
    }
  }

  // ── 1. Signals ────────────────────────────────────────────────────────────
  // Defense-in-depth: only `review_needed` / `task_available` / `task_assigned`
  // become stale when the task lands on `done` — those ask the recipient to
  // DO something ("pick this up", "review this") that no longer applies.
  // `task_approved`, `changes_requested`, `task_force_transitioned` are
  // *outcome notifications* emitted against tasks that are already terminal
  // by design; they must survive to reach the claimant's queue.
  const signal = await prisma.signal.findFirst({
    where: {
      acknowledgedAt: null,
      OR: [
        { type: { notIn: STALE_WHEN_DONE } },
        { task: { status: { not: "done" } } },
      ],
      ...(actor.type === "agent"
        ? { recipientAgentId: actor.tokenId }
        : { recipientUserId: actor.userId }),
    },
    orderBy: { createdAt: "asc" },
  });
  if (signal) {
    // Immediate ack: the signal is delivered as part of this response. If the
    // agent crashes between receiving and acting on it, the operator must
    // resend — at-most-once is acceptable here.
    await prisma.signal.update({
      where: { id: signal.id },
      data: { acknowledgedAt: new Date() },
    });
    return c.json({ kind: "signal", signal });
  }

  // Team scope for both review and work lookups
  const teamFilter =
    actor.type === "agent"
      ? { project: { teamId: actor.teamId } }
      : undefined;

  // For humans hitting this endpoint directly without a teamId we can't
  // resolve a scope — agents are the primary audience, humans should use the
  // REST list endpoints. Reject the human fallback for now.
  if (actor.type !== "agent") {
    return c.json(
      { error: "bad_request", message: "task_pickup is agent-only; use /tasks/claimable for human flows" },
      400,
    );
  }

  // ── 2. Review pickup ──────────────────────────────────────────────────────
  // Distinct-reviewer: the agent must not be the author of the task.
  const reviewTask = await prisma.task.findFirst({
    where: {
      status: "review", // TODO: use reviewStates across team workflows — misses non-default review states
      reviewClaimedByAgentId: null,
      reviewClaimedByUserId: null,
      createdByAgentId: { not: actor.tokenId },
      ...teamFilter,
      blockedBy: { none: { status: { not: "done" } } },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    include: {
      ...taskInclude,
      project: { select: { id: true, name: true, slug: true } },
    },
  });
  if (reviewTask) {
    return c.json({ kind: "review", task: reviewTask });
  }

  // ── 3. Work pickup ────────────────────────────────────────────────────────
  const workTask = await prisma.task.findFirst({
    where: {
      status: "open", // TODO: use initial states across team workflows — misses coding-agent "backlog" tasks
      claimedByAgentId: null,
      claimedByUserId: null,
      ...teamFilter,
      blockedBy: { none: { status: { not: "done" } } },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    include: {
      ...taskInclude,
      project: { select: { id: true, name: true, slug: true } },
    },
  });
  if (workTask) {
    // ?reclassify=true opt-in: re-run the classifier regardless of whether
    // debugFlavor is already persisted and write the result unconditionally.
    const reclassify = c.req.query("reclassify") === "true";
    const { isFresh, reclassified, mergedMetadata, groundingHint } = await deriveDebugFlavor(
      workTask,
      getGroundingClient(),
      reclassify,
    );
    if (isFresh || reclassify) {
      await prisma.task.update({
        where: { id: workTask.id },
        data: { metadata: mergedMetadata as Prisma.InputJsonValue },
      });
    }
    if (reclassified) {
      void logAuditEvent({
        action: "task.debugFlavor.reclassified",
        projectId: workTask.projectId,
        taskId: workTask.id,
        payload: {
          via: "task_pickup",
          debugFlavor: mergedMetadata.debugFlavor,
        },
      });
    }
    return c.json({
      kind: "work",
      task: { ...workTask, metadata: mergedMetadata },
      ...(groundingHint ? { groundingHint } : {}),
    });
  }

  // ── 4. Idle ───────────────────────────────────────────────────────────────
  return c.json({ kind: "idle" });
});

// ── Agent start (v2 MCP) ─────────────────────────────────────────────────────
//
// Polymorphic "begin work on this task" endpoint. The behavior depends on
// the task's current status:
//
//   status=open     → author-claim the task, transition to `in_progress`,
//                     return full context (task, description, templateData,
//                     expectedFinishState, workflow hints).
//   status=review   → review-claim the task (no status change), return the
//                     same context plus review-specific hints.
//
// Hard-limit enforced: agents with an existing active claim are rejected.
// Distinct-reviewer rule applies to the review case: an agent cannot review
// a task it authored.
//
// See ADR 0008.

taskRouter.post("/tasks/:id/start", async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type === "agent") {
    if (!actor.scopes.includes("tasks:claim") || !actor.scopes.includes("tasks:transition")) {
      return forbidden(c, "Missing scope: tasks:claim, tasks:transition");
    }
  }

  // Optional body. The historic no-body form (`POST` with nothing) is
  // preserved by the `catch(() => ({}))` fallback. When `branchName` is
  // supplied, it is folded into the open→in_progress branch below so the
  // `branchPresent` gate sees it and the same atomic Prisma write that
  // claims the task also persists the branch.
  const rawStartBody = await c.req.json().catch(() => ({}));
  const startBody = startTaskSchema.safeParse(rawStartBody);
  if (!startBody.success) {
    return c.json({ error: "bad_request", message: startBody.error.message }, 400);
  }
  const providedBranchName = startBody.data.branchName;
  const reclassify = startBody.data.reclassify === true;

  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    include: {
      workflow: true,
      project: {
        select: {
          id: true,
          name: true,
          slug: true,
          teamId: true,
          githubRepo: true,
          confidenceThreshold: true,
          taskTemplate: true,
          enforcementMode: true,
          soloMode: true,
          requireDistinctReviewer: true,
        },
      },
      ...taskInclude,
    },
  });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  // Starting a task claims it and advances status: a write. PROJECT_VIEWER is
  // read-only and must not start tasks. Agents are scope-gated above.
  if (!(await requireProjectWrite(actor, task.projectId))) {
    return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
  }

  // Hard-limit: reject if the agent already holds any active claim. Humans
  // are exempt — they may manage multiple tasks through the web UI.
  if (actor.type === "agent") {
    const existing = await prisma.task.findFirst({
      where: {
        id: { not: task.id },
        OR: [
          { claimedByAgentId: actor.tokenId, status: { not: "done" } },
          { reviewClaimedByAgentId: actor.tokenId, status: "review" },
        ],
      },
      select: { id: true, title: true, claimedByAgentId: true, reviewClaimedByAgentId: true },
    });
    if (existing) {
      const role = existing.reviewClaimedByAgentId === actor.tokenId ? "reviewer" : "author";
      return c.json(
        {
          error: "already_claimed",
          message:
            "You already hold an active claim. Call task_finish or task_abandon on it before starting another.",
          activeClaim: { taskId: existing.id, title: existing.title, role },
        },
        409,
      );
    }
  }

  // Resolve the workflow definition once so both branches can compute the
  // expected finish state.
  const effectiveDefinition = await resolveEffectiveDefinition(task, prisma);
  const expectedFinishState = expectedFinishStateFromDefinition(effectiveDefinition);

  // ── Branch: status=open → author-claim + transition ──────────────────────
  if (isInitialState(effectiveDefinition, task.status)) {
    if (task.claimedByUserId || task.claimedByAgentId) {
      return conflict(c, "Task is already claimed");
    }

    // Dependency gate
    const blockers = await prisma.task.findMany({
      where: { blocks: { some: { id: task.id } } },
      select: { id: true, title: true, status: true },
    });
    const unresolved = blockers.filter((dep) => dep.status !== "done");
    if (unresolved.length > 0) {
      return c.json(
        {
          error: "blocked",
          message: "Task is blocked by unresolved dependencies",
          blockedBy: unresolved,
        },
        409,
      );
    }

    // Confidence gate (ADR-0011). Emits audit events on block / override,
    // validates force=true requires forceReason (>=10 chars).
    const gate = await evaluateConfidenceGate(c, task, actor, "start");
    if (!gate.ok) return gate.response;

    // Transition-rule gates (branchPresent / prPresent / ciGreen / prMerged).
    // Mirrors the b459be3 fix for task_finish. Before this change, task_start
    // silently bypassed any gate configured on the `open → in_progress`
    // transition; every custom workflow with gates on that edge had them
    // no-op'd. Now parity with `/transition`. The default workflow has no
    // gates on this edge (see default-workflow.ts — `branchPresent` was
    // removed from the start edge in this same change to avoid a structural
    // self-checkmate), so default-workflow projects pass cleanly.
    const startTarget = firstTransitionTarget(effectiveDefinition, effectiveDefinition.initialState);
    if (!startTarget) {
      return c.json(
        { error: "bad_state", message: `No transition defined from initial state '${effectiveDefinition.initialState}'` },
        409,
      );
    }

    // If the caller supplied a branchName AND the task has none, fold it
    // into the gate input so a `branchPresent` precondition passes on the
    // same call that claims the task. The actual DB write happens in the
    // taskUpdate below, atomically with the claim — so a failed gate does
    // NOT leave a stranded branchName on the task.
    //
    // If the task already has a branchName, the supplied value is ignored
    // (idempotent). Overwriting silently would destroy a pre-existing
    // value; rejecting with 409 would surprise callers that don't track
    // whether the field was already set. Same-value re-calls stay safe.
    const effectiveBranchName = task.branchName ?? providedBranchName ?? null;
    const willPersistBranchName =
      providedBranchName !== undefined && task.branchName === null;

    const gateResult = await evaluateV2TransitionGates(
      task,
      { branchName: effectiveBranchName, prUrl: task.prUrl, prNumber: task.prNumber },
      startTarget,
      actor,
      effectiveDefinition,
    );
    if (!gateResult.ok) {
      if (gateResult.kind === "no_transition") {
        return c.json({ error: "bad_request", message: gateResult.message }, 400);
      }
      if (gateResult.kind === "forbidden_role") {
        return forbidden(c, `Requires role: ${gateResult.requiredRole}`);
      }
      if (gateResult.kind === "precondition") {
        const { failed, ruleErrors } = gateResult;
        return c.json(
          {
            error: "precondition_failed",
            message: `Transition blocked — ${failed
              .map((r) => (ruleErrors[r] ? `${RULE_MESSAGES[r]} (${ruleErrors[r]})` : RULE_MESSAGES[r]))
              .join(" ")}`,
            failed: failed.map((r) => ({
              rule: r,
              message: RULE_MESSAGES[r],
              ...(ruleErrors[r] ? { error: ruleErrors[r] } : {}),
            })),
            canForce: false,
          },
          422,
        );
      }
      const _exhaustive: never = gateResult;
      return _exhaustive;
    }

    const flavor = await deriveDebugFlavor(task, getGroundingClient(), reclassify);
    // Atomic compare-and-swap: only claim if the row is still unclaimed. The
    // `task.claimedBy*` null-check above is a fast path, but two actors can
    // both pass it before either writes (TOCTOU). Guarding on
    // `claimedBy* IS NULL` makes exactly one writer win; the loser sees
    // count===0 and gets a 409.
    const claimResult = await prisma.task.updateMany({
      where: { id: task.id, claimedByUserId: null, claimedByAgentId: null },
      data: {
        claimedByUserId: actor.type === "human" ? actor.userId : null,
        claimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
        claimedAt: new Date(),
        status: startTarget,
        ...(willPersistBranchName ? { branchName: providedBranchName } : {}),
        // Include metadata when it is fresh (first classification) OR when the
        // caller requested a forced reclassification (reclassify=true).
        ...(flavor.isFresh || reclassify
          ? { metadata: flavor.mergedMetadata as Prisma.InputJsonValue }
          : {}),
      },
    });
    if (claimResult.count === 0) {
      return conflict(c, "Task is already claimed");
    }

    // updateMany cannot use `include`, so re-fetch the freshly claimed row.
    const updated = await prisma.task.findUnique({
      where: { id: task.id },
      include: taskInclude,
    });
    if (!updated) return notFound(c);

    void logAuditEvent({
      action: "task.claimed",
      actorId: actor.type === "human" ? actor.userId : undefined,
      projectId: task.projectId,
      taskId: task.id,
      payload: {
        actorType: actor.type,
        actorId: actor.type === "agent" ? actor.tokenId : actor.userId,
        via: "task_start",
        // Forensic signal: distinguishes "branch was already set" from
        // "branch was folded into this call". For branchPresent-gated
        // projects, post-incident review needs to know which path won.
        ...(willPersistBranchName ? { foldedBranchName: providedBranchName } : {}),
      },
    });
    if (flavor.reclassified) {
      void logAuditEvent({
        action: "task.debugFlavor.reclassified",
        projectId: task.projectId,
        taskId: task.id,
        payload: {
          via: "task_start",
          debugFlavor: flavor.mergedMetadata.debugFlavor,
        },
      });
    }

    return c.json({
      kind: "work",
      task: { ...updated, metadata: flavor.mergedMetadata },
      expectedFinishState,
      project: task.project,
      ...(flavor.groundingHint ? { groundingHint: flavor.groundingHint } : {}),
    });
  }

  // ── Branch: status=review → review-claim ────────────────────────────────
  //
  // `providedBranchName` from the request body is intentionally NOT in
  // scope on the review path. It is only declared inside the open-state
  // branch above. The MCP tool description for task_start documents this
  // contract (review-claim starts accept but ignore the field) so the
  // test at "ignores branchName on a review-claim start" pins it.
  if (isReviewState(effectiveDefinition, task.status)) {
    // Distinct-reviewer: bypassed in soloMode and when the project opts out
    // of requireDistinctReviewer. Same flag-aware gate the review-finish
    // and PATCH paths use, so policy stays consistent across endpoints.
    const gate = checkDistinctReviewerGate(task, actor, task.project);
    if (!gate.allowed) {
      return forbidden(c, "Cannot review your own task");
    }

    const isCurrentReviewer =
      (actor.type === "human" && task.reviewClaimedByUserId === actor.userId) ||
      (actor.type === "agent" && task.reviewClaimedByAgentId === actor.tokenId);

    if ((task.reviewClaimedByUserId || task.reviewClaimedByAgentId) && !isCurrentReviewer) {
      return conflict(c, "Task is already being reviewed by another reviewer");
    }

    let updated = task;
    if (!isCurrentReviewer) {
      // Atomic compare-and-swap: only acquire the lock if it is still free.
      // The null-check above is a fast path; two reviewers can both pass it
      // before either writes (TOCTOU). Guarding on `reviewClaimedBy* IS NULL`
      // makes exactly one writer win; the loser sees count===0 and gets a 409.
      const claimResult = await prisma.task.updateMany({
        where: { id: task.id, reviewClaimedByUserId: null, reviewClaimedByAgentId: null },
        data: {
          reviewClaimedByUserId: actor.type === "human" ? actor.userId : null,
          reviewClaimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
          reviewClaimedAt: new Date(),
        },
      });
      if (claimResult.count === 0) {
        return conflict(c, "Task is already being reviewed by another reviewer");
      }

      // updateMany cannot use `include`, so re-fetch the freshly claimed row.
      const refetched = await prisma.task.findUnique({
        where: { id: task.id },
        include: {
          workflow: true,
          project: {
            select: {
              id: true,
              name: true,
              slug: true,
              teamId: true,
              githubRepo: true,
              confidenceThreshold: true,
              taskTemplate: true,
              enforcementMode: true,
              soloMode: true,
              requireDistinctReviewer: true,
            },
          },
          ...taskInclude,
        },
      });
      if (!refetched) return notFound(c);
      updated = refetched;

      void logAuditEvent({
        action: "task.reviewed",
        actorId: actor.type === "human" ? actor.userId : undefined,
        projectId: task.projectId,
        taskId: task.id,
        payload: {
          event: "review_claimed",
          actorType: actor.type,
          reviewerId: actor.type === "human" ? actor.userId : actor.tokenId,
          via: "task_start",
        },
      });
    }

    return c.json({
      kind: "review",
      task: updated,
      expectedFinishState: expectedFinishStateFromDefinition(effectiveDefinition),
      project: task.project,
    });
  }

  return c.json(
    {
      error: "bad_state",
      message: `Task in '${task.status}' cannot be started — must be in initial state ('${effectiveDefinition.initialState}') or a review state`,
    },
    409,
  );
});

// ── Agent finish (v2 MCP) ────────────────────────────────────────────────────
//
// Polymorphic "finish" endpoint. Behavior depends on which claim the caller
// holds on the task:
//
//   Work claim (status=in_progress):
//     Body: { result?, prUrl? }
//     - Validates prUrl format when present, stores url + number
//     - Transitions to expectedFinishState (review or done) derived from the
//       task's workflow definition
//     - Clears the work claim when the target state is `done`. Keeps the
//       work claim set when the target is `review` so the author is still
//       "on the hook" for the task until the reviewer decides.
//
//   Review claim (status=review):
//     Body: { result?, outcome: "approve" | "request_changes" }
//     - approve → transition to done, clear both claims
//     - request_changes → transition back to in_progress, clear review
//       claim only, leave the work claim in place, emit a signal to the
//       original author
//
// See ADR 0008.

const finishWorkSchema = z.object({
  result: z.string().max(5000).optional(),
  prUrl: z
    .string()
    .regex(
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/,
      "prUrl must be a github.com pull request URL",
    )
    .optional(),
  autoMerge: z.boolean().optional(),
  mergeMethod: z.enum(["squash", "merge", "rebase"]).optional().default("squash"),
});

const finishReviewSchema = z
  .object({
    result: z.string().max(5000).optional(),
    outcome: z.enum(["approve", "request_changes"]),
    autoMerge: z.boolean().optional(),
    mergeMethod: z.enum(["squash", "merge", "rebase"]).optional().default("squash"),
  })
  .refine(
    (data) => !(data.outcome === "request_changes" && data.autoMerge),
    { message: "autoMerge is not allowed with outcome 'request_changes'" },
  );

// POST /tasks/:id/submit-pr — v2 verb for writing branch + PR metadata on a
// work-claimed task. Not a transition. Not tied to a specific status. Exists
// because v2 task_finish only accepts prUrl/prNumber, not branchName, which
// makes projects that enforce the `branchPresent` gate unsatisfiable without
// falling back to the deprecated v1 tasks_update path. Agents call this after
// `gh pr create`, then proceed to task_finish.
const submitPrSchema = z.object({
  branchName: z
    .string()
    .trim()
    .min(1, "branchName must not be empty")
    .max(255, "branchName must be at most 255 characters"),
  prUrl: z
    .string()
    .regex(
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/,
      "prUrl must be a github.com pull request URL",
    ),
  prNumber: z.number().int().positive(),
});

// Body shape for /tasks/:id/start. Empty body is valid (the historic
// no-body form is still supported). When `branchName` is supplied AND
// the task has no branchName yet, the start handler writes it as part of
// the same atomic update that creates the claim, so the `branchPresent`
// gate sees the new value without a separate tasks_update round-trip.
const startTaskSchema = z.object({
  branchName: z
    .string()
    .trim()
    .min(1, "branchName must not be empty")
    .max(255, "branchName must be at most 255 characters")
    .optional(),
  // Opt-in reclassification flag. When true, the debugFlavor classifier is
  // re-run regardless of the persisted value. The result is written to metadata
  // unconditionally and an audit event fires if the value actually changed.
  reclassify: z.boolean().optional(),
});

// Result of evaluating workflow transition gates for a v2 `task_finish` call.
// Discriminated union so the caller builds the HTTP response while the helper
// stays free of Hono Context coupling. Distinct-reviewer is checked by the
// caller in the review-finish branch (not here) because the audit-event
// payload needs caller-only fields (actor identity, claim columns).
//
// `skipped` (additive, ADR-0010 §5c v1): GITHUB_BACKED_RULES that were NOT
// evaluated because the task's effective deliverable repo is foreign to
// project.githubRepo — this project's GitHub token has no standing there,
// so ciGreen/prMerged are treated as trivially satisfied rather than
// evaluated against the wrong repo (or forced to fail closed forever).
type FinishGateResult =
  | {
      ok: true;
      resolvedRequires: string[] | undefined;
      skipped: Array<{ rule: TransitionRule; reason: string }>;
    }
  | { ok: false; kind: "no_transition"; message: string }
  | { ok: false; kind: "forbidden_role"; requiredRole: string }
  | {
      ok: false;
      kind: "precondition";
      failed: TransitionRule[];
      ruleErrors: Record<string, string>;
    };

// Enforce workflow-transition gates for a v2 `task_finish` call. Mirrors the
// inline block inside the v1 `/transition` handler at tasks.ts:~1697–1833 so
// v1 and v2 transitions reject the same preconditions. v2 has no `force`
// escape hatch by design — admin overrides remain on the v1 `/transition`
// endpoint per ADR-0008 "REST-API bleibt unverändert vollständig".
//
// Gate evaluation uses a merged context: `prUrl` / `prNumber` come from the
// finish payload if provided, otherwise from the task's current DB state.
// `branchName` is always read from the DB state (v2 task_finish has no
// branchName payload — that's the gap ADR-0009's `task_submit_pr` closes).
// This matches the v2 API's stated contract that `task_finish { prUrl }`
// is an atomic "submit this PR and finish" intent; requiring a separate
// PATCH first would break the verb's ergonomics without a good reason.
//
// /transition does not have this merge because its payload has no prUrl
// field — it assumes callers set prUrl via PATCH. So the two paths differ
// in inputs but apply the same rule-evaluation logic. Strict parity is on
// the rule semantics, not on the input plumbing.
//
// The caller resolves the effective workflow definition (task.workflow →
// project default → built-in fallback) and passes it in. This keeps the
// target-state derivation and gate evaluation consistent — both operate on
// the same resolved definition, instead of risking a drift where one uses
// the project default and the other the built-in.
async function evaluateV2TransitionGates(task: {
  projectId: string;
  status: string;
  deliverableRepo?: string | null;
  project: { teamId: string; githubRepo: string | null };
}, gateContext: {
  branchName: string | null;
  prUrl: string | null;
  prNumber: number | null;
}, targetStatus: string, actor: Actor, effectiveDefinition: WorkflowDefinitionShape | null, skipRules?: readonly string[]): Promise<FinishGateResult> {
  let resolvedRequires: string[] | undefined;
  let requiredRole: string | undefined;

  if (effectiveDefinition) {
    const transition = effectiveDefinition.transitions.find(
      (t) => t.from === task.status && t.to === targetStatus,
    );
    if (!transition) {
      return {
        ok: false,
        kind: "no_transition",
        message: `Transition from '${task.status}' to '${targetStatus}' is not allowed by workflow`,
      };
    }
    resolvedRequires = transition.requires;
    requiredRole = transition.requiredRole;
  } else {
    const defaultT = findDefaultTransition(task.status, targetStatus);
    if (!defaultT) {
      return {
        ok: false,
        kind: "no_transition",
        message: `Transition from '${task.status}' to '${targetStatus}' is not allowed by the default workflow`,
      };
    }
    resolvedRequires = defaultT.requires;
  }

  // Strip rules that the caller needs to handle separately (e.g. prMerged
  // during autoMerge — the merge hasn't happened yet at pre-check time).
  if (skipRules && skipRules.length > 0 && resolvedRequires) {
    resolvedRequires = resolvedRequires.filter((r) => !skipRules.includes(r));
  }

  // Foreign-deliverable skip (ADR-0010 §5c v1). A task whose effective
  // deliverable repo diverges from project.githubRepo has its PR lifecycle
  // in a repo this project's GitHub token has no standing on — ciGreen and
  // prMerged cannot be evaluated there. v1 semantics: treat them as
  // trivially satisfied and record why, rather than fail closed forever (no
  // recovery path exists on a repo this project can never query) or
  // silently drop them (which would hide the skip from callers/audits).
  const skipped: Array<{ rule: TransitionRule; reason: string }> = [];
  const effectiveRepo = effectiveDeliverableRepo(task, task.project);
  const foreignDeliverable = isForeignDeliverable(task, task.project);
  if (foreignDeliverable && resolvedRequires) {
    const githubBacked = resolvedRequires.filter((r) => GITHUB_BACKED_RULES.has(r as never));
    for (const r of githubBacked) {
      skipped.push({
        rule: r as TransitionRule,
        reason: `Task deliverable is ${effectiveRepo ?? "an external repo"}; this project's GitHub token has no standing there, so '${r}' cannot be evaluated and is treated as satisfied (v1 semantics).`,
      });
    }
    if (githubBacked.length > 0) {
      resolvedRequires = resolvedRequires.filter((r) => !GITHUB_BACKED_RULES.has(r as never));
    }
  }

  // Role gate. "any" is the common path and bypasses the DB round-trip, per
  // the same hot-path optimization as /transition.
  if (requiredRole && requiredRole !== "any") {
    const hasRole = await hasProjectRole(actor, task.projectId, requiredRole as ProjectRole);
    if (!hasRole) {
      return { ok: false, kind: "forbidden_role", requiredRole };
    }
  }

  // Precondition rules. GitHub token is only resolved when at least one rule
  // actually needs it — same optimization as /transition.
  let githubToken: string | null = null;
  const needsGithub =
    resolvedRequires?.some((r) => GITHUB_BACKED_RULES.has(r as never)) ?? false;
  if (needsGithub && task.project.githubRepo) {
    const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrCreate", {
      preferUserId: actor.userId,
    });
    githubToken = delegate?.githubAccessToken ?? null;
  }

  const { failed, unknown, errors: ruleErrors } = await evaluateTransitionRules(
    resolvedRequires,
    {
      branchName: gateContext.branchName,
      prUrl: gateContext.prUrl,
      prNumber: gateContext.prNumber,
      projectGithubRepo: task.project.githubRepo,
      githubToken,
    },
  );

  if (failed.length > 0) {
    return { ok: false, kind: "precondition", failed, ruleErrors };
  }

  if (unknown.length > 0) {
    logger.warn(
      { component: "workflow", unknown },
      "v2 transition references unknown rules",
    );
  }

  return { ok: true, resolvedRequires, skipped };
}

taskRouter.post("/tasks/:id/finish", async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type === "agent" && !actor.scopes.includes("tasks:transition")) {
    return forbidden(c, "Missing scope: tasks:transition");
  }

  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    include: {
      workflow: true,
      project: {
        select: {
          id: true,
          name: true,
          slug: true,
          teamId: true,
          githubRepo: true,
          requireDistinctReviewer: true,
          soloMode: true,
          governanceMode: true,
          requireGroundingForDebug: true,
        },
      },
      ...taskInclude,
    },
  });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  // Determine which claim the actor holds. A missing claim is a 403 — the
  // caller must hold a claim to finish a task.
  const holdsWorkClaim =
    (actor.type === "human" && task.claimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.claimedByAgentId === actor.tokenId);
  const holdsReviewClaim =
    (actor.type === "human" && task.reviewClaimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.reviewClaimedByAgentId === actor.tokenId);

  if (!holdsWorkClaim && !holdsReviewClaim) {
    return forbidden(
      c,
      "You do not hold a claim on this task. Call task_start to claim it before task_finish, even if you just finished an unrelated task in the same session.",
    );
  }

  const rawBody = await c.req.json().catch(() => ({}));

  // Resolve the effective workflow definition once, before the dispatch
  // branches, so all three branches (review-finish, self-approve, work-finish)
  // share the same resolved definition and isReviewState can be evaluated here.
  const effectiveDefinition = await resolveEffectiveDefinition(task, prisma);

  // ── Branch: review finish ─────────────────────────────────────────────────
  if (holdsReviewClaim) {

    if (!isReviewState(effectiveDefinition, task.status)) {
      return c.json({ error: "bad_state", message: "Task must be in review status" }, 409);
    }
    const parsed = finishReviewSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "bad_request", message: parsed.error.message }, 400);
    }
    const { outcome, result, autoMerge, mergeMethod } = parsed.data;

    const targetStatus = outcome === "approve"
      ? approveTarget(effectiveDefinition, task.status) ?? "done"
      : requestChangesTarget(effectiveDefinition, task.status) ?? task.status;

    // Distinct-reviewer gate. Defense-in-depth: pickup already excludes the
    // author from the review pool, but an explicit workflow path could place
    // an author into a review state some other way. The PATCH and /transition
    // handlers both check this; v2 task_finish was silently skipping it.
    if (
      outcome === "approve" &&
      resolveGovernanceMode(task.project) === GovernanceMode.REQUIRES_DISTINCT_REVIEWER
    ) {
      const gate = checkReviewApprovalGate(task, actor, task.project);
      if (!gate.allowed) {
        void logAuditEvent({
          action: "task.review_rejected_self_reviewer",
          actorId: actor.type === "human" ? actor.userId : undefined,
          projectId: task.projectId,
          taskId: task.id,
          payload: {
            reason: gate.reason,
            actorType: actor.type,
            agentTokenId: actor.type === "agent" ? actor.tokenId : null,
            endpoint: "task_finish",
            claimedByUserId: task.claimedByUserId,
            claimedByAgentId: task.claimedByAgentId,
            reviewClaimedByUserId: task.reviewClaimedByUserId,
            reviewClaimedByAgentId: task.reviewClaimedByAgentId,
          },
        });
        return forbidden(c, distinctReviewerRejectionMessage());
      }
    }

    // Transition gates (branchPresent / prPresent / ciGreen / prMerged).
    // Mirrors the /transition block; see evaluateV2TransitionGates
    // for the shared semantics. The effective workflow was resolved above
    // (effectiveDefinition, hoisted before the dispatch) so both paths evaluate
    // gates against the same definition.
    // Review-finish has no prUrl / branchName payload, so the gate context
    // is just the task's current DB state.
    const gateResult = await evaluateV2TransitionGates(
      task,
      { branchName: task.branchName, prUrl: task.prUrl, prNumber: task.prNumber },
      targetStatus,
      actor,
      effectiveDefinition,
      autoMerge ? ["prMerged"] : undefined,
    );
    if (!gateResult.ok) {
      if (gateResult.kind === "no_transition") {
        return c.json({ error: "bad_request", message: gateResult.message }, 400);
      }
      if (gateResult.kind === "forbidden_role") {
        return forbidden(c, `Requires role: ${gateResult.requiredRole}`);
      }
      if (gateResult.kind === "precondition") {
        const { failed, ruleErrors } = gateResult;
        return c.json(
          {
            error: "precondition_failed",
            message: `Transition blocked — ${failed
              .map((r) => (ruleErrors[r] ? `${RULE_MESSAGES[r]} (${ruleErrors[r]})` : RULE_MESSAGES[r]))
              .join(" ")}`,
            failed: failed.map((r) => ({
              rule: r,
              message: RULE_MESSAGES[r],
              ...(ruleErrors[r] ? { error: ruleErrors[r] } : {}),
            })),
            canForce: false,
          },
          422,
        );
      }
      // Exhaustiveness check — if a new FinishGateResult variant is added and
      // this branch forgets to handle it, TS fails here. Without this guard
      // an unhandled variant would silently fall through to the task-update
      // path, which is *exactly* the bug this handler was just fixed for.
      const _exhaustive: never = gateResult;
      return _exhaustive;
    }

    // ── Mode B autoMerge: review-approve + merge (ADR-0010 §2) ──────────
    let reviewAutoMergeSha: string | null = null;
    if (autoMerge && outcome === "approve") {
      // Self-merge gate: projects that opt into `requireDistinctReviewer`
      // (and are not soloMode) forbid the work-claim holder from merging
      // their own PR, even via auto-merge. Matches the standalone
      // `POST /tasks/:id/merge` verb — the invariant lives in review-gate.ts
      // so the two paths cannot drift.
      if (actor.type === "agent" && !actor.scopes.includes(SCOPES.GithubPrMerge)) {
        return c.json({ error: "forbidden", message: `Token missing scope: ${SCOPES.GithubPrMerge}` }, 403);
      }
      const selfMerge = checkSelfMergeGate(task, actor, task.project);
      if (!selfMerge.allowed) {
        void logAuditEvent({
          action: "task.pr_merged.blocked_self_merge",
          projectId: task.projectId,
          taskId: task.id,
          payload: {
            via: "task_finish",
            actorType: actor.type,
            agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
            userId: actor.type === "human" ? actor.userId : undefined,
            claimedByAgentId: task.claimedByAgentId,
            claimedByUserId: task.claimedByUserId,
          },
        });
        return c.json(
          { error: "self_merge_blocked", message: selfMergeRejectionMessage() },
          403,
        );
      }
      const mergeResult = await performPrMerge(task, mergeMethod, actor);
      if (!mergeResult.ok) {
        const status = mergeResult.error === "no_delegation" ? 403 : (mergeResult.status ?? 502);
        return c.json(
          { error: mergeResult.error, message: mergeResult.message },
          status as 403 | 409 | 502,
        );
      }

      // Post-check: if the workflow required prMerged, verify it now.
      const workflowHadPrMerged =
        effectiveDefinition
          ? effectiveDefinition.transitions
              .find((t) => t.from === "review" && t.to === "done")
              ?.requires?.includes("prMerged") ?? false
          : false;

      if (workflowHadPrMerged) {
        const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrMerge", {
          preferUserId: actor.userId,
        });
        const postCheck = await evaluateTransitionRules(["prMerged"], {
          branchName: task.branchName,
          prUrl: task.prUrl,
          prNumber: task.prNumber,
          projectGithubRepo: task.project.githubRepo,
          githubToken: delegate?.githubAccessToken ?? null,
        });
        if (postCheck.failed.length > 0) {
          void logAuditEvent({
            action: "task.auto_merge_post_assert_failed",
            projectId: task.projectId,
            taskId: task.id,
            payload: { mode: "B", mergeSha: mergeResult.sha, postCheckFailed: postCheck.failed },
          });
          return c.json(
            { error: "github_error", message: "PR merge succeeded but post-check failed — prMerged rule not satisfied. Manual reconciliation required." },
            502,
          );
        }
      }

      reviewAutoMergeSha = mergeResult.sha;
    }

    const updateData: Prisma.TaskUncheckedUpdateInput = {
      status: targetStatus,
      reviewClaimedByUserId: null,
      reviewClaimedByAgentId: null,
      reviewClaimedAt: null,
      ...(result !== undefined ? { result } : {}),
      ...(reviewAutoMergeSha !== null ? { autoMergeSha: reviewAutoMergeSha } : {}),
    };

    if (outcome === "approve") {
      // Clear the work claim on approval — the task is done, free the author
      updateData.claimedByUserId = null;
      updateData.claimedByAgentId = null;
      updateData.claimedAt = null;
    }
    // On request_changes we intentionally keep claimedBy* so the original
    // author resumes ownership automatically and the hard-limit still
    // reflects their active claim.

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: updateData,
      include: taskInclude,
    });

    if (outcome === "approve" && isTerminalState(effectiveDefinition, targetStatus)) {
      await acknowledgeSignalsForTask(task.id);
      if (reviewAutoMergeSha !== null) {
        void emitSelfMergeNoticeIfApplicable({
          taskId: task.id,
          projectId: task.projectId,
          actor,
          project: {
            soloMode: task.project.soloMode,
            requireDistinctReviewer: task.project.requireDistinctReviewer,
          },
          mergeSha: reviewAutoMergeSha,
          via: "task_finish_auto_merge",
        });
      }
    }

    const actorId = actor.type === "human" ? actor.userId : actor.tokenId;
    void logAuditEvent({
      action: "task.reviewed",
      actorId: actor.type === "human" ? actor.userId : undefined,
      projectId: task.projectId,
      taskId: task.id,
      payload: { reviewAction: outcome, from: "review", to: targetStatus, actorType: actor.type, reviewerId: actorId, via: "task_finish" },
    });

    // Audit the autoMerge join record (ties the merge to this task finish).
    if (reviewAutoMergeSha !== null) {
      void logAuditEvent({
        action: "task.auto_merged",
        actorId: actor.type === "human" ? actor.userId : undefined,
        projectId: task.projectId,
        taskId: task.id,
        payload: { mode: "B", autoMergeSha: reviewAutoMergeSha, mergeMethod, actorType: actor.type },
      });
    }

    const reviewerName =
      actor.type === "agent"
        ? (await prisma.agentToken.findUnique({ where: { id: actor.tokenId }, select: { name: true } }))?.name ?? "Agent"
        : (await prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))?.name ?? "Reviewer";

    if (outcome === "request_changes") {
      void emitChangesRequestedSignal(
        task.id,
        task.projectId,
        task.claimedByUserId,
        task.claimedByAgentId,
        reviewerName,
        result,
      );
    } else {
      void emitTaskApprovedSignal(
        task.id,
        task.projectId,
        task.claimedByUserId,
        task.claimedByAgentId,
        reviewerName,
        result,
      );
    }

    return c.json({
      kind: "review",
      task: updated,
      outcome,
      ...(reviewAutoMergeSha !== null ? { autoMergeSha: reviewAutoMergeSha } : {}),
      ...(gateResult.skipped.length > 0 ? { skippedGates: gateResult.skipped } : {}),
    });
  }

  // ── Branch: self-approve (work-claim holder on a review-state non-DR task) ──
  //
  // The webhook-merge-to-review flow lands the task in `review` status with
  // only a work claim held (no review claim, because no separate reviewer has
  // picked it up). For non-REQUIRES_DISTINCT_REVIEWER projects the work-claim
  // holder may act as self-reviewer: they already own the work and the project
  // does not enforce dual control. REQUIRES_DISTINCT_REVIEWER projects still
  // get a 403 — they must use the separate review-claim path.
  //
  // Condition (at this point holdsReviewClaim is false):
  //   holdsWorkClaim && isReviewState(effectiveDefinition, task.status)
  //   && governanceMode !== REQUIRES_DISTINCT_REVIEWER
  if (
    holdsWorkClaim &&
    isReviewState(effectiveDefinition, task.status) &&
    resolveGovernanceMode(task.project) !== GovernanceMode.REQUIRES_DISTINCT_REVIEWER &&
    !task.reviewClaimedByUserId &&
    !task.reviewClaimedByAgentId
  ) {
    // Parse with the review schema — outcome is mandatory in this branch.
    const selfApprParsed = finishReviewSchema.safeParse(rawBody);
    if (!selfApprParsed.success) {
      // Give a more helpful error than the generic Zod message: the caller
      // reached this branch because the task is in review state and they hold
      // only a work claim. They need to supply `outcome` to act as
      // self-reviewer; falling through to the work-finish branch would produce
      // a misleading "Work finish requires a work state" 409.
      const zodMessage = selfApprParsed.error.flatten().fieldErrors.outcome?.[0];
      return c.json(
        {
          error: "bad_request",
          message:
            `This task is in review state and you hold a work claim (no review lock). ` +
            `Provide outcome: "approve" or "request_changes" to act as self-reviewer. ` +
            (zodMessage ? `(${zodMessage})` : ""),
        },
        400,
      );
    }
    const { outcome: selfApprOutcome, result: selfApprResult, autoMerge: selfApprAutoMerge, mergeMethod: selfApprMergeMethod } = selfApprParsed.data;

    const selfApprTargetStatus = selfApprOutcome === "approve"
      ? approveTarget(effectiveDefinition, task.status) ?? "done"
      : requestChangesTarget(effectiveDefinition, task.status) ?? task.status;

    // Transition gates — same path as the review-finish branch.
    const selfApprGateResult = await evaluateV2TransitionGates(
      task,
      { branchName: task.branchName, prUrl: task.prUrl, prNumber: task.prNumber },
      selfApprTargetStatus,
      actor,
      effectiveDefinition,
      selfApprAutoMerge ? ["prMerged"] : undefined,
    );
    if (!selfApprGateResult.ok) {
      if (selfApprGateResult.kind === "no_transition") {
        return c.json({ error: "bad_request", message: selfApprGateResult.message }, 400);
      }
      if (selfApprGateResult.kind === "forbidden_role") {
        return forbidden(c, `Requires role: ${selfApprGateResult.requiredRole}`);
      }
      if (selfApprGateResult.kind === "precondition") {
        const { failed, ruleErrors } = selfApprGateResult;
        return c.json(
          {
            error: "precondition_failed",
            message: `Transition blocked — ${failed
              .map((r) => (ruleErrors[r] ? `${RULE_MESSAGES[r]} (${ruleErrors[r]})` : RULE_MESSAGES[r]))
              .join(" ")}`,
            failed: failed.map((r) => ({
              rule: r,
              message: RULE_MESSAGES[r],
              ...(ruleErrors[r] ? { error: ruleErrors[r] } : {}),
            })),
            canForce: false,
          },
          422,
        );
      }
      const _exhaustive: never = selfApprGateResult;
      return _exhaustive;
    }

    // Mode B autoMerge for self-approve (same as review-finish).
    let selfApprAutoMergeSha: string | null = null;
    if (selfApprAutoMerge && selfApprOutcome === "approve") {
      if (actor.type === "agent" && !actor.scopes.includes(SCOPES.GithubPrMerge)) {
        return c.json({ error: "forbidden", message: `Token missing scope: ${SCOPES.GithubPrMerge}` }, 403);
      }
      const selfMerge = checkSelfMergeGate(task, actor, task.project);
      if (!selfMerge.allowed) {
        void logAuditEvent({
          action: "task.pr_merged.blocked_self_merge",
          projectId: task.projectId,
          taskId: task.id,
          payload: {
            via: "task_finish_self_approve",
            actorType: actor.type,
            agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
            userId: actor.type === "human" ? actor.userId : undefined,
            claimedByAgentId: task.claimedByAgentId,
            claimedByUserId: task.claimedByUserId,
          },
        });
        return c.json(
          { error: "self_merge_blocked", message: selfMergeRejectionMessage() },
          403,
        );
      }
      const mergeResult = await performPrMerge(task, selfApprMergeMethod, actor);
      if (!mergeResult.ok) {
        const status = mergeResult.error === "no_delegation" ? 403 : (mergeResult.status ?? 502);
        return c.json(
          { error: mergeResult.error, message: mergeResult.message },
          status as 403 | 409 | 502,
        );
      }

      // Post-check: if the workflow required prMerged, verify it now.
      // Mirrors the review-finish autoMerge post-assert (~2118-2149).
      const selfApprWorkflowHadPrMerged =
        effectiveDefinition
          ? effectiveDefinition.transitions
              .find((t) => t.from === task.status && t.to === selfApprTargetStatus)
              ?.requires?.includes("prMerged") ?? false
          : false;

      if (selfApprWorkflowHadPrMerged) {
        const selfApprDelegate = await findDelegationUser(task.project.teamId, "allowAgentPrMerge", {
          preferUserId: actor.userId,
        });
        const selfApprPostCheck = await evaluateTransitionRules(["prMerged"], {
          branchName: task.branchName,
          prUrl: task.prUrl,
          prNumber: task.prNumber,
          projectGithubRepo: task.project.githubRepo,
          githubToken: selfApprDelegate?.githubAccessToken ?? null,
        });
        if (selfApprPostCheck.failed.length > 0) {
          void logAuditEvent({
            action: "task.auto_merge_post_assert_failed",
            projectId: task.projectId,
            taskId: task.id,
            payload: { mode: "B_self_approve", mergeSha: mergeResult.sha, postCheckFailed: selfApprPostCheck.failed },
          });
          return c.json(
            { error: "github_error", message: "PR merge succeeded but post-check failed — prMerged rule not satisfied. Manual reconciliation required." },
            502,
          );
        }
      }

      selfApprAutoMergeSha = mergeResult.sha;
    }

    const selfApprUpdateData: Prisma.TaskUncheckedUpdateInput = {
      status: selfApprTargetStatus,
      // Clear the review claim slot even though it was never set — keeps the
      // columns at null (their current value) and avoids a separate check.
      reviewClaimedByUserId: null,
      reviewClaimedByAgentId: null,
      reviewClaimedAt: null,
      ...(selfApprResult !== undefined ? { result: selfApprResult } : {}),
      ...(selfApprAutoMergeSha !== null ? { autoMergeSha: selfApprAutoMergeSha } : {}),
    };

    if (selfApprOutcome === "approve") {
      // Clear the work claim on approval.
      selfApprUpdateData.claimedByUserId = null;
      selfApprUpdateData.claimedByAgentId = null;
      selfApprUpdateData.claimedAt = null;
    }
    // On request_changes keep claimedBy* so the author resumes ownership.

    const selfApprUpdated = await prisma.task.update({
      where: { id: task.id },
      data: selfApprUpdateData,
      include: taskInclude,
    });

    if (selfApprOutcome === "approve" && isTerminalState(effectiveDefinition, selfApprTargetStatus)) {
      await acknowledgeSignalsForTask(task.id);
      if (selfApprAutoMergeSha !== null) {
        // Mirrors review-finish ~2181-2193: notify team members on AWAITS_CONFIRMATION
        // projects that a self-merge happened. emitSelfMergeNoticeIfApplicable
        // is a no-op for AUTONOMOUS projects.
        void emitSelfMergeNoticeIfApplicable({
          taskId: task.id,
          projectId: task.projectId,
          actor,
          project: {
            governanceMode: task.project.governanceMode,
            soloMode: task.project.soloMode,
            requireDistinctReviewer: task.project.requireDistinctReviewer,
          },
          mergeSha: selfApprAutoMergeSha,
          via: "task_finish_auto_merge",
        });
      }
    }

    const selfApprActorId = actor.type === "human" ? actor.userId : actor.tokenId;
    void logAuditEvent({
      action: "task.reviewed",
      actorId: actor.type === "human" ? actor.userId : undefined,
      projectId: task.projectId,
      taskId: task.id,
      payload: {
        reviewAction: selfApprOutcome,
        from: task.status,
        to: selfApprTargetStatus,
        actorType: actor.type,
        reviewerId: selfApprActorId,
        via: "task_finish_self_approve",
      },
    });

    if (selfApprAutoMergeSha !== null) {
      void logAuditEvent({
        action: "task.auto_merged",
        actorId: actor.type === "human" ? actor.userId : undefined,
        projectId: task.projectId,
        taskId: task.id,
        payload: { mode: "B_self_approve", autoMergeSha: selfApprAutoMergeSha, mergeMethod: selfApprMergeMethod, actorType: actor.type },
      });
    }

    const selfApprActorName =
      actor.type === "agent"
        ? (await prisma.agentToken.findUnique({ where: { id: actor.tokenId }, select: { name: true } }))?.name ?? "Agent"
        : (await prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))?.name ?? "Reviewer";

    if (selfApprOutcome === "request_changes") {
      void emitChangesRequestedSignal(
        task.id,
        task.projectId,
        task.claimedByUserId,
        task.claimedByAgentId,
        selfApprActorName,
        selfApprResult,
      );
    } else {
      void emitTaskApprovedSignal(
        task.id,
        task.projectId,
        task.claimedByUserId,
        task.claimedByAgentId,
        selfApprActorName,
        selfApprResult,
      );
    }

    return c.json({
      kind: "review",
      task: selfApprUpdated,
      outcome: selfApprOutcome,
      ...(selfApprAutoMergeSha !== null ? { autoMergeSha: selfApprAutoMergeSha } : {}),
      ...(selfApprGateResult.skipped.length > 0 ? { skippedGates: selfApprGateResult.skipped } : {}),
    });
  }

  // Guard: work-claim holder on a non-DR review-state task, but a distinct
  // reviewer already holds the review claim. The self-approve branch above was
  // skipped because !task.reviewClaimedByUserId && !task.reviewClaimedByAgentId
  // did not hold. Clobbering an in-flight reviewer's claim silently would be
  // wrong; surface a 409 so the caller knows to wait or coordinate.
  if (
    holdsWorkClaim &&
    isReviewState(effectiveDefinition, task.status) &&
    resolveGovernanceMode(task.project) !== GovernanceMode.REQUIRES_DISTINCT_REVIEWER
  ) {
    return c.json(
      {
        error: "reviewer_conflict",
        message:
          "A reviewer already holds the review claim for this task. " +
          "Wait for them to finish or release their claim, then retry.",
      },
      409,
    );
  }

  // Guard: work-claim holder on a review-state REQUIRES_DISTINCT_REVIEWER
  // project. The self-approve branch above was skipped because DR is enforced;
  // we must reject here with a clear message before falling into the work-finish
  // guard, which would produce a misleading "bad_state" 409.
  if (holdsWorkClaim && isReviewState(effectiveDefinition, task.status)) {
    return forbidden(
      c,
      "This task is in review state and the project requires a distinct reviewer. " +
        "A separate agent or user must claim the review (task_start) and approve it.",
    );
  }

  // ── Branch: work finish ───────────────────────────────────────────────────

  const parsed = finishWorkSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "bad_request", message: parsed.error.message }, 400);
  }
  const { result, prUrl, autoMerge: workAutoMerge, mergeMethod: workMergeMethod } = parsed.data;

  // ── Retry idempotency (ADR-0010 §8) ──────────────────────────────────
  if (workAutoMerge) {
    // Short-circuit: task already done + autoMergeSha set → return existing.
    if (task.status === "done" && task.autoMergeSha) {
      return c.json({ kind: "work", task, targetStatus: "done", autoMergeSha: task.autoMergeSha });
    }
    // Mid-flight recovery: task still in_progress + autoMergeSha set →
    // check if the merge actually succeeded on GitHub and skip re-merging.
    if (task.status === "in_progress" && task.autoMergeSha) {
      // The merge succeeded in a prior call but the transition didn't complete.
      // Verify via prMerged rule, then proceed to transition only.
      const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrMerge", {
        preferUserId: actor.userId,
      });
      const postCheck = await evaluateTransitionRules(["prMerged"], {
        branchName: task.branchName,
        prUrl: task.prUrl,
        prNumber: task.prNumber,
        projectGithubRepo: task.project.githubRepo,
        githubToken: delegate?.githubAccessToken ?? null,
      });
      if (postCheck.failed.length === 0) {
        // PR is merged on GitHub — complete the transition without re-calling merge.
        const recovered = await prisma.task.update({
          where: { id: task.id },
          data: {
            status: "done",
            claimedByUserId: null,
            claimedByAgentId: null,
            claimedAt: null,
            ...(result !== undefined ? { result } : {}),
          },
          include: taskInclude,
        });
        await acknowledgeSignalsForTask(task.id);
        // Mid-flight recovery: the merge happened in a prior request that
        // never got to emit the notice. Emit it now so the human-visibility
        // path isn't skipped on retries.
        void emitSelfMergeNoticeIfApplicable({
          taskId: task.id,
          projectId: task.projectId,
          actor,
          project: {
            soloMode: task.project.soloMode,
            requireDistinctReviewer: task.project.requireDistinctReviewer,
          },
          mergeSha: task.autoMergeSha,
          via: "task_finish_auto_merge",
        });
        void logAuditEvent({
          action: "task.transitioned",
          actorId: actor.type === "human" ? actor.userId : undefined,
          projectId: task.projectId,
          taskId: task.id,
          payload: { from: "in_progress", to: "done", actorType: actor.type, via: "task_finish", recovery: true },
        });
        return c.json({ kind: "work", task: recovered, targetStatus: "done", autoMergeSha: task.autoMergeSha });
      }
      // PR not yet merged despite having autoMergeSha — fall through to
      // the normal merge path (GitHub API 405 will handle idempotency).
    }
  }

  if (!isWorkState(effectiveDefinition, task.status)) {
    return c.json(
      { error: "bad_state", message: `Work finish requires a work state (non-initial, non-terminal), got '${task.status}'` },
      409,
    );
  }

  // ── Phase 3 grounding finish-gate (ADR-0002) ─────────────────────────
  //
  // Placed AFTER the retry-idempotency short-circuit and the isWorkState
  // guard so a replayed finish on an already-done task hits the terminal
  // guard first, avoiding (a) unbounded bypass-audit growth and (b) a
  // misleading `grounding_required` 409 where `bad_state` is the real
  // answer. Only fires when the project opted in AND the task is
  // debug-flavored. Three failure modes (sessionStarted / ledgerEntries /
  // claimEvaluationPhase) collapse into a single 409 with a structured
  // `missing[]` so operators and clients can see exactly which
  // precondition the task failed.
  //
  // Reads of the evidence-ledger db degrade soft (returns 0 entries), see
  // RealGroundingClient.getLedgerSummary. That keeps the gate deterministic
  // even when the ledger file is unreadable; the failure surfaces as
  // `missing: ["ledgerEntries"]` to the operator instead of a 500.
  {
    const finishMetadata = readMetadata(task.metadata);
    if (finishMetadata.debugFlavor === true && task.project.requireGroundingForDebug) {
      const groundingClient = getGroundingClient();
      const sessionId = finishMetadata.groundingSessionId;
      const ledger = sessionId
        ? await groundingClient.getLedgerSummary(sessionId)
        : { entryCount: 0 };
      const phase = getSessionPhase(finishMetadata);
      const gateResult = evaluateGroundingGate({
        metadata: finishMetadata,
        project: { requireGroundingForDebug: task.project.requireGroundingForDebug },
        ledgerSummary: ledger,
        currentPhase: phase.currentPhase,
      });
      if (!gateResult.allowed) {
        return c.json(
          {
            error: "grounding_required",
            message: "Debug task requires grounding evidence",
            missing: gateResult.missing,
            sessionId: gateResult.sessionId,
            currentPhase: gateResult.currentPhase,
            entryCount: gateResult.entryCount,
          },
          409,
        );
      }
    } else if (finishMetadata.debugFlavor === true && !task.project.requireGroundingForDebug) {
      // Bypass-audit. Lets operators retroactively see when the gate WOULD
      // have fired, e.g. while validating the multi-host-to-single-host
      // migration story. Scoped to debug-flavored tasks so non-debug work
      // doesn't drown the audit log.
      void logAuditEvent({
        action: "task.grounding_gate.bypassed",
        actorId: actor.type === "human" ? actor.userId : undefined,
        projectId: task.projectId,
        taskId: task.id,
        payload: {
          reason: "requireGroundingForDebug=false",
          sessionId: finishMetadata.groundingSessionId ?? null,
          actorType: actor.type,
        },
      });
    }
  }

  // When autoMerge is requested, hard-set targetStatus to "done" and verify
  // the workflow actually supports in_progress → done (ADR-0010 §2 Mode A).
  let targetStatus: string;
  if (workAutoMerge) {
    if (resolveGovernanceMode(task.project) !== GovernanceMode.AUTONOMOUS) {
      return c.json(
        {
          error: "autonomous_mode_required",
          message:
            "autoMerge on a work claim requires governanceMode=AUTONOMOUS (formerly soloMode=true)",
        },
        403,
      );
    }
    targetStatus = "done";
  } else {
    targetStatus = expectedFinishStateFromDefinition(effectiveDefinition);
  }

  // Cross-repo validation on prUrl payload (ADR-0010 §5b/§5c). Shared gate —
  // same logic is used by submit-pr below. See services/gates/. Compares
  // against the task's EFFECTIVE deliverable repo (task.deliverableRepo when
  // set, else project.githubRepo).
  if (prUrl) {
    const crossRepo = checkPrRepoMatchesProject(prUrl, task, task.project);
    if (!crossRepo.ok) {
      return c.json(
        {
          error: "cross_repo_pr_rejected",
          message: prRepoMatchesProjectRejectionMessage(
            crossRepo.prOwner,
            crossRepo.prRepo,
            crossRepo.projectRepo,
          ),
        },
        400,
      );
    }
  }

  // Extract PR number from URL if provided. Done once, up-front, so both
  // the gate context and the DB write see the same value.
  let prNumber: number | null = null;
  if (prUrl) {
    const match = prUrl.match(/\/pull\/(\d+)/);
    if (match) prNumber = Number.parseInt(match[1], 10);
  }

  // Transition gates (branchPresent / prPresent / ciGreen / prMerged).
  // When autoMerge is requested, strip prMerged from the pre-check.
  const gateResult = await evaluateV2TransitionGates(
    task,
    {
      branchName: task.branchName,
      prUrl: prUrl ?? task.prUrl,
      prNumber: prNumber ?? task.prNumber,
    },
    targetStatus,
    actor,
    effectiveDefinition,
    workAutoMerge ? ["prMerged"] : undefined,
  );
  if (!gateResult.ok) {
    if (gateResult.kind === "no_transition") {
      return c.json({ error: "bad_request", message: gateResult.message }, 400);
    }
    if (gateResult.kind === "forbidden_role") {
      return forbidden(c, `Requires role: ${gateResult.requiredRole}`);
    }
    if (gateResult.kind === "precondition") {
      const { failed, ruleErrors } = gateResult;
      return c.json(
        {
          error: "precondition_failed",
          message: `Transition blocked — ${failed
            .map((r) => (ruleErrors[r] ? `${RULE_MESSAGES[r]} (${ruleErrors[r]})` : RULE_MESSAGES[r]))
            .join(" ")}`,
          failed: failed.map((r) => ({
            rule: r,
            message: RULE_MESSAGES[r],
            ...(ruleErrors[r] ? { error: ruleErrors[r] } : {}),
          })),
          canForce: false,
        },
        422,
      );
    }
    const _exhaustive: never = gateResult;
    return _exhaustive;
  }

  // ── Mode A autoMerge: solo work-claim merge (ADR-0010 §2) ────────────
  let workAutoMergeSha: string | null = null;
  if (workAutoMerge) {
    if (actor.type === "agent" && !actor.scopes.includes(SCOPES.GithubPrMerge)) {
      return c.json({ error: "forbidden", message: `Token missing scope: ${SCOPES.GithubPrMerge}` }, 403);
    }
    // Self-merge gate is a no-op in soloMode (which Mode A requires anyway),
    // but keep the call site symmetric with Mode B so the invariant is
    // visible in one place.
    const selfMerge = checkSelfMergeGate(task, actor, task.project);
    if (!selfMerge.allowed) {
      void logAuditEvent({
        action: "task.pr_merged.blocked_self_merge",
        projectId: task.projectId,
        taskId: task.id,
        payload: {
          via: "task_finish_mode_a",
          actorType: actor.type,
          agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
        },
      });
      return c.json(
        { error: "self_merge_blocked", message: selfMergeRejectionMessage() },
        403,
      );
    }
    // Merge payload-derived prNumber onto task so performPrMerge sees it
    // even when prNumber is not yet in the DB (task_finish { prUrl } shorthand).
    const mergeResult = await performPrMerge(
      { ...task, prNumber: prNumber ?? task.prNumber },
      workMergeMethod,
      actor,
    );
    if (!mergeResult.ok) {
      const status = mergeResult.error === "no_delegation" ? 403 : (mergeResult.status ?? 502);
      return c.json(
        { error: mergeResult.error, message: mergeResult.message },
        status as 403 | 409 | 502,
      );
    }

    // Post-check: if the workflow required prMerged, verify it now.
    const workflowHadPrMerged =
      effectiveDefinition
        ? effectiveDefinition.transitions
            .find((t) => t.from === "in_progress" && t.to === "done")
            ?.requires?.includes("prMerged") ?? false
        : false;

    if (workflowHadPrMerged) {
      const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrMerge", {
        preferUserId: actor.userId,
      });
      const postCheck = await evaluateTransitionRules(["prMerged"], {
        branchName: task.branchName,
        prUrl: prUrl ?? task.prUrl,
        prNumber: prNumber ?? task.prNumber,
        projectGithubRepo: task.project.githubRepo,
        githubToken: delegate?.githubAccessToken ?? null,
      });
      if (postCheck.failed.length > 0) {
        void logAuditEvent({
          action: "task.auto_merge_post_assert_failed",
          projectId: task.projectId,
          taskId: task.id,
          payload: { mode: "A", mergeSha: mergeResult.sha, postCheckFailed: postCheck.failed },
        });
        return c.json(
          { error: "github_error", message: "PR merge succeeded but post-check failed — prMerged rule not satisfied. Manual reconciliation required." },
          502,
        );
      }
    }

    workAutoMergeSha = mergeResult.sha;
  }

  const updateData: Prisma.TaskUncheckedUpdateInput = {
    status: targetStatus,
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(prNumber !== null ? { prNumber } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(workAutoMergeSha !== null ? { autoMergeSha: workAutoMergeSha } : {}),
  };

  // Clear work claim only when going to a terminal state. If going to review,
  // keep the claim so the original author resumes if changes are requested.
  if (isTerminalState(effectiveDefinition, targetStatus)) {
    updateData.claimedByUserId = null;
    updateData.claimedByAgentId = null;
    updateData.claimedAt = null;
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: updateData,
    include: taskInclude,
  });

  if (isTerminalState(effectiveDefinition, targetStatus)) {
    await acknowledgeSignalsForTask(task.id);
    if (workAutoMergeSha !== null) {
      // Currently only reachable from soloMode projects (work-finish
      // autoMerge is gated on soloMode further up), so the helper will
      // short-circuit. Kept as a symmetric call site with the other
      // merge-to-done paths; if the soloMode gate is ever relaxed on the
      // work-finish branch, the notice will fire automatically.
      void emitSelfMergeNoticeIfApplicable({
        taskId: task.id,
        projectId: task.projectId,
        actor,
        project: {
          soloMode: task.project.soloMode,
          requireDistinctReviewer: task.project.requireDistinctReviewer,
        },
        mergeSha: workAutoMergeSha,
        via: "task_finish_auto_merge",
      });
    }
  }

  void logAuditEvent({
    action: "task.transitioned",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: { from: task.status, to: targetStatus, actorType: actor.type, via: "task_finish" },
  });

  // Audit the autoMerge join record.
  if (workAutoMergeSha !== null) {
    void logAuditEvent({
      action: "task.auto_merged",
      actorId: actor.type === "human" ? actor.userId : undefined,
      projectId: task.projectId,
      taskId: task.id,
      payload: { mode: "A", autoMergeSha: workAutoMergeSha, mergeMethod: workMergeMethod, actorType: actor.type },
    });
  }

  // Audit a foreign-deliverable prUrl link — only when the effective repo
  // actually diverges from project.githubRepo (an active override), so
  // ordinary same-repo tasks don't drown the log.
  if (prUrl) {
    const effectiveRepo = effectiveDeliverableRepo(task, task.project);
    if (isForeignDeliverable(task, task.project)) {
      void logAuditEvent({
        action: "task.foreign_pr_linked",
        actorId: actor.type === "human" ? actor.userId : undefined,
        projectId: task.projectId,
        taskId: task.id,
        payload: { prUrl, deliverableRepo: effectiveRepo, projectRepo: task.project.githubRepo, actorType: actor.type, via: "task_finish" },
      });
    }
  }

  // If we just moved the task into a review state, notify potential reviewers
  if (isReviewState(effectiveDefinition, targetStatus)) {
    void emitReviewSignal(
      task.id,
      task.projectId,
      task.claimedByUserId,
      task.claimedByAgentId,
    );
  }

  return c.json({
    kind: "work",
    task: updated,
    targetStatus,
    ...(workAutoMergeSha !== null ? { autoMergeSha: workAutoMergeSha } : {}),
    ...(gateResult.skipped.length > 0 ? { skippedGates: gateResult.skipped } : {}),
  });
});

// ── Agent PR submission (v2 MCP) ─────────────────────────────────────────────
//
// Writes `branchName`, `prUrl`, `prNumber` atomically on a work-claimed task.
// Not a transition. Closes the v2 gap where `task_finish` accepts prUrl but
// not branchName, making `branchPresent`-gated workflows unsatisfiable
// without falling back to the deprecated v1 `tasks_update` path.
//
// Semantics:
// - Caller must hold the work-claim on the task. Review-claim holders are
//   rejected (they already saw the PR; they don't submit it).
// - Task must be in a non-terminal state AND not `open`. Check is
//   polymorphic over the resolved workflow — no hardcoded state names.
//   `open` is rejected because no claim exists yet; terminal states are
//   rejected because the task is done.
// - Re-submission is allowed and overwrites. The audit event records the
//   previous values for diff reconstruction, BUT audit is supplementary per
//   `services/audit.ts` — history is best-effort, not durable.
// - No signal emitted. A broadcast signal would need a concrete recipient
//   rule (none exists today); deferred until there's a real consumer.
// - No gate evaluation — that happens on the next `task_finish` call.
//
// Scope reuses `tasks:transition`. Submitting a PR is strictly weaker than
// finishing, so the existing scope covers it; a narrower `tasks:submit_pr`
// scope is future work if a submitter-only role is ever needed.

taskRouter.post("/tasks/:id/submit-pr", async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type === "agent" && !actor.scopes.includes("tasks:transition")) {
    return forbidden(c, "Missing scope: tasks:transition");
  }

  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    include: {
      workflow: true,
      project: { select: { id: true, name: true, slug: true, teamId: true, githubRepo: true } },
    },
  });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  // Work-claim required. Review-claim holders cannot submit; they review.
  const holdsWorkClaim =
    (actor.type === "human" && task.claimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.claimedByAgentId === actor.tokenId);
  if (!holdsWorkClaim) {
    return forbidden(
      c,
      "You do not hold a work claim on this task. Call task_start to claim it before task_submit_pr.",
    );
  }

  // Polymorphic state check. Resolve the effective workflow (custom
  // workflow → project default row → built-in fallback) and look up the
  // task's current status in its state list. Two rejection paths:
  //
  //   1. Unknown state — the task's status is not defined in the current
  //      workflow definition. This typically means the workflow was
  //      customized while tasks were still in a now-dropped state. Reject
  //      so we don't silently write metadata into a task the workflow
  //      model no longer understands.
  //
  //   2. Terminal state — rejected because the task is done. Whether
  //      `done`, `cancelled`, or any custom terminal label, the flag on
  //      the state itself is the source of truth (no hardcoded names).
  //
  // The holdsWorkClaim check above already rejects tasks in the typical
  // initial state (no claim exists yet), so `open` / custom-initial names
  // don't need a separate literal check here — the claim requirement
  // makes that redundant.
  //
  // Note on `review`: the "review" state is non-terminal in the default
  // workflow and is intentionally allowed when the caller holds the work
  // claim. That supports the rework path where an author re-submits a
  // new branch/PR during or after the request_changes loop. If the task
  // also has an active `reviewClaimedBy*` set, the reviewer will observe
  // the metadata change on their next poll — that's considered safe
  // because reviewers re-read the PR on each approve/request_changes
  // action anyway.
  const effectiveDefinition = await resolveEffectiveDefinition(task, prisma);

  const currentState = effectiveDefinition.states.find((s) => s.name === task.status);
  if (!currentState) {
    return c.json(
      {
        error: "bad_state",
        message: `Task state '${task.status}' is not defined in the effective workflow.`,
      },
      409,
    );
  }
  if (currentState.terminal) {
    return c.json(
      {
        error: "bad_state",
        message: `Cannot submit a PR on a task in terminal state '${task.status}'.`,
      },
      409,
    );
  }

  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = submitPrSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "bad_request", message: parsed.error.message }, 400);
  }
  const { branchName, prUrl, prNumber } = parsed.data;

  // Cross-repo hardening (ADR-0010 §5b/§5c). Same gate as the task_finish
  // branch above — see services/gates/pr-repo-matches-project.ts.
  const crossRepo = checkPrRepoMatchesProject(prUrl, task, task.project);
  if (!crossRepo.ok) {
    return c.json(
      {
        error: "cross_repo_pr_rejected",
        message: prRepoMatchesProjectRejectionMessage(
          crossRepo.prOwner,
          crossRepo.prRepo,
          crossRepo.projectRepo,
        ),
      },
      400,
    );
  }

  // Authorship verification (defense-in-depth, ADR-0010 §7 follow-up):
  // Check that the PR was created by the delegation user. A compromised
  // agent token in the correct repo could otherwise submit someone else's
  // PR and later autoMerge it. Fail-open on GitHub API errors (this is
  // belt-and-braces, not the primary wall, branch protection is).
  //
  // The "delegation user" is now the token-owner when eligible (see
  // findDelegationUser in services/github-delegation.ts). Multi-user teams
  // therefore tie each agent token to its owner's GitHub identity: PRs
  // submitted via this token must be authored by that user. This is a
  // tightening of the prior pool-based behavior, where any pool-admin's
  // login would match. Solo-mode setups are unaffected (one user).
  if (task.project.githubRepo && task.project.teamId) {
    const projectRepo = parseOwnerRepo(task.project.githubRepo);
    if (projectRepo) {
      const delegationUser = await findDelegationUser(task.project.teamId, "allowAgentPrCreate", {
        preferUserId: actor.userId,
      });
      if (delegationUser) {
        try {
          const ghRes = await fetch(
            `https://api.github.com/repos/${projectRepo.owner}/${projectRepo.repo}/pulls/${prNumber}`,
            {
              headers: {
                Authorization: `Bearer ${delegationUser.githubAccessToken}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "agent-tasks-bot",
              },
            },
          );
          if (ghRes.ok) {
            const pr = (await ghRes.json()) as { user?: { login?: string } };
            const prAuthor = pr.user?.login?.toLowerCase();
            const delegationLogin = delegationUser.login.toLowerCase();
            if (prAuthor && prAuthor !== delegationLogin) {
              void logAuditEvent({
                action: "task.pr_submitted",
                projectId: task.projectId,
                taskId: task.id,
                payload: {
                  rejected: true,
                  reason: "pr_author_mismatch",
                  prAuthor: pr.user?.login,
                  delegationLogin: delegationUser.login,
                  prUrl,
                  prNumber,
                },
              });
              return c.json(
                {
                  error: "pr_author_mismatch",
                  message: `PR #${prNumber} was created by '${pr.user?.login}', not by the delegation user '${delegationUser.login}'. Only PRs authored by the delegation user can be submitted.`,
                },
                403,
              );
            }
          }
          // Non-ok responses (404, 403, etc.) → fail open, log for visibility
          if (!ghRes.ok) {
            logger.warn(
              {
                component: "authorship-check",
                ghStatus: ghRes.status,
                prNumber,
                repo: task.project.githubRepo,
              },
              "GitHub API non-ok — skipping authorship check",
            );
          }
        } catch (err) {
          // Network error → fail open
          logger.warn(
            {
              component: "authorship-check",
              prNumber,
              errMessage: err instanceof Error ? err.message : String(err),
            },
            "GitHub API unreachable — skipping authorship check",
          );
        }
      }
    }
  }

  const previousBranchName = task.branchName;
  const previousPrUrl = task.prUrl;
  const previousPrNumber = task.prNumber;

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { branchName, prUrl, prNumber },
    include: taskInclude,
  });

  void logAuditEvent({
    action: "task.pr_submitted",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: {
      actorType: actor.type,
      agentTokenId: actor.type === "agent" ? actor.tokenId : null,
      branchName,
      prUrl,
      prNumber,
      previousBranchName,
      previousPrUrl,
      previousPrNumber,
    },
  });

  // Audit a foreign-deliverable prUrl link — only when the effective repo
  // actually diverges from project.githubRepo (an active override).
  {
    const effectiveRepo = effectiveDeliverableRepo(task, task.project);
    if (isForeignDeliverable(task, task.project)) {
      void logAuditEvent({
        action: "task.foreign_pr_linked",
        actorId: actor.type === "human" ? actor.userId : undefined,
        projectId: task.projectId,
        taskId: task.id,
        payload: { prUrl, deliverableRepo: effectiveRepo, projectRepo: task.project.githubRepo, actorType: actor.type, via: "submit_pr" },
      });
    }
  }

  return c.json({ kind: "submit_pr", task: updated });
});

// ── Agent abandon (v2 MCP) ───────────────────────────────────────────────────
//
// Explicit bail-out. Releases the active claim (work or review) without
// finishing. Work claim → task back to `open`. Review claim → task stays in
// `review` with the review lock cleared so someone else can pick it up.
//
// See ADR 0008.

taskRouter.post("/tasks/:id/abandon", async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type === "agent" && !actor.scopes.includes("tasks:claim")) {
    return forbidden(c, "Missing scope: tasks:claim");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const holdsWorkClaim =
    (actor.type === "human" && task.claimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.claimedByAgentId === actor.tokenId);
  const holdsReviewClaim =
    (actor.type === "human" && task.reviewClaimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.reviewClaimedByAgentId === actor.tokenId);

  if (!holdsWorkClaim && !holdsReviewClaim) {
    return forbidden(
      c,
      "You do not hold a claim on this task. There is nothing to abandon; call task_start first if you intended to pick this task up.",
    );
  }

  const effectiveDef = await resolveEffectiveDefinition(task, prisma);

  // Reject abandoning a work claim while the task is already in review.
  // Clearing the work claim here would leave an orphan: the task stays in
  // review, but `request_changes` relies on the retained work claim to
  // auto-resume the author. Force the author to wait for the reviewer.
  if (holdsWorkClaim && !holdsReviewClaim && isReviewState(effectiveDef, task.status)) {
    return c.json(
      {
        error: "bad_state",
        message:
          "Cannot abandon a work claim while the task is in review. Wait for the reviewer to approve or request changes.",
      },
      409,
    );
  }

  const updateData: Prisma.TaskUncheckedUpdateManyInput = {};
  // Build a holder-guarded where so the clear is an atomic compare-and-swap:
  // holdsWorkClaim/holdsReviewClaim were read at load time, so a stale abandon
  // must not wipe a work/review claim another actor acquired in the race
  // window. Mirrors the /release and /review/release guards.
  const claimGuard: Prisma.TaskWhereInput = { id: task.id };
  if (holdsWorkClaim) {
    updateData.claimedByUserId = null;
    updateData.claimedByAgentId = null;
    updateData.claimedAt = null;
    // Only reset status to initial when we were in a work state.
    // If the task is already in review, we rejected above.
    if (isWorkState(effectiveDef, task.status)) {
      updateData.status = effectiveDef.initialState;
    }
    if (actor.type === "human") claimGuard.claimedByUserId = actor.userId;
    else claimGuard.claimedByAgentId = actor.tokenId;
  }
  if (holdsReviewClaim) {
    updateData.reviewClaimedByUserId = null;
    updateData.reviewClaimedByAgentId = null;
    updateData.reviewClaimedAt = null;
    if (actor.type === "human") claimGuard.reviewClaimedByUserId = actor.userId;
    else claimGuard.reviewClaimedByAgentId = actor.tokenId;
  }

  const abandonResult = await prisma.task.updateMany({
    where: claimGuard,
    data: updateData,
  });
  if (abandonResult.count === 0) {
    return conflict(c, "Your claim on this task is no longer held");
  }

  // updateMany cannot use `include`, so re-fetch the freshly released row.
  const updated = await prisma.task.findUnique({
    where: { id: task.id },
    include: taskInclude,
  });
  if (!updated) return notFound(c);

  void logAuditEvent({
    action: "task.released",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: {
      actorType: actor.type,
      claimType: holdsReviewClaim ? "review" : "work",
      via: "task_abandon",
    },
  });

  return c.json({ task: updated });
});

// ── Task-scoped PR merge (v2 MCP) ────────────────────────────────────────────
//
// Explicit merge verb, intentionally separate from `task_finish { outcome:
// "approve" }`. Splitting approve and merge lets the audit trail distinguish
// "I agree this is done" from "I am the one pushing green on GitHub" — the
// self-merge gate only fires on the latter.
//
// Rules:
//   - requires `github:pr_merge` scope for agent callers
//   - task must be in `review` (or already `done` for idempotent retries)
//   - distinct-reviewer gate (review state only) runs in lockstep with the
//     existing `/github/pull-requests/:n/merge` endpoint
//   - self-merge gate (always): if `requireDistinctReviewer && !soloMode`,
//     the actor who holds the work claim cannot merge
//
// Admin force path: force-transition to `done` first (`POST
// /tasks/:id/transition` with `force: true`), then call this endpoint. The
// `done` entry is idempotent so the merge still happens.

const taskMergeSchema = z.object({
  mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash"),
});

taskRouter.post(
  "/tasks/:id/merge",
  zValidator("json", taskMergeSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;
    if (actor.type === "agent" && !actor.scopes.includes(SCOPES.GithubPrMerge)) {
      return forbidden(c, `Missing scope: ${SCOPES.GithubPrMerge}`);
    }

    const task = await prisma.task.findUnique({
      where: { id: c.req.param("id") },
      include: {
        project: {
          select: {
            id: true,
            teamId: true,
            githubRepo: true,
            requireDistinctReviewer: true,
            soloMode: true,
          },
        },
      },
    });
    if (!task) return notFound(c);
    if (!(await hasProjectAccess(actor, task.projectId))) {
      return forbidden(c, "Access denied to this project");
    }

    // Merging advances task state and merges a PR: a write. PROJECT_VIEWER is
    // read-only and must not merge. Agents are scope-gated above.
    if (!(await requireProjectWrite(actor, task.projectId))) {
      return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
    }

    if (task.status === "open" || task.status === "in_progress") {
      void logAuditEvent({
        action: "task.merge_rejected_bad_status",
        projectId: task.projectId,
        taskId: task.id,
        payload: {
          status: task.status,
          actorType: actor.type,
          agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
          via: "task_merge",
        },
      });
      return c.json(
        {
          error: "bad_state",
          message: `Cannot merge: task is in '${task.status}', expected 'review'. Transition the task to 'review' first.`,
        },
        409,
      );
    }
    if (task.status !== "review" && task.status !== "done") {
      void logAuditEvent({
        action: "task.merge_rejected_bad_status",
        projectId: task.projectId,
        taskId: task.id,
        payload: {
          status: task.status,
          actorType: actor.type,
          agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
          via: "task_merge",
          unknown: true,
        },
      });
      return c.json(
        { error: "bad_state", message: `Cannot merge: task is in '${task.status}'.` },
        409,
      );
    }

    // Self-merge gate runs BEFORE the distinct-reviewer gate. Both would
    // reject an actor==claimant attempt, but the self-merge gate emits the
    // narrower `self_merge_blocked` error code which is the signal callers
    // are expected to key off. The DR gate, if we left it first, would
    // return the broader `forbidden` / "distinct reviewer required" message
    // and the API consumer would have to re-infer the real cause.
    //
    // The self-merge gate also fires on the `done` idempotent-retry path
    // where the DR gate is intentionally skipped — see below.
    const selfMerge = checkSelfMergeGate(task, actor, task.project);
    if (!selfMerge.allowed) {
      void logAuditEvent({
        action: "task.pr_merged.blocked_self_merge",
        projectId: task.projectId,
        taskId: task.id,
        payload: {
          via: "task_merge",
          actorType: actor.type,
          agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
          userId: actor.type === "human" ? actor.userId : undefined,
          claimedByAgentId: task.claimedByAgentId,
          claimedByUserId: task.claimedByUserId,
        },
      });
      return c.json(
        { error: "self_merge_blocked", message: selfMergeRejectionMessage() },
        403,
      );
    }

    // Distinct-reviewer gate — catches the broader "you have no review lock
    // yet" / "the review lock is held by the claimant" cases that the
    // self-merge gate above doesn't cover. Only runs on the review→done
    // path; done→done is an idempotent retry where DR has already run.
    if (task.status === "review") {
      const gate = checkReviewApprovalGate(task, actor, task.project);
      if (!gate.allowed) {
        void logAuditEvent({
          action: "task.review_rejected_self_reviewer",
          projectId: task.projectId,
          taskId: task.id,
          payload: {
            reason: gate.reason,
            actorType: actor.type,
            agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
            endpoint: "task_merge",
            claimedByUserId: task.claimedByUserId,
            claimedByAgentId: task.claimedByAgentId,
            reviewClaimedByUserId: task.reviewClaimedByUserId,
            reviewClaimedByAgentId: task.reviewClaimedByAgentId,
          },
        });
        return c.json(
          { error: "forbidden", message: distinctReviewerRejectionMessage() },
          403,
        );
      }
    }

    const { mergeMethod } = c.req.valid("json");
    const mergeResult = await performPrMerge(task, mergeMethod, actor);
    if (!mergeResult.ok) {
      const status = mergeResult.error === "no_delegation" ? 403 : (mergeResult.status ?? 502);
      return c.json(
        { error: mergeResult.error, message: mergeResult.message },
        status as 400 | 403 | 404 | 405 | 409 | 422 | 500 | 502,
      );
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        status: "done",
        claimedByUserId: null,
        claimedByAgentId: null,
        claimedAt: null,
        reviewClaimedByUserId: null,
        reviewClaimedByAgentId: null,
        reviewClaimedAt: null,
        autoMergeSha: mergeResult.sha,
      },
      include: taskInclude,
    });

    await acknowledgeSignalsForTask(task.id);
    void emitSelfMergeNoticeIfApplicable({
      taskId: task.id,
      projectId: task.projectId,
      actor,
      project: {
        soloMode: task.project.soloMode,
        requireDistinctReviewer: task.project.requireDistinctReviewer,
      },
      mergeSha: mergeResult.sha,
      via: "task_merge",
    });

    void logAuditEvent({
      action: "task.merged",
      actorId: actor.type === "human" ? actor.userId : undefined,
      projectId: task.projectId,
      taskId: task.id,
      payload: {
        via: "task_merge",
        actorType: actor.type,
        agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
        mergeMethod,
        sha: mergeResult.sha,
        alreadyMerged: mergeResult.alreadyMerged,
      },
    });

    return c.json({
      task: updated,
      merged: true,
      sha: mergeResult.sha,
      alreadyMerged: mergeResult.alreadyMerged,
    });
  },
);

// ── Get task ─────────────────────────────────────────────────────────────────

taskRouter.get("/tasks/:id", async (c) => {
  const actor = c.get("actor") as Actor;
  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    include: taskInclude,
  });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  return c.json({ task });
});

// ── Task instructions (agent context) ────────────────────────────────────────

taskRouter.get("/tasks/:id/instructions", async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type === "agent" && !actor.scopes.includes("tasks:read")) {
    return forbidden(c, "Missing scope: tasks:read");
  }

  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    include: {
      workflow: true,
      project: { select: { confidenceThreshold: true, taskTemplate: true, githubRepo: true } },
      ...taskInclude,
    },
  });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  type WorkflowState = { name: string; label: string; terminal: boolean; agentInstructions?: string };
  type WorkflowTransition = { from: string; to: string; label?: string; requiredRole?: string; requires?: string[] };

  // Resolve effective workflow via ADR-0008 §50-56 chain (task → project default → built-in).
  const effectiveDef = await resolveEffectiveDefinition(task, prisma);

  const currentState: WorkflowState | null = effectiveDef.states.find((s) => s.name === task.status) ?? null;
  // Surface `requires` to agents so they know which preconditions to
  // satisfy (set branch, create PR) before attempting the transition.
  const allowedTransitions = effectiveDef.transitions
    .filter((t) => t.from === task.status)
    .map((t) => ({ to: t.to, label: t.label, requires: t.requires }));

  const tpl = task.project.taskTemplate as { fields?: TemplateFields } | null;
  const { score, missing, subscores, findings, inferredTaskType, blocking } = calculateConfidence({
    title: task.title,
    description: task.description,
    templateData: task.templateData as TemplateData | null,
    templateFields: tpl?.fields ?? null,
  });

  // Determine actor permissions
  const scopes = actor.type === "agent" ? actor.scopes : null;
  const canTransition = actor.type === "human" || (scopes?.includes("tasks:transition") ?? false);
  const canUpdate = actor.type === "human" || (scopes?.includes("tasks:update") ?? false);
  const canComment = actor.type === "human" || (scopes?.includes("tasks:comment") ?? false);
  const canClaim = actor.type === "human" || (scopes?.includes("tasks:claim") ?? false);

  // Review actions: available when task is in review and actor is not the claimant
  const isSelfReview =
    (actor.type === "human" && task.claimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.claimedByAgentId === actor.tokenId);
  const reviewActions =
    task.status === "review" && !isSelfReview && canTransition
      ? ["approve", "request_changes"]
      : [];

  // Product decision: review is code review only.
  // Merge, deploy, and production verification may happen in the real world,
  // but they are not separate first-class task states in the default workflow model.
  const workflowModel = {
    reviewScope: "code_review_only",
    externalFollowUps: ["merge", "deploy", "verify"],
    notes:
      "Default task workflow ends at done. Merge, deploy, and production verification are operational follow-ups outside the modeled task states unless a custom workflow models them explicitly.",
  };

  // Recommended next action based on status and context
  let recommendedAction: string | null = null;
  if (task.status === "open" && !task.claimedByUserId && !task.claimedByAgentId) {
    recommendedAction = "Claim this task to start working on it.";
  } else if (task.status === "in_progress" && !task.branchName) {
    recommendedAction = "Create a branch and update branchName.";
  } else if (task.status === "in_progress" && task.branchName && !task.prUrl) {
    recommendedAction = "Open a PR and update prUrl/prNumber.";
  } else if (task.status === "in_progress" && task.prUrl) {
    recommendedAction = "Submit for review when ready.";
  } else if (task.status === "review" && !isSelfReview) {
    recommendedAction = "Review the PR and approve or request changes. Merge/deploy/verify are separate operational follow-ups, not default task states.";
  } else if (task.status === "review" && isSelfReview) {
    recommendedAction = "Wait for review. Once review is complete, the task may be marked done; merge/deploy/verify are tracked operationally outside the default task states.";
  }

  const effectiveAgentInstructions = currentState?.agentInstructions
    ?? (task.status === "review"
      ? "Review is a code-review state. Approve or request changes here. Merge, deploy, and production verification are external follow-up actions unless your project defines a custom workflow for them."
      : null);

  return c.json({
    task,
    currentState,
    agentInstructions: effectiveAgentInstructions,
    allowedTransitions,
    reviewActions,
    recommendedAction,
    workflowModel,
    updatableFields: ["branchName", "prUrl", "prNumber", "result"],
    actorPermissions: { canTransition, canUpdate, canComment, canClaim },
    confidence: {
      score,
      missing,
      threshold: task.project.confidenceThreshold,
      blocking,
      subscores,
      findings,
      inferredTaskType,
    },
    // Cross-repo deliverable override (ADR-0010 §5c). Additive: surfaces the
    // task-level context the pr_repo_matches_project gate actually enforces
    // against (task.deliverableRepo when set, else project.githubRepo).
    crossRepoDeliverable: {
      deliverableRepo: task.deliverableRepo,
      effectiveRepo: effectiveDeliverableRepo(task, task.project),
      overridden: task.deliverableRepo !== null,
      // foreign = the override points OUTSIDE project.githubRepo
      // (case-insensitive); an equal-but-recased override is home.
      foreign: isForeignDeliverable(task, task.project),
    },
  });
});

// ── Update task ───────────────────────────────────────────────────────────────

taskRouter.patch("/tasks/:id", async (c) => {
  const actor = c.get("actor") as Actor;
  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    // githubRepo is needed for the cross-repo guard on prUrl writes below
    // (both actor lanes); deliverableRepo lives on `task` itself (no select
    // restricts it — full scalar row). `workflow` plus the governance
    // columns (teamId/requireDistinctReviewer/soloMode/governanceMode) are
    // needed by the human-lane status-transition enforcement below, which
    // reuses the same resolveEffectiveDefinition / checkReviewApprovalGate /
    // GitHub-delegation pipeline as POST /tasks/:id/transition.
    include: {
      workflow: true,
      project: {
        select: {
          id: true,
          teamId: true,
          githubRepo: true,
          requireDistinctReviewer: true,
          soloMode: true,
          governanceMode: true,
        },
      },
    },
  });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  let rawBody: Record<string, unknown>;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
  }

  if (actor.type === "agent") {
    if (!actor.scopes.includes("tasks:update")) {
      return forbidden(c, "Missing scope: tasks:update");
    }

    // deliverableRepo is human-project-admin-only (ADR-0010 §5c): an agent
    // must never retarget its own task's merge-lifecycle ownership mid-flight.
    const forbiddenFields = ["title", "description", "priority", "status", "dueAt", "templateData", "deliverableRepo"];
    const attempted = Object.keys(rawBody).filter((k) => forbiddenFields.includes(k));
    if (attempted.length > 0) {
      return c.json({ error: "forbidden", message: `Agents cannot update: ${attempted.join(", ")}` }, 403);
    }

    const parsed = agentUpdateTaskSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "bad_request", message: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const body = parsed.data;

    // Cross-repo guard (ADR-0010 §5b/§5c). Compares against the task's
    // EFFECTIVE deliverable repo — agents can't set deliverableRepo (see
    // forbiddenFields above), but a prior admin-set override still applies
    // to their prUrl writes.
    if (body.prUrl) {
      const crossRepo = checkPrRepoMatchesProject(body.prUrl, task, task.project);
      if (!crossRepo.ok) {
        return c.json(
          {
            error: "cross_repo_pr_rejected",
            message: prRepoMatchesProjectRejectionMessage(
              crossRepo.prOwner,
              crossRepo.prRepo,
              crossRepo.projectRepo,
            ),
          },
          400,
        );
      }
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        ...(body.branchName !== undefined ? { branchName: body.branchName } : {}),
        ...(body.prUrl !== undefined ? { prUrl: body.prUrl } : {}),
        ...(body.prNumber !== undefined ? { prNumber: body.prNumber } : {}),
        ...(body.result !== undefined ? { result: body.result } : {}),
        updatedAt: new Date(),
      },
      include: taskInclude,
    });

    if (body.prUrl) {
      const effectiveRepo = effectiveDeliverableRepo(task, task.project);
      if (isForeignDeliverable(task, task.project)) {
        void logAuditEvent({
          action: "task.foreign_pr_linked",
          projectId: task.projectId,
          taskId: task.id,
          payload: { prUrl: body.prUrl, deliverableRepo: effectiveRepo, projectRepo: task.project.githubRepo, actorType: "agent", via: "patch" },
        });
      }
    }

    return c.json({ task: updated });
  }

  // Human path — full update. Write-tier gate: PROJECT_VIEWER is read-only
  // and must not mutate task fields, even though it cleared hasProjectAccess.
  if (!(await requireProjectWrite(actor, task.projectId))) {
    return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
  }

  const parsed = updateTaskSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "bad_request", message: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const body = parsed.data;

  // deliverableRepo is project-admin-only to set OR clear (ADR-0010 §5c):
  // prevents a contributor from silently retargeting a task's merge-
  // automation ownership.
  if (body.deliverableRepo !== undefined) {
    if (!(await isProjectAdmin(actor, task.projectId))) {
      return forbidden(c, "Only project admins may set or clear deliverableRepo");
    }
  }

  // Cross-repo guard, human lane. Uses the PATCH-payload deliverableRepo
  // when this same call is also changing it, so a same-call "set override +
  // link foreign prUrl" doesn't spuriously reject against the stale value.
  if (body.prUrl) {
    const pendingTask = {
      deliverableRepo: body.deliverableRepo !== undefined ? body.deliverableRepo : task.deliverableRepo,
    };
    const crossRepo = checkPrRepoMatchesProject(body.prUrl, pendingTask, task.project);
    if (!crossRepo.ok) {
      return c.json(
        {
          error: "cross_repo_pr_rejected",
          message: prRepoMatchesProjectRejectionMessage(
            crossRepo.prOwner,
            crossRepo.prRepo,
            crossRepo.projectRepo,
          ),
        },
        400,
      );
    }
  }

  // ── Human status write: full workflow-engine enforcement, parity with
  // POST /tasks/:id/transition ────────────────────────────────────────────
  //
  // Previously this endpoint wrote body.status straight to the DB behind
  // nothing but the updateTaskSchema enum constraint: no from→to workflow
  // validation, no requiredRole check, no branchPresent/prPresent/ciGreen
  // preconditions, and no audit trail — while /transition enforces all of
  // it. A CLI/MCP/integration caller PATCHing status directly silently
  // bypassed the whole workflow engine (task 68537f17). This block reuses
  // the same resolveEffectiveDefinition / evaluateTransitionRules /
  // checkReviewApprovalGate primitives /transition uses (rather than a
  // second, drift-prone reimplementation) and supersedes the narrower
  // review→done-only distinct-reviewer check that used to live here.
  //
  // PATCH deliberately does NOT accept `force`/`forceReason`: the audited,
  // admin-only precondition-bypass escape hatch stays exclusive to
  // /transition. A PATCH status write that fails a precondition is
  // rejected outright (422) with a pointer to /transition — never silently
  // forced through.
  //
  // A no-op status (body.status === task.status, e.g. a full-object PATCH
  // that happens to echo the current value back) skips this pipeline
  // entirely: the workflow definition may have no explicit self-loop
  // transition for that state, and gating an unchanged value would reject
  // callers that never intended a transition at all.
  const previousStatus = task.status;
  let didStatusChange = false;
  let statusClaimPatch: Record<string, unknown> = {};
  let isTerminalTransition = false;
  const transitionSkippedGates: Array<{ rule: TransitionRule; reason: string }> = [];

  if (body.status !== undefined && body.status !== previousStatus) {
    const targetStatus = body.status;
    didStatusChange = true;

    const effectiveDef = await resolveEffectiveDefinition(task, prisma);
    const transition = effectiveDef.transitions.find(
      (t) => t.from === previousStatus && t.to === targetStatus,
    );
    if (!transition) {
      return c.json(
        {
          error: "bad_request",
          message: `Transition from '${previousStatus}' to '${targetStatus}' is not allowed by workflow`,
        },
        400,
      );
    }
    let resolvedRequires = transition.requires;
    const requiredRole = transition.requiredRole;

    // Foreign-deliverable skip (ADR-0010 §5c v1), mirrored from
    // /transition: ciGreen/prMerged cannot be evaluated on a repo this
    // project's GitHub token has no standing on. Uses the PENDING
    // (post-write) deliverableRepo, same pattern as the cross-repo prUrl
    // guard above: a same-call "set deliverableRepo + move status" must not
    // evaluate this skip against the stale pre-write value.
    const pendingDeliverableTask = {
      ...task,
      deliverableRepo: body.deliverableRepo !== undefined ? body.deliverableRepo : task.deliverableRepo,
    };
    if (isForeignDeliverable(pendingDeliverableTask, task.project) && resolvedRequires) {
      const githubBacked = resolvedRequires.filter((r) => GITHUB_BACKED_RULES.has(r as never));
      if (githubBacked.length > 0) {
        const effectiveRepo = effectiveDeliverableRepo(pendingDeliverableTask, task.project);
        for (const r of githubBacked) {
          transitionSkippedGates.push({
            rule: r as TransitionRule,
            reason: `Task deliverable is ${effectiveRepo ?? "an external repo"}; this project's GitHub token has no standing there, so '${r}' cannot be evaluated and is treated as satisfied (v1 semantics).`,
          });
        }
        resolvedRequires = resolvedRequires.filter((r) => !GITHUB_BACKED_RULES.has(r as never));
      }
    }

    if (requiredRole && requiredRole !== "any") {
      if (!(await hasProjectRole(actor, task.projectId, requiredRole as ProjectRole))) {
        return forbidden(c, `Requires role: ${requiredRole}`);
      }
    }
    // requiredRole undefined/"any" falls back to the write-tier check
    // already enforced above for the whole PATCH (requireProjectWrite).

    // Distinct-reviewer gate: same structural backstop /transition applies
    // on review → done, now driven by the shared pipeline instead of the
    // narrower inline special case this replaces.
    if (previousStatus === "review" && targetStatus === "done") {
      const gate = checkReviewApprovalGate(task, actor, task.project);
      if (!gate.allowed) {
        void logAuditEvent({
          action: "task.review_rejected_self_reviewer",
          actorId: actor.userId,
          projectId: task.projectId,
          taskId: task.id,
          payload: {
            reason: gate.reason,
            actorType: "human",
            endpoint: "patch",
            claimedByUserId: task.claimedByUserId,
            claimedByAgentId: task.claimedByAgentId,
            reviewClaimedByUserId: task.reviewClaimedByUserId,
            reviewClaimedByAgentId: task.reviewClaimedByAgentId,
          },
        });
        return forbidden(c, distinctReviewerRejectionMessage());
      }
    }

    let githubToken: string | null = null;
    const needsGithub =
      resolvedRequires?.some((r) => GITHUB_BACKED_RULES.has(r as never)) ?? false;
    if (needsGithub && task.project.githubRepo) {
      const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrCreate", {
        preferUserId: actor.userId,
      });
      githubToken = delegate?.githubAccessToken ?? null;
    }

    // Evaluated against the PENDING (post-write) branchName/prUrl/prNumber
    // so a same-call "set branchName + move to review" doesn't spuriously
    // fail branchPresent against the stale pre-write task.
    const { failed, unknown, errors: ruleErrors } = await evaluateTransitionRules(
      resolvedRequires,
      {
        branchName: body.branchName !== undefined ? body.branchName : task.branchName,
        prUrl: body.prUrl !== undefined ? body.prUrl : task.prUrl,
        prNumber: body.prNumber !== undefined ? body.prNumber : task.prNumber,
        projectGithubRepo: task.project.githubRepo,
        githubToken,
      },
    );

    if (failed.length > 0) {
      // No force escape hatch on PATCH — always the "blocked" branch.
      // canForce is always false (unlike /transition's admin-derived
      // hint): this endpoint never accepts force=true.
      return c.json(
        {
          error: "precondition_failed",
          message: `Transition blocked — ${failed
            .map((r) => (ruleErrors[r] ? `${RULE_MESSAGES[r]} (${ruleErrors[r]})` : RULE_MESSAGES[r]))
            .join(" ")} Use POST /tasks/:id/transition with force:true (project admin only) to bypass.`,
          failed: failed.map((r) => ({
            rule: r,
            message: RULE_MESSAGES[r],
            ...(ruleErrors[r] ? { error: ruleErrors[r] } : {}),
          })),
          canForce: false,
        },
        422,
      );
    }

    if (unknown.length > 0) {
      logger.warn(
        { component: "workflow", taskId: task.id, fromStatus: previousStatus, toStatus: targetStatus, unknown },
        "task status patch references unknown rules",
      );
    }

    // Claim-clearing rules, mirrored from /transition: terminal target
    // clears both claims; leaving a review state (non-terminal) clears
    // only the review-claim. Closes the dangling-claim gap this task also
    // flagged: PATCH status='done' used to leave claims untouched.
    isTerminalTransition = isTerminalState(effectiveDef, targetStatus);
    const isLeavingReview =
      !isTerminalTransition && isReviewState(effectiveDef, previousStatus);
    statusClaimPatch = isTerminalTransition
      ? {
          claimedByUserId: null,
          claimedByAgentId: null,
          claimedAt: null,
          reviewClaimedByUserId: null,
          reviewClaimedByAgentId: null,
          reviewClaimedAt: null,
        }
      : isLeavingReview
        ? {
            reviewClaimedByUserId: null,
            reviewClaimedByAgentId: null,
            reviewClaimedAt: null,
          }
        : {};
  }

  let updated;
  try {
    updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt ? new Date(body.dueAt) : null } : {}),
        ...(body.branchName !== undefined ? { branchName: body.branchName } : {}),
        ...(body.prUrl !== undefined ? { prUrl: body.prUrl } : {}),
        ...(body.prNumber !== undefined ? { prNumber: body.prNumber } : {}),
        ...(body.result !== undefined ? { result: body.result } : {}),
        ...(body.templateData !== undefined
          ? { templateData: body.templateData === null ? Prisma.JsonNull : body.templateData }
          : {}),
        ...(body.externalRef !== undefined ? { externalRef: body.externalRef } : {}),
        ...(body.labels !== undefined ? { labels: body.labels } : {}),
        ...(body.deliverableRepo !== undefined ? { deliverableRepo: body.deliverableRepo } : {}),
        ...statusClaimPatch,
        updatedAt: new Date(),
      },
      include: taskInclude,
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return conflict(c, `A task with externalRef "${body.externalRef}" already exists in this project`);
    }
    throw e;
  }

  if (didStatusChange) {
    void logAuditEvent({
      action: "task.transitioned",
      actorId: actor.userId,
      projectId: task.projectId,
      taskId: task.id,
      payload: {
        from: previousStatus,
        to: body.status,
        actorType: "human",
        via: "patch",
        ...(transitionSkippedGates.length > 0 ? { skippedGates: transitionSkippedGates } : {}),
      },
    });
  }

  if (isTerminalTransition) {
    await acknowledgeSignalsForTask(task.id);
  }

  if (body.deliverableRepo !== undefined && body.deliverableRepo !== task.deliverableRepo) {
    void logAuditEvent({
      action: "task.deliverable_repo_changed",
      actorId: actor.userId,
      projectId: task.projectId,
      taskId: task.id,
      payload: { from: task.deliverableRepo, to: body.deliverableRepo, actorType: "human" },
    });
  }

  if (body.prUrl) {
    // The human lane can set/clear deliverableRepo in the SAME PATCH that
    // links the prUrl, so both the condition and the payload must use the
    // pending (post-write) override — gating on the stale task would drop
    // the audit for a same-call set+link and mis-audit a same-call clear.
    const pending = {
      deliverableRepo:
        body.deliverableRepo !== undefined ? body.deliverableRepo : task.deliverableRepo,
    };
    if (isForeignDeliverable(pending, task.project)) {
      void logAuditEvent({
        action: "task.foreign_pr_linked",
        actorId: actor.userId,
        projectId: task.projectId,
        taskId: task.id,
        payload: { prUrl: body.prUrl, deliverableRepo: effectiveDeliverableRepo(pending, task.project), projectRepo: task.project.githubRepo, actorType: "human", via: "patch" },
      });
    }
  }

  return c.json({
    task: updated,
    ...(transitionSkippedGates.length > 0 ? { skippedGates: transitionSkippedGates } : {}),
  });
});

// ── Delete task ───────────────────────────────────────────────────────────────

taskRouter.delete("/tasks/:id", async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type !== "human") {
    return forbidden(c, "Agents cannot delete tasks");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await requireProjectWrite(actor, task.projectId))) {
    return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
  }

  // Reclaim disk for uploaded attachments before the cascade drops their rows;
  // the DB cascade never touches the backing files. URL-pointer attachments
  // have no file (storedFilePath returns null).
  const attachments = await prisma.taskAttachment.findMany({
    where: { taskId: task.id },
    select: { url: true },
  });
  await prisma.task.delete({ where: { id: task.id } });
  for (const a of attachments) {
    const abs = storedFilePath(a.url);
    if (abs) await unlink(abs).catch(() => {});
  }
  return c.json({ success: true });
});

// ── Attachments ───────────────────────────────────────────────────────────────
//
// Two create paths exist. The legacy POST below registers a URL-pointer
// attachment (an external link, no bytes stored). The newer
// POST .../attachments/upload accepts an actual image or text file, stores the
// bytes on the UPLOAD_DIR disk volume, and records metadata. Both are
// human-only; agents produce typed Artifacts instead. See docs/attachments.md.

const ATTACHMENT_FILE_FIELD = "file";

taskRouter.post("/tasks/:id/attachments", zValidator("json", createAttachmentSchema), async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type !== "human") {
    return forbidden(c, "Agents cannot add attachments");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await requireProjectWrite(actor, task.projectId))) {
    return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
  }

  // ── Per-task attachment count cap (URL pointer adds 0 bytes, count-only) ──
  const urlProject = await prisma.project.findUnique({
    where: { id: task.projectId },
    select: { attachmentCountCap: true },
  });
  const urlCountCap =
    urlProject?.attachmentCountCap && urlProject.attachmentCountCap > 0
      ? urlProject.attachmentCountCap
      : ATTACHMENT_MAX_COUNT_PER_TASK;
  const urlExistingCount = await prisma.taskAttachment.count({ where: { taskId: task.id } });
  if (urlExistingCount >= urlCountCap) {
    return c.json(
      {
        error: `Per-task attachment count cap reached (${urlCountCap}); delete attachments or raise the project cap`,
      },
      429,
    );
  }

  const body = c.req.valid("json");
  const attachment = await prisma.taskAttachment.create({
    data: {
      taskId: task.id,
      name: body.name,
      url: body.url,
      type: "DOCUMENT",
      createdByUserId: actor.userId,
    },
  });

  return c.json({ attachment }, 201);
});

// Multipart upload of an image or text file. The `bodyLimit` guards the whole
// request before it is buffered; the per-file 5 MiB cap is re-checked after
// parsing (multipart framing makes the body slightly larger than the file).
taskRouter.post(
  "/tasks/:id/attachments/upload",
  bodyLimit({
    maxSize: ATTACHMENT_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: `File exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit` }, 413),
  }),
  async (c) => {
    const actor = c.get("actor") as Actor;
    if (actor.type !== "human") {
      return forbidden(c, "File upload is human-only; agents produce artifacts");
    }

    const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
    if (!task) return notFound(c);

    if (!(await requireProjectWrite(actor, task.projectId))) {
      return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "Expected a multipart/form-data upload" }, 400);
    }
    const file = form.get(ATTACHMENT_FILE_FIELD);
    if (!(file instanceof File)) {
      return c.json({ error: `Multipart field '${ATTACHMENT_FILE_FIELD}' (a file) is required` }, 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.byteLength === 0) {
      return c.json({ error: "Uploaded file is empty" }, 400);
    }
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      return c.json({ error: `File exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit` }, 413);
    }

    // Sniff the real type from magic bytes; never trust the client Content-Type.
    const detected = detectAttachmentType(buf, file.type);
    if (!detected.ok) {
      return c.json({ error: detected.reason }, 400);
    }

    // ── Per-task aggregate attachment caps ────────────────────────────────────
    // Mirror the artifact cap pattern: load per-project overrides, fall back to
    // env-var module defaults. Enforcement is best-effort / non-atomic: concurrent
    // POSTs can overshoot slightly, which is acceptable for the runaway-loop bound.
    const uploadProject = await prisma.project.findUnique({
      where: { id: task.projectId },
      select: { attachmentCountCap: true, attachmentBytesCap: true },
    });
    const uploadCountCap =
      uploadProject?.attachmentCountCap && uploadProject.attachmentCountCap > 0
        ? uploadProject.attachmentCountCap
        : ATTACHMENT_MAX_COUNT_PER_TASK;
    const uploadBytesCap =
      uploadProject?.attachmentBytesCap && uploadProject.attachmentBytesCap > 0
        ? uploadProject.attachmentBytesCap
        : ATTACHMENT_MAX_TOTAL_BYTES_PER_TASK;

    const uploadExistingCount = await prisma.taskAttachment.count({ where: { taskId: task.id } });
    if (uploadExistingCount >= uploadCountCap) {
      return c.json(
        {
          error: `Per-task attachment count cap reached (${uploadCountCap}); delete attachments or raise the project cap`,
        },
        429,
      );
    }

    const uploadAggregateResult = await prisma.taskAttachment.aggregate({
      where: { taskId: task.id },
      _sum: { sizeBytes: true },
    });
    const uploadExistingSum = uploadAggregateResult._sum.sizeBytes ?? 0;
    if (uploadExistingSum + buf.byteLength > uploadBytesCap) {
      return c.json(
        { error: `Per-task attachment size cap reached (${uploadBytesCap} bytes)` },
        413,
      );
    }

    const nameField = form.get("name");
    const displayName = sanitizeDisplayName(
      typeof nameField === "string" && nameField.length > 0 ? nameField : file.name,
    );

    // Random UUID filename: prevents collisions and path traversal from the
    // original name. The display name lives only in the DB.
    const dir = await ensureUploadDir();
    const stored = storedFilename(randomUUID(), detected.ext);
    const abs = path.join(dir, stored);
    await writeFile(abs, buf);

    let attachment;
    try {
      attachment = await prisma.taskAttachment.create({
        data: {
          taskId: task.id,
          name: displayName,
          url: `/uploads/${stored}`,
          mimeType: detected.mimeType,
          sizeBytes: buf.byteLength,
          type: detected.kind,
          createdByUserId: actor.userId,
        },
        include: {
          createdByUser: { select: { id: true, login: true, name: true, avatarUrl: true } },
        },
      });
    } catch (err) {
      // Never leave an orphan file on disk if the metadata write fails.
      await unlink(abs).catch(() => {});
      throw err;
    }

    void logAuditEvent({
      action: "task.attachment.uploaded",
      actorId: actor.type === "human" ? actor.userId : undefined,
      projectId: task.projectId,
      taskId: task.id,
      payload: {
        actorType: actor.type,
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        type: attachment.type,
      },
    });

    return c.json({ attachment }, 201);
  },
);

// Stream the stored bytes of an uploaded attachment. Auth-gated like every
// other task route (session cookie OR Bearer), so a web `<img src>` works with
// the session cookie alone, no `?token=` needed.
taskRouter.get("/tasks/:id/attachments/:attachmentId/raw", async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type === "agent" && !actor.scopes.includes("tasks:read")) {
    return forbidden(c, "Missing scope: tasks:read");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const attachment = await prisma.taskAttachment.findUnique({
    where: { id: c.req.param("attachmentId") },
  });
  if (!attachment || attachment.taskId !== task.id) return notFound(c);

  // Only uploaded files have bytes on disk; URL-pointer attachments do not.
  // storedFilePath also rejects any value that escapes UPLOAD_DIR.
  const abs = storedFilePath(attachment.url);
  if (!abs) return notFound(c);

  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch {
    // Row exists but the file is gone (manual removal, restore gap): 404 rather
    // than 500, and don't leak the path.
    return notFound(c);
  }

  const kind = attachment.type === "IMAGE" ? "IMAGE" : "DOCUMENT";
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": attachment.mimeType ?? "application/octet-stream",
      "Content-Disposition": contentDisposition(kind, attachment.name),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
});

// Metadata list of a task's attachments (most recent first). Bytes are never
// included; agents read content via the `/content` endpoint below. The full
// task view ships this list too, but a dedicated endpoint keeps the MCP
// `task_attachment_list` payload lean (mirrors the artifacts list).
taskRouter.get("/tasks/:id/attachments", async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type === "agent" && !actor.scopes.includes("tasks:read")) {
    return forbidden(c, "Missing scope: tasks:read");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const attachments = await prisma.taskAttachment.findMany({
    where: { taskId: task.id },
    orderBy: { createdAt: "desc" },
    include: { createdByUser: { select: { id: true, login: true, name: true, avatarUrl: true } } },
  });

  return c.json({ attachments });
});

// Agent-read of one attachment's content: a UTF-8 text excerpt (text/*) or
// base64 (image/*, when ?includeBase64=true). Lets a pipeline stage consume a
// human-uploaded spec, document, or screenshot. ?textByteLimit and
// ?base64ByteLimit cap the returned slice (see attachment-content.ts).
taskRouter.get("/tasks/:id/attachments/:attachmentId/content", async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type === "agent" && !actor.scopes.includes("tasks:read")) {
    return forbidden(c, "Missing scope: tasks:read");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const attachment = await prisma.taskAttachment.findUnique({
    where: { id: c.req.param("attachmentId") },
  });
  if (!attachment || attachment.taskId !== task.id) return notFound(c);

  // storedFilePath returns null for URL-pointer attachments (no bytes) and for
  // any path escaping UPLOAD_DIR; readAttachmentContent maps null to "missing".
  const content = await readAttachmentContent(storedFilePath(attachment.url), attachment.mimeType, {
    includeBase64: parseIncludeBase64Flag(c.req.query("includeBase64")),
    textByteLimit: c.req.query("textByteLimit"),
    base64ByteLimit: c.req.query("base64ByteLimit"),
  });

  return c.json({
    attachment: {
      id: attachment.id,
      taskId: attachment.taskId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      type: attachment.type,
    },
    content,
  });
});

taskRouter.delete("/tasks/:id/attachments/:attachmentId", async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type !== "human") {
    return forbidden(c, "Agents cannot delete attachments");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const attachment = await prisma.taskAttachment.findUnique({
    where: { id: c.req.param("attachmentId") },
  });
  if (!attachment || attachment.taskId !== task.id) {
    return notFound(c);
  }

  // Only the uploader or a project admin may delete (mirrors artifact delete).
  const isCreator = attachment.createdByUserId !== null && attachment.createdByUserId === actor.userId;
  const isAdmin = await hasProjectRole(actor, task.projectId, "ADMIN");
  if (!isCreator && !isAdmin) {
    return forbidden(c, "Only the uploader or a project admin can delete this attachment");
  }

  await prisma.taskAttachment.delete({ where: { id: attachment.id } });

  // Remove the backing file for uploaded attachments (URL pointers have none).
  const abs = storedFilePath(attachment.url);
  if (abs) {
    await unlink(abs).catch(() => {});
  }

  void logAuditEvent({
    action: "task.attachment.deleted",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: { actorType: actor.type, attachmentId: attachment.id, name: attachment.name },
  });

  return c.json({ success: true });
});

// ── Artifacts ─────────────────────────────────────────────────────────────────

const artifactMetaSelect = {
  id: true,
  taskId: true,
  type: true,
  name: true,
  description: true,
  url: true,
  mimeType: true,
  sizeBytes: true,
  createdByUserId: true,
  createdByAgentId: true,
  createdAt: true,
  createdByUser: { select: { id: true, login: true, name: true, avatarUrl: true } },
  createdByAgent: { select: { id: true, name: true } },
} as const;

taskRouter.get("/tasks/:id/artifacts", async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type === "agent" && !actor.scopes.includes("tasks:read")) {
    return forbidden(c, "Missing scope: tasks:read");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const typeFilter = c.req.query("type");
  const where: Prisma.TaskArtifactWhereInput = { taskId: task.id };
  if (typeFilter) {
    const parsed = z.enum(ARTIFACT_TYPES).safeParse(typeFilter);
    if (!parsed.success) {
      return c.json({ error: `Unknown artifact type: ${typeFilter}` }, 400);
    }
    where.type = parsed.data;
  }

  const artifacts = await prisma.taskArtifact.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: artifactMetaSelect,
  });

  return c.json({ artifacts });
});

taskRouter.get("/tasks/:id/artifacts/:artifactId", async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type === "agent" && !actor.scopes.includes("tasks:read")) {
    return forbidden(c, "Missing scope: tasks:read");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const artifact = await prisma.taskArtifact.findUnique({
    where: { id: c.req.param("artifactId") },
    include: {
      createdByUser: { select: { id: true, login: true, name: true, avatarUrl: true } },
      createdByAgent: { select: { id: true, name: true } },
    },
  });
  if (!artifact || artifact.taskId !== task.id) return notFound(c);

  return c.json({ artifact });
});

taskRouter.post("/tasks/:id/artifacts", zValidator("json", createArtifactSchema), async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type === "agent" && !actor.scopes.includes("tasks:update")) {
    return forbidden(c, "Missing scope: tasks:update");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  // Write-tier gate for humans: PROJECT_VIEWER is read-only. Agents are
  // already scope-gated above (tasks:update) and have no read-only tier.
  if (actor.type === "human" && !(await requireProjectWrite(actor, task.projectId))) {
    return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
  }

  const body = c.req.valid("json");
  const sizeBytes = body.content ? Buffer.byteLength(body.content, "utf8") : 0;
  if (sizeBytes > ARTIFACT_MAX_BYTES) {
    return c.json(
      { error: `Artifact exceeds inline size limit of ${ARTIFACT_MAX_BYTES} bytes; use 'url' for larger payloads` },
      413,
    );
  }

  // ── Per-task aggregate caps ──────────────────────────────────────────────
  // Load per-project overrides. A per-project cap wins, but only when it is a
  // positive value; null OR a non-positive (mis-set) cap falls back to the
  // env-var module default — so a stray 0/negative never silently blocks every
  // artifact. Enforcement below is best-effort / non-atomic: concurrent POSTs
  // can overshoot the cap slightly, which is acceptable for the runaway-loop
  // DoS bound this guards.
  const project = await prisma.project.findUnique({
    where: { id: task.projectId },
    select: { artifactCountCap: true, artifactBytesCap: true },
  });
  const countCap =
    project?.artifactCountCap && project.artifactCountCap > 0
      ? project.artifactCountCap
      : ARTIFACT_MAX_COUNT_PER_TASK;
  const bytesCap =
    project?.artifactBytesCap && project.artifactBytesCap > 0
      ? project.artifactBytesCap
      : ARTIFACT_MAX_TOTAL_BYTES_PER_TASK;

  const existingCount = await prisma.taskArtifact.count({ where: { taskId: task.id } });
  if (existingCount >= countCap) {
    return c.json(
      {
        error: `Per-task artifact count cap reached (${countCap}); delete artifacts or raise the project cap`,
      },
      429,
    );
  }

  const aggregateResult = await prisma.taskArtifact.aggregate({
    where: { taskId: task.id },
    _sum: { sizeBytes: true },
  });
  const existingSum = aggregateResult._sum.sizeBytes ?? 0;
  if (existingSum + sizeBytes > bytesCap) {
    return c.json(
      { error: `Per-task artifact size cap reached (${bytesCap} bytes)` },
      413,
    );
  }

  const artifact = await prisma.taskArtifact.create({
    data: {
      taskId: task.id,
      type: body.type,
      name: body.name,
      description: body.description ?? null,
      content: body.content ?? null,
      url: body.url ?? null,
      mimeType: body.mimeType ?? null,
      sizeBytes,
      createdByUserId: actor.type === "human" ? actor.userId : null,
      createdByAgentId: actor.type === "agent" ? actor.tokenId : null,
    },
    include: {
      createdByUser: { select: { id: true, login: true, name: true, avatarUrl: true } },
      createdByAgent: { select: { id: true, name: true } },
    },
  });

  void logAuditEvent({
    action: "task.artifact.created",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: {
      actorType: actor.type,
      artifactId: artifact.id,
      artifactType: artifact.type,
      sizeBytes: artifact.sizeBytes,
    },
  });

  return c.json({ artifact }, 201);
});

taskRouter.delete("/tasks/:id/artifacts/:artifactId", async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type === "agent" && !actor.scopes.includes("tasks:update")) {
    return forbidden(c, "Missing scope: tasks:update");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const artifact = await prisma.taskArtifact.findUnique({
    where: { id: c.req.param("artifactId") },
  });
  if (!artifact || artifact.taskId !== task.id) return notFound(c);

  const isCreator =
    (actor.type === "human" && artifact.createdByUserId === actor.userId) ||
    (actor.type === "agent" && artifact.createdByAgentId === actor.tokenId);
  const isAdmin = actor.type === "human" && (await hasProjectRole(actor, task.projectId, "ADMIN"));
  if (!isCreator && !isAdmin) {
    return forbidden(c, "Only the artifact creator or a project admin can delete this artifact");
  }

  await prisma.taskArtifact.delete({ where: { id: artifact.id } });

  void logAuditEvent({
    action: "task.artifact.deleted",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: { actorType: actor.type, artifactId: artifact.id, artifactType: artifact.type },
  });

  return c.json({ success: true });
});

// ── Comments ─────────────────────────────────────────────────────────────────

const createCommentSchema = z.object({
  content: z.string().min(1).max(5000),
});

taskRouter.post("/tasks/:id/comments", zValidator("json", createCommentSchema), async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type === "agent" && !actor.scopes.includes("tasks:comment")) {
    return forbidden(c, "Missing scope: tasks:comment");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  // Write-tier gate for humans: PROJECT_VIEWER is read-only and may not
  // author comments. Agents are scope-gated above (tasks:comment).
  if (actor.type === "human" && !(await requireProjectWrite(actor, task.projectId))) {
    return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
  }

  const { content } = c.req.valid("json");
  const comment = await prisma.comment.create({
    data: {
      taskId: task.id,
      content,
      authorUserId: actor.type === "human" ? actor.userId : null,
      authorAgentId: actor.type === "agent" ? actor.tokenId : null,
    },
    include: {
      authorUser: { select: { id: true, login: true, name: true, avatarUrl: true } },
      authorAgent: { select: { id: true, name: true } },
    },
  });

  void logAuditEvent({
    action: "task.commented",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: { actorType: actor.type, commentId: comment.id },
  });

  return c.json({ comment }, 201);
});

taskRouter.delete("/tasks/:id/comments/:commentId", async (c) => {
  const actor = c.get("actor") as Actor;
  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const comment = await prisma.comment.findUnique({ where: { id: c.req.param("commentId") } });
  if (!comment || comment.taskId !== task.id) return notFound(c);

  const isAuthor =
    (actor.type === "human" && comment.authorUserId === actor.userId) ||
    (actor.type === "agent" && comment.authorAgentId === actor.tokenId);

  if (!isAuthor) {
    return forbidden(c, "Only the comment author can delete this comment");
  }

  await prisma.comment.delete({ where: { id: comment.id } });
  return c.json({ success: true });
});

// ── Dependencies ─────────────────────────────────────────────────────────────

/** BFS cycle detection: would adding blocker → task create a cycle? */
async function wouldCreateCycle(taskId: string, blockerTaskId: string): Promise<boolean> {
  // If adding blockerTaskId as a dependency of taskId, check whether
  // taskId is already (transitively) blocking blockerTaskId.
  const visited = new Set<string>();
  const queue = [taskId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === blockerTaskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const downstream = await prisma.task.findMany({
      where: { blockedBy: { some: { id: current } } },
      select: { id: true },
    });
    for (const d of downstream) {
      queue.push(d.id);
    }
  }

  return false;
}

const dependencySchema = z.object({
  blockedByTaskId: z.string().uuid(),
});

taskRouter.post("/tasks/:id/dependencies", zValidator("json", dependencySchema), async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type !== "human") {
    return forbidden(c, "Only humans can manage dependencies");
  }

  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    include: { blockedBy: { select: { id: true } } },
  });
  if (!task) return notFound(c);

  if (!(await requireProjectWrite(actor, task.projectId))) {
    return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
  }

  const { blockedByTaskId } = c.req.valid("json");
  if (blockedByTaskId === task.id) {
    return c.json({ error: "bad_request", message: "A task cannot block itself" }, 400);
  }

  // Check duplicate
  if (task.blockedBy.some((d) => d.id === blockedByTaskId)) {
    return c.json({ error: "bad_request", message: "Dependency already exists" }, 400);
  }

  const blocker = await prisma.task.findUnique({ where: { id: blockedByTaskId } });
  if (!blocker || blocker.projectId !== task.projectId) {
    return c.json({ error: "bad_request", message: "Blocking task not found in this project" }, 400);
  }

  // Cycle detection
  if (await wouldCreateCycle(task.id, blockedByTaskId)) {
    return c.json({ error: "bad_request", message: "Adding this dependency would create a cycle" }, 400);
  }

  await prisma.task.update({
    where: { id: task.id },
    data: { blockedBy: { connect: { id: blockedByTaskId } } },
  });

  return c.json({ success: true }, 201);
});

taskRouter.delete("/tasks/:id/dependencies/:blockerTaskId", async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type !== "human") {
    return forbidden(c, "Only humans can manage dependencies");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await requireProjectWrite(actor, task.projectId))) {
    return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
  }

  await prisma.task.update({
    where: { id: task.id },
    data: { blockedBy: { disconnect: { id: c.req.param("blockerTaskId") } } },
  });

  return c.json({ success: true });
});

// ── Claim task ────────────────────────────────────────────────────────────────

taskRouter.post("/tasks/:id/claim", async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type === "agent" && !actor.scopes.includes("tasks:claim")) {
    return forbidden(c, "Missing scope: tasks:claim");
  }

  // Project fields needed by the transition-gate evaluator (teamId,
  // githubRepo) so branchPresent / ciGreen etc. get enforced on this
  // path too — previously this handler silently bypassed every
  // workflow-level precondition that MCP `task_start` enforces.
  //
  // `workflow: true` is required for task-level workflowId routing:
  // `resolveEffectiveDefinition` only honors the task-attached
  // workflow when `task.workflow` is populated. Without this include,
  // tasks with an explicit workflowId silently fall through to the
  // project-default definition — the exact parity-gap bug the `/start`
  // handler (line 647-664) already guards against.
  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    include: {
      workflow: true,
      project: {
        select: {
          teamId: true,
          githubRepo: true,
          confidenceThreshold: true,
          taskTemplate: true,
          enforcementMode: true,
        },
      },
    },
  });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  // Claiming sets the worker and advances status: a write. PROJECT_VIEWER is
  // read-only and must not claim. Agents are scope-gated above (tasks:claim).
  if (!(await requireProjectWrite(actor, task.projectId))) {
    return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
  }

  // Already claimed
  if (task.claimedByUserId || task.claimedByAgentId) {
    return conflict(c, "Task is already claimed");
  }

  // Dependency gate — all blocking tasks must be done
  const blockers = await prisma.task.findMany({
    where: { blocks: { some: { id: task.id } } },
    select: { id: true, title: true, status: true },
  });
  const unresolved = blockers.filter((dep) => dep.status !== "done");
  if (unresolved.length > 0) {
    return c.json({
      error: "blocked",
      message: "Task is blocked by unresolved dependencies",
      blockedBy: unresolved,
    }, 409);
  }

  // Confidence gate (ADR-0011). Emits audit events on block / override,
  // validates force=true requires forceReason (>=10 chars). See
  // services/confidence-gate.ts.
  const gate = await evaluateConfidenceGate(c, task, actor, "claim");
  if (!gate.ok) return gate.response;

  const effectiveDef = await resolveEffectiveDefinition(task, prisma);
  const startTarget =
    firstTransitionTarget(effectiveDef, effectiveDef.initialState) ?? "in_progress";

  // Transition-rule gates (branchPresent / prPresent / ciGreen / prMerged).
  // Before this block, /claim silently bypassed every workflow gate —
  // MCP `task_start` enforced them but any caller hitting REST directly
  // (CLI tools, webhooks, the web UI, automation) could put a task into
  // `in_progress` with branchName:null, breaking downstream assumptions
  // (PR creation expects branchName; merge reads branchName).
  //
  // Shape matches the /tasks/:id/start handler at line 757 so parity is
  // visible from a diff. Force-bypass is intentionally NOT exposed here:
  // this route predates v2 and adding it is a separate decision. Use
  // /tasks/:id/start with `force=true` + forceReason when you need the
  // bypass.
  const gateResult = await evaluateV2TransitionGates(
    task,
    { branchName: task.branchName, prUrl: task.prUrl, prNumber: task.prNumber },
    startTarget,
    actor,
    effectiveDef,
  );
  if (!gateResult.ok) {
    if (gateResult.kind === "no_transition") {
      return c.json({ error: "bad_request", message: gateResult.message }, 400);
    }
    if (gateResult.kind === "forbidden_role") {
      return forbidden(c, `Requires role: ${gateResult.requiredRole}`);
    }
    if (gateResult.kind === "precondition") {
      const { failed, ruleErrors } = gateResult;
      return c.json(
        {
          error: "precondition_failed",
          message: `Transition blocked — ${failed
            .map((r) =>
              ruleErrors[r] ? `${RULE_MESSAGES[r]} (${ruleErrors[r]})` : RULE_MESSAGES[r],
            )
            .join(" ")}`,
          failed: failed.map((r) => ({
            rule: r,
            message: RULE_MESSAGES[r],
            ...(ruleErrors[r] ? { error: ruleErrors[r] } : {}),
          })),
          canForce: false,
        },
        422,
      );
    }
    const _exhaustive: never = gateResult;
    return _exhaustive;
  }

  // Atomic compare-and-swap: only write the claim if the row is still
  // unclaimed. The earlier `task.claimedBy*` null-check above is a fast
  // path, but two actors can both pass it before either writes (TOCTOU).
  // Guarding the write on `claimedBy* IS NULL` makes exactly one writer win;
  // the loser sees count===0 and gets a 409.
  const claimResult = await prisma.task.updateMany({
    where: { id: task.id, claimedByUserId: null, claimedByAgentId: null },
    data: {
      claimedByUserId: actor.type === "human" ? actor.userId : null,
      claimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
      claimedAt: new Date(),
      status: startTarget,
    },
  });
  if (claimResult.count === 0) {
    return conflict(c, "Task is already claimed");
  }

  // updateMany cannot use `include`, so re-fetch the freshly claimed row.
  const updated = await prisma.task.findUnique({
    where: { id: task.id },
    include: taskInclude,
  });
  if (!updated) return notFound(c);

  void logAuditEvent({
    action: "task.claimed",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: { actorType: actor.type, actorId: actor.type === "agent" ? actor.tokenId : actor.userId },
  });

  return c.json({ task: updated });
});

// ── Release task ──────────────────────────────────────────────────────────────

taskRouter.post("/tasks/:id/release", async (c) => {
  const actor = c.get("actor") as Actor;
  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  // Only current claimant can release
  const isClaimant =
    (actor.type === "human" && task.claimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.claimedByAgentId === actor.tokenId);

  if (!isClaimant) {
    return forbidden(c, "Only the current claimant can release this task");
  }

  const effectiveDef = await resolveEffectiveDefinition(task, prisma);

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      claimedByUserId: null,
      claimedByAgentId: null,
      claimedAt: null,
      status: effectiveDef.initialState,
    },
    include: taskInclude,
  });

  void logAuditEvent({
    action: "task.released",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: { actorType: actor.type },
  });

  return c.json({ task: updated });
});

// ── Admin release: force-release a work/review claim held by ANYONE ─────────
//
// Human-project-admin-only escape hatch for a stuck claim. Unlike the
// self-service /release above (which resets task.status to the workflow's
// initialState), this endpoint deliberately leaves task.status UNCHANGED —
// the admin drives status separately via the existing
// POST /tasks/:id/transition{force:true} path. CAS-guarded like every other
// claim mutation in this file (see /release and /abandon above) so a
// concurrent claim/release cannot be silently clobbered.
//
// Response shape (stable contract — the frontend depends on this exact
// shape): { task: <standard taskInclude row>, released: { workClaim: boolean,
// reviewClaim: boolean } }. Each `released.*` flag is true only when a claim
// was ACTUALLY cleared by this call (updateMany count > 0). A requested
// release that finds no claim to clear (already released, or lost a race) is
// a 200 idempotent no-op for that claim — reflected via `released.*: false`
// — never a 404/409 for the whole call.
const adminReleaseSchema = z.object({
  releaseWorkClaim: z.boolean().optional(),
  releaseReviewClaim: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

taskRouter.post(
  "/tasks/:id/admin-release",
  zValidator("json", adminReleaseSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;
    if (actor.type !== "human") {
      return forbidden(c, "Agents cannot admin-release claims");
    }

    const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
    if (!task) return notFound(c);

    if (!(await isProjectAdmin(actor, task.projectId))) {
      return forbidden(c, "Only project admins can release another actor's claim");
    }

    const body = c.req.valid("json");
    if (!body.releaseWorkClaim && !body.releaseReviewClaim) {
      return c.json({ error: "bad_request", message: "nothing to release" }, 400);
    }

    const released = { workClaim: false, reviewClaim: false };

    if (body.releaseWorkClaim) {
      // priorHolder is the claim observed at load time. Only attempt a release
      // when a claim actually exists in the snapshot, and PIN the CAS guard to
      // that exact holder: if the claim changed hands (holder released, another
      // actor re-claimed) between this snapshot and the write, the pinned where
      // matches nothing (count 0), so we neither clobber the new claimant nor
      // log a stale priorHolder. An "any claim present" guard would do both.
      const priorHolder = task.claimedByUserId
        ? { type: "human" as const, id: task.claimedByUserId }
        : task.claimedByAgentId
          ? { type: "agent" as const, id: task.claimedByAgentId }
          : null;
      if (priorHolder) {
        const result = await prisma.task.updateMany({
          where:
            priorHolder.type === "human"
              ? { id: task.id, claimedByUserId: priorHolder.id }
              : { id: task.id, claimedByAgentId: priorHolder.id },
          data: { claimedByUserId: null, claimedByAgentId: null, claimedAt: null },
        });
        if (result.count > 0) {
          released.workClaim = true;
          void logAuditEvent({
            action: "task.claim_released_by_admin",
            actorId: actor.userId,
            projectId: task.projectId,
            taskId: task.id,
            payload: { priorHolder, reason: body.reason ?? null },
          });
        }
      }
    }

    if (body.releaseReviewClaim) {
      const priorHolder = task.reviewClaimedByUserId
        ? { type: "human" as const, id: task.reviewClaimedByUserId }
        : task.reviewClaimedByAgentId
          ? { type: "agent" as const, id: task.reviewClaimedByAgentId }
          : null;
      if (priorHolder) {
        const result = await prisma.task.updateMany({
          where:
            priorHolder.type === "human"
              ? { id: task.id, reviewClaimedByUserId: priorHolder.id }
              : { id: task.id, reviewClaimedByAgentId: priorHolder.id },
          data: { reviewClaimedByUserId: null, reviewClaimedByAgentId: null, reviewClaimedAt: null },
        });
        if (result.count > 0) {
          released.reviewClaim = true;
          void logAuditEvent({
            action: "task.review_claim_released_by_admin",
            actorId: actor.userId,
            projectId: task.projectId,
            taskId: task.id,
            payload: { priorHolder, reason: body.reason ?? null },
          });
        }
      }
    }

    // updateMany cannot use `include`, so re-fetch the (possibly) freshly
    // released row once, after both requested releases are attempted.
    const updated = await prisma.task.findUnique({ where: { id: task.id }, include: taskInclude });
    if (!updated) return notFound(c);

    return c.json({ task: updated, released });
  },
);

// ── Transition task status ────────────────────────────────────────────────────

taskRouter.post(
  "/tasks/:id/transition",
  zValidator("json", transitionSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;

    if (actor.type === "agent" && !actor.scopes.includes("tasks:transition")) {
      return forbidden(c, "Missing scope: tasks:transition");
    }

    const task = await prisma.task.findUnique({
      where: { id: c.req.param("id") },
      include: { workflow: true, project: true },
    });
    if (!task) return notFound(c);

    if (!(await hasProjectAccess(actor, task.projectId))) {
      return forbidden(c, "Access denied to this project");
    }

    const { status, force, forceReason } = c.req.valid("json");
    const previousStatus = task.status;
    let forcedRules: TransitionRule[] = [];

    // Force-transitions are admin-only, independent of whether the workflow
    // preconditions would have tripped. Previously the admin check was
    // nested inside `if (failed.length > 0)`, which meant any user with
    // `tasks:transition` could self-approve by adding `force: true` whenever
    // the task had no failing preconditions — bypassing the distinct-reviewer
    // gate below. Lifting the check here makes force a true escape hatch
    // that only project admins can reach.
    if (force && !(await isProjectAdmin(actor, task.projectId))) {
      return forbidden(c, "Only team admins can force a transition");
    }

    // Resolve the effective workflow following the ADR-0008 §50-56 chain:
    //   1. task.workflowId → that Workflow row
    //   2. project-default Workflow row (isDefault: true)
    //   3. built-in defaultWorkflowDefinition()
    const effectiveDef = await resolveEffectiveDefinition(task, prisma);
    const transition = effectiveDef.transitions.find(
      (t) => t.from === task.status && t.to === status,
    );
    if (!transition) {
      return c.json(
        { error: "bad_request", message: `Transition from '${task.status}' to '${status}' is not allowed by workflow` },
        400,
      );
    }
    let resolvedRequires = transition.requires;
    const requiredRole = transition.requiredRole;

    // Foreign-deliverable skip (ADR-0010 §5c v1) — parity with
    // evaluateV2TransitionGates: ciGreen/prMerged cannot be evaluated on a
    // repo this project's GitHub token has no standing on. Without this,
    // MCP tasks_transition (which lands here, not on /finish) would re-create
    // the exact cross-repo deadlock this mechanism exists to solve.
    const transitionSkippedGates: Array<{ rule: TransitionRule; reason: string }> = [];
    if (isForeignDeliverable(task, task.project) && resolvedRequires) {
      const githubBacked = resolvedRequires.filter((r) => GITHUB_BACKED_RULES.has(r as never));
      if (githubBacked.length > 0) {
        const effectiveRepo = effectiveDeliverableRepo(task, task.project);
        for (const r of githubBacked) {
          transitionSkippedGates.push({
            rule: r as TransitionRule,
            reason: `Task deliverable is ${effectiveRepo ?? "an external repo"}; this project's GitHub token has no standing there, so '${r}' cannot be evaluated and is treated as satisfied (v1 semantics).`,
          });
        }
        resolvedRequires = resolvedRequires.filter((r) => !GITHUB_BACKED_RULES.has(r as never));
      }
    }

    // A status transition is always a state mutation. Even when the workflow
    // sets no concrete requiredRole (undefined / "any"), the actor must hold
    // the write tier: PROJECT_VIEWER is read-only and must not transition
    // tasks. Agents and every team / project write role still pass.
    if (requiredRole && requiredRole !== "any") {
      if (!(await hasProjectRole(actor, task.projectId, requiredRole as ProjectRole))) {
        return forbidden(c, `Requires role: ${requiredRole}`);
      }
    } else if (!(await requireProjectWrite(actor, task.projectId))) {
      return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
    }

    // Distinct-reviewer gate. Opt-in per project (default off for backward
    // compatibility). Evaluated BEFORE the precondition rules so that a
    // rejected self-review does not trigger a GitHub round-trip (ciGreen /
    // prMerged checks). force=true is an admin-only escape hatch and is
    // already verified at the top of the handler.
    if (previousStatus === "review" && status === "done" && !force) {
      const gate = checkReviewApprovalGate(task, actor, task.project);
      if (!gate.allowed) {
        void logAuditEvent({
          action: "task.review_rejected_self_reviewer",
          actorId: actor.type === "human" ? actor.userId : undefined,
          projectId: task.projectId,
          taskId: task.id,
          payload: {
            reason: gate.reason,
            actorType: actor.type,
            agentTokenId: actor.type === "agent" ? actor.tokenId : null,
            endpoint: "transition",
            claimedByUserId: task.claimedByUserId,
            claimedByAgentId: task.claimedByAgentId,
            reviewClaimedByUserId: task.reviewClaimedByUserId,
            reviewClaimedByAgentId: task.reviewClaimedByAgentId,
          },
        });
        return forbidden(c, distinctReviewerRejectionMessage());
      }
    }

    // Precondition checks: branch present, PR present, CI green, etc.
    // Unknown rules are reported but do NOT block — keeps workflows
    // forward-compatible across backend versions if an operator mistyped
    // a rule name. Async rules (ciGreen) are evaluated in parallel with
    // sync ones; a network failure inside an async rule counts as "failed
    // closed" with a friendly error message propagated to the client.
    //
    // Resolve a GitHub delegation token once for the rule context. Only
    // looked up when the workflow actually references a rule that needs
    // GitHub (per GITHUB_BACKED_RULES) — avoids a DB round-trip on the
    // fast path for every transition that only has sync rules. The
    // project record (including teamId) is already loaded on `task`, so
    // no extra query is needed to resolve the team.
    let githubToken: string | null = null;
    const needsGithub =
      resolvedRequires?.some((r) =>
        GITHUB_BACKED_RULES.has(r as never),
      ) ?? false;
    if (needsGithub && task.project.githubRepo) {
      const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrCreate", {
        preferUserId: actor.userId,
      });
      githubToken = delegate?.githubAccessToken ?? null;
    }

    const { failed, unknown, errors: ruleErrors } = await evaluateTransitionRules(
      resolvedRequires,
      {
        branchName: task.branchName,
        prUrl: task.prUrl,
        prNumber: task.prNumber,
        projectGithubRepo: task.project.githubRepo,
        githubToken,
      },
    );

    if (failed.length > 0) {
      if (!force) {
        // Admin-ness is inferred from the fact that the actor got past the
        // top-of-handler force check — if they could send force=true they
        // would be admin, so we can advertise the canForce hint without an
        // extra DB round-trip here. Non-admins see canForce: false.
        const isAdmin = await isProjectAdmin(actor, task.projectId);
        return c.json(
          {
            error: "precondition_failed",
            message: `Transition blocked — ${failed
              .map((r) => ruleErrors[r] ? `${RULE_MESSAGES[r]} (${ruleErrors[r]})` : RULE_MESSAGES[r])
              .join(" ")}`,
            failed: failed.map((r) => ({
              rule: r,
              message: RULE_MESSAGES[r],
              ...(ruleErrors[r] ? { error: ruleErrors[r] } : {}),
            })),
            canForce: isAdmin,
          },
          422,
        );
      }
      // force=true + admin already verified at the top of the handler.
      forcedRules = failed;
    }

    if (unknown.length > 0) {
      logger.warn(
        { component: "workflow", taskId: task.id, fromStatus: task.status, toStatus: status, unknown },
        "task transition references unknown rules",
      );
    }

    // Claim-clearing rules (applied atomically with the status write):
    //
    // 1. Terminal target: clear BOTH work-claim and review-claim. Mirrors the
    //    task_finish review-approve path so no stale claim occupies a slot on a
    //    finished task.
    //
    // 2. Non-terminal exit from a review state (e.g. review -> in_progress):
    //    clear the review-claim only — work-claim is kept so the author can
    //    resume. Mirrors task_finish request_changes which also nulls
    //    reviewClaimedBy*/At; without this a raw /transition kickback leaves a
    //    stale review-claim until cleared elsewhere.
    //
    // 3. All other non-terminal transitions: leave both claims untouched.
    const isTerminal = isTerminalState(effectiveDef, status);
    // `status !== previousStatus` keeps a (custom-workflow) review->review
    // self-loop in branch 3: it is not actually LEAVING review, so the
    // review-claim must survive. Default workflows have no such self-loop.
    const isLeavingReview =
      !isTerminal &&
      status !== previousStatus &&
      isReviewState(effectiveDef, previousStatus);
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        status,
        updatedAt: new Date(),
        ...(isTerminal
          ? {
              claimedByUserId: null,
              claimedByAgentId: null,
              claimedAt: null,
              reviewClaimedByUserId: null,
              reviewClaimedByAgentId: null,
              reviewClaimedAt: null,
            }
          : isLeavingReview
            ? {
                reviewClaimedByUserId: null,
                reviewClaimedByAgentId: null,
                reviewClaimedAt: null,
              }
            : {}),
      },
      include: taskInclude,
    });

    // Ack BEFORE emitting outcome signals below — those must survive past
    // the task's terminal state, so we ack the pending work/review asks first.
    // Uses isTerminal (not a hardcoded "done" check) so custom terminal states
    // defined in project workflows are handled correctly.
    if (isTerminal) {
      await acknowledgeSignalsForTask(task.id);
    }

    void logAuditEvent({
      action: forcedRules.length > 0 ? "task.transitioned.forced" : "task.transitioned",
      actorId: actor.type === "human" ? actor.userId : undefined,
      projectId: task.projectId,
      taskId: task.id,
      payload: {
        from: previousStatus,
        to: status,
        actorType: actor.type,
        ...(forcedRules.length > 0
          ? { forcedRules, forceReason: forceReason ?? null }
          : {}),
        ...(transitionSkippedGates.length > 0
          ? { skippedGates: transitionSkippedGates }
          : {}),
      },
    });

    // Notify the task's claimant and active reviewer when an admin has
    // bypassed one or more gates. Sent even when `forceReason` is empty
    // so the override is visible without reading the audit log. Safe to
    // fire before review-signal emission below because signals are
    // independent.
    if (forcedRules.length > 0 && actor.type === "human") {
      void emitForceTransitionedSignal({
        taskId: task.id,
        projectId: task.projectId,
        from: previousStatus,
        to: status,
        forcedRules,
        forceReason: forceReason ?? null,
        forcedByUserId: actor.userId,
      });
    }

    // Emit review signal when entering review state
    if (status === "review" && previousStatus !== "review") {
      void emitReviewSignal(
        task.id,
        task.projectId,
        task.claimedByUserId,
        task.claimedByAgentId,
      );
    }

    // Emit task_available signal when transitioning to open (e.g., reopened)
    if (status === "open" && previousStatus !== "open") {
      const actorName = actor.type === "agent"
        ? (await prisma.agentToken.findUnique({ where: { id: actor.tokenId }, select: { name: true } }))?.name ?? "Agent"
        : (await prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))?.name ?? "Human";
      void emitTaskAvailableSignal(task.id, task.projectId, actor.type, actorName);
    }

    return c.json({
      task: updated,
      ...(transitionSkippedGates.length > 0
        ? { skippedGates: transitionSkippedGates }
        : {}),
    });
  },
);

// ── Review task (approve / request changes) ──────────────────────────────────

const reviewSchema = z.object({
  action: z.enum(["approve", "request_changes"]),
  comment: z.string().max(5000).optional(),
});

taskRouter.post(
  "/tasks/:id/review",
  zValidator("json", reviewSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;

    if (actor.type === "agent" && !actor.scopes.includes("tasks:transition")) {
      return forbidden(c, "Missing scope: tasks:transition");
    }

    const task = await prisma.task.findUnique({
      where: { id: c.req.param("id") },
      include: {
        project: { select: { requireDistinctReviewer: true, soloMode: true } },
      },
    });
    if (!task) return notFound(c);

    if (!(await hasProjectAccess(actor, task.projectId))) {
      return forbidden(c, "Access denied to this project");
    }

    // Approving / requesting changes transitions task state: a write.
    // PROJECT_VIEWER is read-only. Agents are scope-gated above.
    if (!(await requireProjectWrite(actor, task.projectId))) {
      return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
    }

    if (task.status !== "review") {
      return c.json({ error: "bad_request", message: "Task must be in review status" }, 400);
    }

    // Reviewer must not be the same as the claimant (no self-review),
    // and a review lock must already exist (no skipping `/review/claim`).
    // soloMode and !requireDistinctReviewer projects bypass this — see
    // checkReviewApprovalGate in services/review-gate.ts.
    {
      const gate = checkReviewApprovalGate(task, actor, task.project);
      if (!gate.allowed) {
        return forbidden(c, "Cannot review your own task");
      }
    }

    // Single-reviewer lock: only one reviewer at a time
    const actorId = actor.type === "human" ? actor.userId : actor.tokenId;
    const isCurrentReviewer =
      (actor.type === "human" && task.reviewClaimedByUserId === actor.userId) ||
      (actor.type === "agent" && task.reviewClaimedByAgentId === actor.tokenId);
    const isReviewLocked = task.reviewClaimedByUserId || task.reviewClaimedByAgentId;

    if (isReviewLocked && !isCurrentReviewer) {
      return conflict(c, "Task is already being reviewed by another reviewer");
    }

    const { action, comment: reviewComment } = c.req.valid("json");
    const newStatus = action === "approve" ? "done" : "in_progress";

    // Create review comment first so it's included in the response
    if (reviewComment?.trim()) {
      const prefix = action === "approve" ? "Approved" : "Changes requested";
      await prisma.comment.create({
        data: {
          taskId: task.id,
          content: `[${prefix}] ${reviewComment.trim()}`,
          authorUserId: actor.type === "human" ? actor.userId : null,
          authorAgentId: actor.type === "agent" ? actor.tokenId : null,
        },
      });
    }

    // Complete review: transition status and clear review lock
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        status: newStatus,
        reviewClaimedByUserId: null,
        reviewClaimedByAgentId: null,
        reviewClaimedAt: null,
        updatedAt: new Date(),
      },
      include: taskInclude,
    });

    // Ack BEFORE emitting `task_approved` below, which is deliberately
    // emitted against a terminal task and must survive.
    if (newStatus === "done") {
      await acknowledgeSignalsForTask(task.id);
    }

    void logAuditEvent({
      action: "task.reviewed",
      actorId: actor.type === "human" ? actor.userId : undefined,
      projectId: task.projectId,
      taskId: task.id,
      payload: { reviewAction: action, from: "review", to: newStatus, actorType: actor.type, reviewerId: actorId },
    });

    // Emit durable signals to the original assignee
    const reviewerName = actor.type === "agent"
      ? (await prisma.agentToken.findUnique({ where: { id: actor.tokenId }, select: { name: true } }))?.name ?? "Agent"
      : (await prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))?.name ?? "Reviewer";

    if (action === "request_changes") {
      void emitChangesRequestedSignal(
        task.id, task.projectId,
        task.claimedByUserId, task.claimedByAgentId,
        reviewerName, reviewComment,
      );
    } else if (action === "approve") {
      void emitTaskApprovedSignal(
        task.id, task.projectId,
        task.claimedByUserId, task.claimedByAgentId,
        reviewerName, reviewComment,
      );
    }

    return c.json({ task: updated });
  },
);

// ── Claim review (review lock) ──────────────────────────────────────────────

taskRouter.post("/tasks/:id/review/claim", async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type === "agent" && !actor.scopes.includes("tasks:transition")) {
    return forbidden(c, "Missing scope: tasks:transition");
  }

  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    include: {
      project: { select: { requireDistinctReviewer: true, soloMode: true } },
    },
  });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  // Acquiring the review lock is a write. PROJECT_VIEWER is read-only and
  // must not review. Agents are scope-gated above.
  if (!(await requireProjectWrite(actor, task.projectId))) {
    return forbidden(c, "Requires write access (PROJECT_VIEWER is read-only)");
  }

  if (task.status !== "review") {
    return c.json({ error: "bad_request", message: "Task must be in review status" }, 400);
  }

  // No self-review — bypassed in soloMode and when the project opts out of
  // requireDistinctReviewer (same flag-aware gate as the other endpoints).
  {
    const gate = checkDistinctReviewerGate(task, actor, task.project);
    if (!gate.allowed) {
      return forbidden(c, "Cannot review your own task");
    }
  }

  // Already locked by someone else
  const isCurrentReviewer =
    (actor.type === "human" && task.reviewClaimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.reviewClaimedByAgentId === actor.tokenId);
  if ((task.reviewClaimedByUserId || task.reviewClaimedByAgentId) && !isCurrentReviewer) {
    return conflict(c, "Task is already being reviewed by another reviewer");
  }

  // Already locked by this actor — idempotent
  if (isCurrentReviewer) {
    return c.json({ task }, 200);
  }

  // Atomic compare-and-swap: only acquire the lock if it is still free. The
  // null-check above is a fast path; two reviewers can both pass it before
  // either writes (TOCTOU). Guarding on `reviewClaimedBy* IS NULL` makes
  // exactly one writer win; the loser sees count===0 and gets a 409.
  const claimResult = await prisma.task.updateMany({
    where: { id: task.id, reviewClaimedByUserId: null, reviewClaimedByAgentId: null },
    data: {
      reviewClaimedByUserId: actor.type === "human" ? actor.userId : null,
      reviewClaimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
      reviewClaimedAt: new Date(),
    },
  });
  if (claimResult.count === 0) {
    return conflict(c, "Task is already being reviewed by another reviewer");
  }

  // updateMany cannot use `include`, so re-fetch the freshly claimed row.
  const updated = await prisma.task.findUnique({
    where: { id: task.id },
    include: taskInclude,
  });
  if (!updated) return notFound(c);

  void logAuditEvent({
    action: "task.reviewed",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: {
      event: "review_claimed",
      actorType: actor.type,
      reviewerId: actor.type === "human" ? actor.userId : actor.tokenId,
    },
  });

  return c.json({ task: updated });
});

// ── Release review (review lock) ────────────────────────────────────────────

taskRouter.post("/tasks/:id/review/release", async (c) => {
  const actor = c.get("actor") as Actor;

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const isCurrentReviewer =
    (actor.type === "human" && task.reviewClaimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.reviewClaimedByAgentId === actor.tokenId);

  if (!isCurrentReviewer) {
    return forbidden(c, "Only the current reviewer can release the review lock");
  }

  // Atomic: only clear the lock if this actor still holds it, so a stale
  // release cannot wipe a lock another reviewer acquired in the meantime
  // (the isCurrentReviewer check above is a fast path with a TOCTOU window).
  const releaseResult = await prisma.task.updateMany({
    where:
      actor.type === "human"
        ? { id: task.id, reviewClaimedByUserId: actor.userId }
        : { id: task.id, reviewClaimedByAgentId: actor.tokenId },
    data: {
      reviewClaimedByUserId: null,
      reviewClaimedByAgentId: null,
      reviewClaimedAt: null,
    },
  });
  if (releaseResult.count === 0) {
    return conflict(c, "Review lock is no longer held by you");
  }

  // updateMany cannot use `include`, so re-fetch the freshly released row.
  const updated = await prisma.task.findUnique({
    where: { id: task.id },
    include: taskInclude,
  });
  if (!updated) return notFound(c);

  void logAuditEvent({
    action: "task.reviewed",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: { event: "review_released", actorType: actor.type },
  });

  return c.json({ task: updated });
});
