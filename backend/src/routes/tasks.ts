import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { Prisma } from "@prisma/client";
import { forbidden, notFound, conflict, lowConfidence } from "../middleware/error.js";
import {
  hasProjectAccess,
  hasProjectRole,
  isProjectAdmin,
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

// Signals that become meaningless once the underlying task is `done`.
// Outcome-notification signals (`task_approved`, `changes_requested`,
// `task_force_transitioned`) are intentionally NOT listed — they are
// emitted against terminal tasks by design and must still reach recipients.
const STALE_WHEN_DONE: SignalType[] = ["review_needed", "task_available", "task_assigned"];
import { templateDataSchema, calculateConfidence, type TemplateData, type TemplateFields } from "../lib/confidence.js";
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
  distinctReviewerRejectionMessage,
  checkSelfMergeGate,
  selfMergeRejectionMessage,
  checkPrRepoMatchesProject,
  prRepoMatchesProjectRejectionMessage,
} from "../services/gates/index.js";
import { SCOPES } from "../services/scopes.js";


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
  attachments: { orderBy: { createdAt: "desc" as const } },
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

const createTaskSchema = z.object({
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
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  status: z.enum(["open", "in_progress", "review", "done"]).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  branchName: z.string().max(255).nullable().optional(),
  prUrl: z.string().url().nullable().optional(),
  prNumber: z.number().int().positive().nullable().optional(),
  result: z.string().nullable().optional(),
  templateData: templateDataSchema.nullable().optional(),
  externalRef: z.string().trim().min(1).max(255).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
});

const agentUpdateTaskSchema = z.object({
  branchName: z.string().max(255).nullable().optional(),
  prUrl: z.string().url().nullable().optional(),
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
  url: z.string().url(),
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

const createArtifactSchema = z
  .object({
    type: z.enum(ARTIFACT_TYPES),
    name: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    content: z.string().max(ARTIFACT_MAX_BYTES).optional(),
    // Cap URL length so a bogus multi-megabyte "url" string can't reach the DB.
    // 2048 matches the common browser cap for hyperlinks.
    url: z.string().url().max(2048).optional(),
    mimeType: z.string().max(255).optional(),
  })
  .refine((v) => Boolean(v.content) || Boolean(v.url), {
    message: "Either 'content' (inline payload) or 'url' (external pointer) must be provided",
    path: ["content"],
  });

// ── List tasks for a project ─────────────────────────────────────────────────

taskRouter.get("/projects/:projectId/tasks", async (c) => {
  const actor = c.get("actor") as Actor;
  const projectId = c.req.param("projectId");

  if (!(await hasProjectAccess(actor, projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const labelFilter = c.req.query("labels");
  const externalRefFilter = c.req.query("externalRef");
  const statusFilter = c.req.query("status");
  const detail = c.req.query("detail");

  const where: Record<string, unknown> = { projectId };
  if (labelFilter) {
    const parsed = labelFilter.split(",").map((l) => l.trim()).filter(Boolean);
    if (parsed.length > 0) {
      where.labels = { hasSome: parsed };
    }
  }
  if (externalRefFilter && externalRefFilter.length <= 255) {
    where.externalRef = externalRefFilter;
  }
  if (statusFilter) {
    const parsed = statusFilter.split(",").map((s) => s.trim()).filter(Boolean);
    if (parsed.length > 0) {
      where.status = { in: parsed };
    }
  }

  const tasks = await prisma.task.findMany({
    where,
    include: detail === "full" ? taskInclude : taskListInclude,
    orderBy: { createdAt: "desc" },
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
          ...(body.dependsOn && body.dependsOn.length > 0
            ? { blockedBy: { connect: Array.from(new Set(body.dependsOn)).map((id) => ({ id })) } }
            : {}),
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

    return c.json({ task }, 201);
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

taskRouter.get("/tasks/claimable", async (c) => {
  const actor = c.get("actor") as Actor;
  const projectId = c.req.query("projectId");
  const teamIdQuery = c.req.query("teamId");
  const limitRaw = c.req.query("limit");

  const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 200 ? parsedLimit : 50;

  const where: {
    status: string;
    claimedByUserId: null;
    claimedByAgentId: null;
    projectId?: string;
    project?: { teamId: string };
  } = {
    status: "open", // TODO: use terminalStates across team workflows — misses coding-agent "backlog" tasks

    claimedByUserId: null,
    claimedByAgentId: null,
  };

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

  const tasks = await prisma.task.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: limit,
    include: {
      ...taskInclude,
      project: { select: { id: true, name: true, slug: true } },
    },
  });

  return c.json({ tasks });
});

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
    return c.json({ kind: "work", task: workTask });
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

    // Confidence gate — mirrors v1 /claim behavior
    if (actor.type === "agent" && c.req.query("force") !== "true") {
      const threshold = task.project.confidenceThreshold;
      const tpl = task.project.taskTemplate as { fields?: TemplateFields } | null;
      const confidence = calculateConfidence({
        title: task.title,
        description: task.description,
        templateData: task.templateData as TemplateData | null,
        templateFields: tpl?.fields ?? null,
      });
      if (confidence.score < threshold) {
        return lowConfidence(c, { ...confidence, threshold });
      }
    }

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

    const gateResult = await evaluateV2TransitionGates(
      task,
      { branchName: task.branchName, prUrl: task.prUrl, prNumber: task.prNumber },
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

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        claimedByUserId: actor.type === "human" ? actor.userId : null,
        claimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
        claimedAt: new Date(),
        status: startTarget,
      },
      include: taskInclude,
    });

    void logAuditEvent({
      action: "task.claimed",
      actorId: actor.type === "human" ? actor.userId : undefined,
      projectId: task.projectId,
      taskId: task.id,
      payload: {
        actorType: actor.type,
        actorId: actor.type === "agent" ? actor.tokenId : actor.userId,
        via: "task_start",
      },
    });

    return c.json({
      kind: "work",
      task: updated,
      expectedFinishState,
      project: task.project,
    });
  }

  // ── Branch: status=review → review-claim ────────────────────────────────
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
      updated = await prisma.task.update({
        where: { id: task.id },
        data: {
          reviewClaimedByUserId: actor.type === "human" ? actor.userId : null,
          reviewClaimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
          reviewClaimedAt: new Date(),
        },
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
              soloMode: true,
              requireDistinctReviewer: true,
            },
          },
          ...taskInclude,
        },
      });

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

// Result of evaluating workflow transition gates for a v2 `task_finish` call.
// Discriminated union so the caller builds the HTTP response while the helper
// stays free of Hono Context coupling. Distinct-reviewer is checked by the
// caller in the review-finish branch (not here) because the audit-event
// payload needs caller-only fields (actor identity, claim columns).
type FinishGateResult =
  | { ok: true; resolvedRequires: string[] | undefined }
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
    const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrCreate");
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

  return { ok: true, resolvedRequires };
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
    return forbidden(c, "You do not hold a claim on this task");
  }

  const rawBody = await c.req.json().catch(() => ({}));

  // ── Branch: review finish ─────────────────────────────────────────────────
  if (holdsReviewClaim) {
    // Resolve once so the review-state check and gate evaluator share the same definition.
    const effectiveReviewDefinition = await resolveEffectiveDefinition(task, prisma);

    if (!isReviewState(effectiveReviewDefinition, task.status)) {
      return c.json({ error: "bad_state", message: "Task must be in review status" }, 409);
    }
    const parsed = finishReviewSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "bad_request", message: parsed.error.message }, 400);
    }
    const { outcome, result, autoMerge, mergeMethod } = parsed.data;

    const targetStatus = outcome === "approve"
      ? approveTarget(effectiveReviewDefinition, task.status) ?? "done"
      : requestChangesTarget(effectiveReviewDefinition, task.status) ?? task.status;

    // Distinct-reviewer gate. Defense-in-depth: pickup already excludes the
    // author from the review pool, but an explicit workflow path could place
    // an author into a review state some other way. The PATCH and /transition
    // handlers both check this; v2 task_finish was silently skipping it.
    if (
      outcome === "approve" &&
      resolveGovernanceMode(task.project) === GovernanceMode.REQUIRES_DISTINCT_REVIEWER
    ) {
      const gate = checkDistinctReviewerGate(task, actor, task.project);
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
    // (effectiveReviewDefinition) so both paths evaluate gates against
    // the same definition.
    // Review-finish has no prUrl / branchName payload, so the gate context
    // is just the task's current DB state.
    const gateResult = await evaluateV2TransitionGates(
      task,
      { branchName: task.branchName, prUrl: task.prUrl, prNumber: task.prNumber },
      targetStatus,
      actor,
      effectiveReviewDefinition,
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
          status as 403 | 502,
        );
      }

      // Post-check: if the workflow required prMerged, verify it now.
      const workflowHadPrMerged =
        effectiveReviewDefinition
          ? effectiveReviewDefinition.transitions
              .find((t) => t.from === "review" && t.to === "done")
              ?.requires?.includes("prMerged") ?? false
          : false;

      if (workflowHadPrMerged) {
        const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrMerge");
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

    if (outcome === "approve" && isTerminalState(effectiveReviewDefinition, targetStatus)) {
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

    return c.json({ kind: "review", task: updated, outcome, ...(reviewAutoMergeSha !== null ? { autoMergeSha: reviewAutoMergeSha } : {}) });
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
      const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrMerge");
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

  // Derive expectedFinishState from the workflow
  const effectiveDefinition = await resolveEffectiveDefinition(task, prisma);

  if (!isWorkState(effectiveDefinition, task.status)) {
    return c.json(
      { error: "bad_state", message: `Work finish requires a work state (non-initial, non-terminal), got '${task.status}'` },
      409,
    );
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

  // Cross-repo validation on prUrl payload (ADR-0010 §5b). Shared gate —
  // same logic is used by submit-pr below. See services/gates/.
  if (prUrl) {
    const crossRepo = checkPrRepoMatchesProject(prUrl, task.project);
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
        status as 403 | 502,
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
      const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrMerge");
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

  // If we just moved the task into a review state, notify potential reviewers
  if (isReviewState(effectiveDefinition, targetStatus)) {
    void emitReviewSignal(
      task.id,
      task.projectId,
      task.claimedByUserId,
      task.claimedByAgentId,
    );
  }

  return c.json({ kind: "work", task: updated, targetStatus, ...(workAutoMergeSha !== null ? { autoMergeSha: workAutoMergeSha } : {}) });
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
    return forbidden(c, "You do not hold a work claim on this task");
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

  // Cross-repo hardening (ADR-0010 §5b). Same gate as the task_finish
  // branch above — see services/gates/pr-repo-matches-project.ts.
  const crossRepo = checkPrRepoMatchesProject(prUrl, task.project);
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
  // belt-and-braces, not the primary wall — branch protection is).
  if (task.project.githubRepo && task.project.teamId) {
    const projectRepo = parseOwnerRepo(task.project.githubRepo);
    if (projectRepo) {
      const delegationUser = await findDelegationUser(task.project.teamId, "allowAgentPrCreate");
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
    return forbidden(c, "You do not hold a claim on this task");
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

  const updateData: Prisma.TaskUncheckedUpdateInput = {};
  if (holdsWorkClaim) {
    updateData.claimedByUserId = null;
    updateData.claimedByAgentId = null;
    updateData.claimedAt = null;
    // Only reset status to initial when we were in a work state.
    // If the task is already in review, we rejected above.
    if (isWorkState(effectiveDef, task.status)) {
      updateData.status = effectiveDef.initialState;
    }
  }
  if (holdsReviewClaim) {
    updateData.reviewClaimedByUserId = null;
    updateData.reviewClaimedByAgentId = null;
    updateData.reviewClaimedAt = null;
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: updateData,
    include: taskInclude,
  });

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
      const gate = checkDistinctReviewerGate(task, actor, task.project);
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
      project: { select: { confidenceThreshold: true, taskTemplate: true } },
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
  const { score, missing } = calculateConfidence({
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
    },
  });
});

// ── Update task ───────────────────────────────────────────────────────────────

taskRouter.patch("/tasks/:id", async (c) => {
  const actor = c.get("actor") as Actor;
  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
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

    const forbiddenFields = ["title", "description", "priority", "status", "dueAt", "templateData"];
    const attempted = Object.keys(rawBody).filter((k) => forbiddenFields.includes(k));
    if (attempted.length > 0) {
      return c.json({ error: "forbidden", message: `Agents cannot update: ${attempted.join(", ")}` }, 403);
    }

    const parsed = agentUpdateTaskSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "bad_request", message: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const body = parsed.data;
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

    return c.json({ task: updated });
  }

  // Human path — full update
  const parsed = updateTaskSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "bad_request", message: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const body = parsed.data;

  // Distinct-reviewer gate applies to ALL paths that can change status,
  // not just /transition. Previously the frontend "Mark Done" button and
  // any human calling PATCH with { status: "done" } bypassed the gate
  // entirely, making the governance feature cosmetic. Apply the same
  // check here. Status changes for the review→done transition through
  // PATCH get the same structural backstop.
  if (body.status === "done" && task.status === "review") {
    const project = await prisma.project.findUnique({
      where: { id: task.projectId },
      select: {
        requireDistinctReviewer: true,
        soloMode: true,
        governanceMode: true,
      },
    });
    if (project && resolveGovernanceMode(project) === GovernanceMode.REQUIRES_DISTINCT_REVIEWER) {
      const gate = checkDistinctReviewerGate(task, actor, project);
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

  if (body.status === "done" && task.status !== "done") {
    await acknowledgeSignalsForTask(task.id);
  }

  return c.json({ task: updated });
});

// ── Delete task ───────────────────────────────────────────────────────────────

taskRouter.delete("/tasks/:id", async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type !== "human") {
    return forbidden(c, "Agents cannot delete tasks");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  await prisma.task.delete({ where: { id: task.id } });
  return c.json({ success: true });
});

// ── Attachments ───────────────────────────────────────────────────────────────

taskRouter.post("/tasks/:id/attachments", zValidator("json", createAttachmentSchema), async (c) => {
  const actor = c.get("actor") as Actor;
  if (actor.type !== "human") {
    return forbidden(c, "Agents cannot add attachments");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const body = c.req.valid("json");
  const attachment = await prisma.taskAttachment.create({
    data: {
      taskId: task.id,
      name: body.name,
      url: body.url,
      createdByUserId: actor.userId,
    },
  });

  return c.json({ attachment }, 201);
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

  await prisma.taskAttachment.delete({ where: { id: attachment.id } });
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

  const body = c.req.valid("json");
  const sizeBytes = body.content ? Buffer.byteLength(body.content, "utf8") : 0;
  if (sizeBytes > ARTIFACT_MAX_BYTES) {
    return c.json(
      { error: `Artifact exceeds inline size limit of ${ARTIFACT_MAX_BYTES} bytes; use 'url' for larger payloads` },
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

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
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

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
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
        },
      },
    },
  });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
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

  // Confidence gate — only blocks agents (humans get a UI warning instead)
  if (actor.type === "agent" && c.req.query("force") !== "true") {
    const threshold = task.project.confidenceThreshold;
    const claimTpl = task.project.taskTemplate as { fields?: TemplateFields } | null;
    const confidence = calculateConfidence({
      title: task.title,
      description: task.description,
      templateData: task.templateData as TemplateData | null,
      templateFields: claimTpl?.fields ?? null,
    });
    if (confidence.score < threshold) {
      return lowConfidence(c, { ...confidence, threshold });
    }
  }

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

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      claimedByUserId: actor.type === "human" ? actor.userId : null,
      claimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
      claimedAt: new Date(),
      status: startTarget,
    },
    include: taskInclude,
  });

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
    const resolvedRequires = transition.requires;
    const requiredRole = transition.requiredRole;

    // Hot-path optimization: skip the DB round-trip on the common "any"
    // case — any actor that already cleared hasProjectAccess upstream is
    // automatically allowed through the role gate for "any".
    if (requiredRole && requiredRole !== "any") {
      if (!(await hasProjectRole(actor, task.projectId, requiredRole as ProjectRole))) {
        return forbidden(c, `Requires role: ${requiredRole}`);
      }
    }

    // Distinct-reviewer gate. Opt-in per project (default off for backward
    // compatibility). Evaluated BEFORE the precondition rules so that a
    // rejected self-review does not trigger a GitHub round-trip (ciGreen /
    // prMerged checks). force=true is an admin-only escape hatch and is
    // already verified at the top of the handler.
    if (previousStatus === "review" && status === "done" && !force) {
      const gate = checkDistinctReviewerGate(task, actor, task.project);
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
      const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrCreate");
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

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { status, updatedAt: new Date() },
      include: taskInclude,
    });

    // Ack BEFORE emitting outcome signals below — those must survive past
    // the task's terminal state, so we ack the pending work/review asks first.
    if (status === "done" && previousStatus !== "done") {
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

    return c.json({ task: updated });
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

    if (task.status !== "review") {
      return c.json({ error: "bad_request", message: "Task must be in review status" }, 400);
    }

    // Reviewer must not be the same as the claimant (no self-review).
    // soloMode and !requireDistinctReviewer projects bypass this — see
    // checkDistinctReviewerGate in services/review-gate.ts.
    {
      const gate = checkDistinctReviewerGate(task, actor, task.project);
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

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      reviewClaimedByUserId: actor.type === "human" ? actor.userId : null,
      reviewClaimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
      reviewClaimedAt: new Date(),
    },
    include: taskInclude,
  });

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

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      reviewClaimedByUserId: null,
      reviewClaimedByAgentId: null,
      reviewClaimedAt: null,
    },
    include: taskInclude,
  });

  void logAuditEvent({
    action: "task.reviewed",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: { event: "review_released", actorType: actor.type },
  });

  return c.json({ task: updated });
});
