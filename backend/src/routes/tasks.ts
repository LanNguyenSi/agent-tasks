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
  type ProjectRole,
} from "../services/team-access.js";
import { logAuditEvent } from "../services/audit.js";
import { emitReviewSignal, emitChangesRequestedSignal, emitTaskApprovedSignal } from "../services/review-signal.js";
import { emitTaskAvailableSignal } from "../services/task-signal.js";
import { templateDataSchema, calculateConfidence, type TemplateData, type TemplateFields } from "../lib/confidence.js";
import {
  DEFAULT_TRANSITIONS,
  findDefaultTransition,
  defaultWorkflowDefinition,
  expectedFinishStateFromDefinition,
  type WorkflowDefinitionShape,
} from "../services/default-workflow.js";
import { findDelegationUser } from "../services/github-delegation.js";
import { GITHUB_BACKED_RULES, parseOwnerRepo } from "../services/transition-rules.js";
import { performPrMerge } from "../services/github-merge.js";
import { emitForceTransitionedSignal } from "../services/force-transition-signal.js";
import { checkDistinctReviewerGate, distinctReviewerRejectionMessage } from "../services/review-gate.js";


export const taskRouter = new Hono<{ Variables: AppVariables }>();

const taskInclude = {
  attachments: { orderBy: { createdAt: "desc" as const } },
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

// ── List tasks for a project ─────────────────────────────────────────────────

taskRouter.get("/projects/:projectId/tasks", async (c) => {
  const actor = c.get("actor") as Actor;
  const projectId = c.req.param("projectId");

  if (!(await hasProjectAccess(actor, projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const labelFilter = c.req.query("labels");
  const externalRefFilter = c.req.query("externalRef");

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

  const tasks = await prisma.task.findMany({
    where,
    include: taskInclude,
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

const importTaskSchema = createTaskSchema.omit({ workflowId: true }).extend({
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
    status: "open",
    claimedByUserId: null,
    claimedByAgentId: null,
  };

  if (projectId) {
    if (!(await hasProjectAccess(actor, projectId))) {
      return forbidden(c, "Access denied to this project");
    }
    where.projectId = projectId;
  } else if (actor.type === "agent") {
    // For agents, team scope is implicit via token.
    where.project = { teamId: actor.teamId };
  } else {
    // For human sessions, keep team boundary explicit when no project is given.
    if (!teamIdQuery) {
      return c.json(
        { error: "bad_request", message: "teamId or projectId required" },
        400,
      );
    }

    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: teamIdQuery, userId: actor.userId } },
    });
    if (!membership) {
      return forbidden(c, "Access denied to this team");
    }

    where.project = { teamId: teamIdQuery };
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
            "You already hold an active claim. Call task_finish or task_abandon on it before picking up new work.",
          activeClaim: { taskId: existing.id, title: existing.title, role },
        },
        409,
      );
    }
  }

  // ── 1. Signals ────────────────────────────────────────────────────────────
  const signal = await prisma.signal.findFirst({
    where: {
      acknowledgedAt: null,
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
      status: "review",
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
      status: "open",
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
  let effectiveDefinition: WorkflowDefinitionShape | null = null;
  if (task.workflowId && task.workflow) {
    effectiveDefinition = task.workflow.definition as unknown as WorkflowDefinitionShape;
  } else {
    const projectDefault = await prisma.workflow.findFirst({
      where: { projectId: task.projectId, isDefault: true },
    });
    effectiveDefinition = projectDefault
      ? (projectDefault.definition as unknown as WorkflowDefinitionShape)
      : defaultWorkflowDefinition();
  }
  const expectedFinishState = expectedFinishStateFromDefinition(effectiveDefinition);

  // ── Branch: status=open → author-claim + transition ──────────────────────
  if (task.status === "open") {
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
    const gateResult = await evaluateV2TransitionGates(
      task,
      { branchName: task.branchName, prUrl: task.prUrl, prNumber: task.prNumber },
      "in_progress",
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
      // Exhaustiveness check — see the same pattern in the task_finish
      // branches for the rationale.
      const _exhaustive: never = gateResult;
      return _exhaustive;
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        claimedByUserId: actor.type === "human" ? actor.userId : null,
        claimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
        claimedAt: new Date(),
        status: "in_progress",
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
  if (task.status === "review") {
    // Distinct-reviewer: cannot review your own task
    const isSelfReview =
      (actor.type === "human" && task.claimedByUserId === actor.userId) ||
      (actor.type === "agent" && task.claimedByAgentId === actor.tokenId) ||
      (actor.type === "agent" && task.createdByAgentId === actor.tokenId);
    if (isSelfReview) {
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
      expectedFinishState: "done" as const,
      project: task.project,
    });
  }

  return c.json(
    {
      error: "bad_state",
      message: `Cannot start a task in status '${task.status}'. Only 'open' or 'review' tasks can be started.`,
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
    console.warn(
      `[workflow] v2 transition references unknown rules: ${unknown.join(", ")}`,
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
    if (task.status !== "review") {
      return c.json({ error: "bad_state", message: "Task must be in review status" }, 409);
    }
    const parsed = finishReviewSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "bad_request", message: parsed.error.message }, 400);
    }
    const { outcome, result, autoMerge, mergeMethod } = parsed.data;

    const targetStatus = outcome === "approve" ? "done" : "in_progress";

    // Distinct-reviewer gate. Defense-in-depth: pickup already excludes the
    // author from the review pool, but an explicit workflow path could place
    // an author into a review state some other way. The PATCH and /transition
    // handlers both check this; v2 task_finish was silently skipping it.
    if (outcome === "approve" && task.project.requireDistinctReviewer) {
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
    // for the shared semantics. Resolve the effective workflow the same
    // way the work-finish branch does below so both paths evaluate gates
    // against the same definition.
    let effectiveReviewDefinition: WorkflowDefinitionShape | null = null;
    if (task.workflowId && task.workflow) {
      effectiveReviewDefinition = task.workflow.definition as unknown as WorkflowDefinitionShape;
    } else {
      const projectDefault = await prisma.workflow.findFirst({
        where: { projectId: task.projectId, isDefault: true },
      });
      effectiveReviewDefinition = projectDefault
        ? (projectDefault.definition as unknown as WorkflowDefinitionShape)
        : defaultWorkflowDefinition();
    }
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
        const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrCreate");
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
      const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrCreate");
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

  if (task.status !== "in_progress") {
    return c.json(
      { error: "bad_state", message: `Work finish requires status=in_progress, got '${task.status}'` },
      409,
    );
  }

  // Derive expectedFinishState from the workflow
  let effectiveDefinition: WorkflowDefinitionShape | null = null;
  if (task.workflowId && task.workflow) {
    effectiveDefinition = task.workflow.definition as unknown as WorkflowDefinitionShape;
  } else {
    const projectDefault = await prisma.workflow.findFirst({
      where: { projectId: task.projectId, isDefault: true },
    });
    effectiveDefinition = projectDefault
      ? (projectDefault.definition as unknown as WorkflowDefinitionShape)
      : defaultWorkflowDefinition();
  }

  // When autoMerge is requested, hard-set targetStatus to "done" and verify
  // the workflow actually supports in_progress → done (ADR-0010 §2 Mode A).
  let targetStatus: "review" | "done";
  if (workAutoMerge) {
    if (!task.project.soloMode) {
      return c.json(
        { error: "solo_mode_required", message: "autoMerge on a work claim requires project.soloMode to be enabled" },
        403,
      );
    }
    targetStatus = "done";
  } else {
    targetStatus = expectedFinishStateFromDefinition(effectiveDefinition);
  }

  // Cross-repo validation on prUrl payload (ADR-0010 §5b).
  if (prUrl && task.project.githubRepo) {
    const projectRepo = parseOwnerRepo(task.project.githubRepo);
    const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
    if (projectRepo && prMatch) {
      const prOwner = prMatch[1].toLowerCase();
      const prRepo = prMatch[2].toLowerCase();
      if (prOwner !== projectRepo.owner.toLowerCase() || prRepo !== projectRepo.repo.toLowerCase()) {
        return c.json(
          {
            error: "cross_repo_pr_rejected",
            message: `PR belongs to ${prMatch[1]}/${prMatch[2]} but this task's project is linked to ${task.project.githubRepo}`,
          },
          400,
        );
      }
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
    const mergeResult = await performPrMerge(task, workMergeMethod, actor);
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
      const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrCreate");
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

  // Clear work claim only when going straight to done. If going to review,
  // keep the claim so the original author resumes if changes are requested.
  if (targetStatus === "done") {
    updateData.claimedByUserId = null;
    updateData.claimedByAgentId = null;
    updateData.claimedAt = null;
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: updateData,
    include: taskInclude,
  });

  void logAuditEvent({
    action: "task.transitioned",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId: task.projectId,
    taskId: task.id,
    payload: { from: "in_progress", to: targetStatus, actorType: actor.type, via: "task_finish" },
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

  // If we just moved the task into review, notify potential reviewers
  if (targetStatus === "review") {
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
      project: { select: { id: true, name: true, slug: true, githubRepo: true } },
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
  let effectiveDefinition: WorkflowDefinitionShape | null = null;
  if (task.workflowId && task.workflow) {
    effectiveDefinition = task.workflow.definition as unknown as WorkflowDefinitionShape;
  } else {
    const projectDefault = await prisma.workflow.findFirst({
      where: { projectId: task.projectId, isDefault: true },
    });
    effectiveDefinition = projectDefault
      ? (projectDefault.definition as unknown as WorkflowDefinitionShape)
      : defaultWorkflowDefinition();
  }

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

  // Cross-repo hardening (ADR-0010 §5b): reject prUrls that point at a
  // different repo than the task's project.
  if (task.project.githubRepo) {
    const projectRepo = parseOwnerRepo(task.project.githubRepo);
    const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
    if (projectRepo && prMatch) {
      const prOwner = prMatch[1].toLowerCase();
      const prRepo = prMatch[2].toLowerCase();
      if (
        prOwner !== projectRepo.owner.toLowerCase() ||
        prRepo !== projectRepo.repo.toLowerCase()
      ) {
        return c.json(
          {
            error: "cross_repo_pr_rejected",
            message: `PR belongs to ${prMatch[1]}/${prMatch[2]} but this task's project is linked to ${task.project.githubRepo}`,
          },
          400,
        );
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

  // Reject abandoning a work claim while the task is already in review.
  // Clearing the work claim here would leave an orphan: the task stays in
  // review, but `request_changes` relies on the retained work claim to
  // auto-resume the author. Force the author to wait for the reviewer.
  if (holdsWorkClaim && !holdsReviewClaim && task.status === "review") {
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
    // Only reset status to open when we were in the transitional in_progress
    // state. If the task is already in review, we rejected above.
    if (task.status === "in_progress") {
      updateData.status = "open";
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

  let currentState: WorkflowState | null = null;
  let allowedTransitions: { to: string; label?: string; requires?: string[] }[] = [];

  if (task.workflow) {
    const def = task.workflow.definition as {
      states: WorkflowState[];
      transitions: WorkflowTransition[];
      initialState: string;
    };

    currentState = def.states.find((s) => s.name === task.status) ?? null;
    // Surface `requires` to agents so they know which preconditions to
    // satisfy (set branch, create PR) before attempting the transition.
    allowedTransitions = def.transitions
      .filter((t) => t.from === task.status)
      .map((t) => ({ to: t.to, label: t.label, requires: t.requires }));
  } else {
    // No workflow row — fall back to the built-in default workflow, which
    // also carries `requires` gates (see services/default-workflow.ts).
    allowedTransitions = (DEFAULT_TRANSITIONS[task.status] ?? []).map((t) => ({
      to: t.to,
      label: t.label,
      requires: t.requires,
    }));
  }

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
      select: { requireDistinctReviewer: true },
    });
    if (project?.requireDistinctReviewer) {
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

  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    include: {
      project: { select: { confidenceThreshold: true, taskTemplate: true } },
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

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      claimedByUserId: actor.type === "human" ? actor.userId : null,
      claimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
      claimedAt: new Date(),
      status: "in_progress",
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

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      claimedByUserId: null,
      claimedByAgentId: null,
      claimedAt: null,
      status: "open",
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

    // Resolve the transition to evaluate — either from the task's explicit
    // Workflow row, or from the built-in default workflow that applies to
    // every project without a custom one. Both paths feed the same rule
    // evaluator and force-override logic below.
    let resolvedRequires: string[] | undefined;
    let requiredRole: string | undefined;

    if (task.workflow) {
      const def = task.workflow.definition as {
        states: { name: string }[];
        transitions: { from: string; to: string; requiredRole?: string; requires?: string[] }[];
      };
      const transition = def.transitions.find(
        (t) => t.from === task.status && t.to === status,
      );
      if (!transition) {
        return c.json(
          { error: "bad_request", message: `Transition from '${task.status}' to '${status}' is not allowed by workflow` },
          400,
        );
      }
      resolvedRequires = transition.requires;
      requiredRole = transition.requiredRole;
    } else {
      const defaultT = findDefaultTransition(task.status, status);
      if (!defaultT) {
        return c.json(
          { error: "bad_request", message: `Transition from '${task.status}' to '${status}' is not allowed by the default workflow` },
          400,
        );
      }
      resolvedRequires = defaultT.requires;
    }

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
      console.warn(
        `[workflow] task ${task.id} transition ${task.status}→${status} references unknown rules: ${unknown.join(", ")}`,
      );
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { status, updatedAt: new Date() },
      include: taskInclude,
    });

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

    const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
    if (!task) return notFound(c);

    if (!(await hasProjectAccess(actor, task.projectId))) {
      return forbidden(c, "Access denied to this project");
    }

    if (task.status !== "review") {
      return c.json({ error: "bad_request", message: "Task must be in review status" }, 400);
    }

    // Reviewer must not be the same as the claimant (no self-review)
    const isSelfReview =
      (actor.type === "human" && task.claimedByUserId === actor.userId) ||
      (actor.type === "agent" && task.claimedByAgentId === actor.tokenId);
    if (isSelfReview) {
      return forbidden(c, "Cannot review your own task");
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

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  if (task.status !== "review") {
    return c.json({ error: "bad_request", message: "Task must be in review status" }, 400);
  }

  // No self-review
  const isSelfReview =
    (actor.type === "human" && task.claimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.claimedByAgentId === actor.tokenId);
  if (isSelfReview) {
    return forbidden(c, "Cannot review your own task");
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
