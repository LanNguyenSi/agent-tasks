import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { Prisma } from "@prisma/client";
import { forbidden, notFound, conflict, lowConfidence } from "../middleware/error.js";
import { hasProjectAccess } from "../services/team-access.js";
import { logAuditEvent } from "../services/audit.js";
import { emitReviewSignal, emitChangesRequestedSignal, emitTaskApprovedSignal } from "../services/review-signal.js";
import { emitTaskAvailableSignal } from "../services/task-signal.js";
import { templateDataSchema, calculateConfidence, type TemplateData, type TemplateFields } from "../lib/confidence.js";

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
});

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

const importTaskSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.enum(["open", "in_progress", "review", "done"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  dueAt: z.string().datetime().optional(),
  externalRef: z.string().trim().min(1).max(255).optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  templateData: templateDataSchema.optional(),
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

    // Load existing externalRefs for dedup
    const existingRefs = new Set<string>();
    const refsInBatch = body.tasks
      .map((t) => t.externalRef)
      .filter((r): r is string => r !== undefined);

    if (refsInBatch.length > 0) {
      const existing = await prisma.task.findMany({
        where: { projectId, externalRef: { in: refsInBatch } },
        select: { externalRef: true },
      });
      for (const t of existing) {
        if (t.externalRef) existingRefs.add(t.externalRef);
      }
    }

    const created: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < body.tasks.length; i++) {
      const item = body.tasks[i];

      // Skip duplicates by externalRef
      if (item.externalRef && existingRefs.has(item.externalRef)) {
        skipped.push(item.externalRef);
        continue;
      }

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
        created.push(task.id);
        if (item.externalRef) existingRefs.add(item.externalRef);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          skipped.push(item.externalRef ?? item.title);
        } else {
          errors.push({ index: i, error: (e as Error).message });
        }
      }
    }

    return c.json({
      created: created.length,
      skipped: skipped.length,
      failed: errors.length,
      ids: created,
      skippedRefs: skipped,
      errors,
    }, 201);
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
  type WorkflowTransition = { from: string; to: string; label?: string; requiredRole?: string };

  let currentState: WorkflowState | null = null;
  let allowedTransitions: { to: string; label?: string }[] = [];

  if (task.workflow) {
    const def = task.workflow.definition as {
      states: WorkflowState[];
      transitions: WorkflowTransition[];
      initialState: string;
    };

    currentState = def.states.find((s) => s.name === task.status) ?? null;
    allowedTransitions = def.transitions
      .filter((t) => t.from === task.status)
      .map((t) => ({ to: t.to, label: t.label }));
  } else {
    // No workflow: return default transitions based on current status
    const defaultTransitions: Record<string, { to: string; label: string }[]> = {
      open: [{ to: "in_progress", label: "Start" }],
      in_progress: [
        { to: "review", label: "Submit for review" },
        { to: "done", label: "Mark done" },
        { to: "open", label: "Release" },
      ],
      review: [
        { to: "done", label: "Approve" },
        { to: "in_progress", label: "Request changes" },
      ],
      done: [],
    };
    allowedTransitions = defaultTransitions[task.status] ?? [];
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
      include: { workflow: true },
    });
    if (!task) return notFound(c);

    if (!(await hasProjectAccess(actor, task.projectId))) {
      return forbidden(c, "Access denied to this project");
    }

    const { status } = c.req.valid("json");
    const previousStatus = task.status;

    // Validate transition against workflow definition if task has a workflow
    if (task.workflow) {
      const def = task.workflow.definition as {
        states: { name: string }[];
        transitions: { from: string; to: string; requiredRole?: string }[];
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

      if (transition.requiredRole && transition.requiredRole !== "any") {
        if (actor.type === "agent") {
          return forbidden(c, `This transition requires role: ${transition.requiredRole}`);
        }
        // For humans, check team membership role
        const membership = await prisma.teamMember.findFirst({
          where: { userId: actor.userId, team: { projects: { some: { id: task.projectId } } } },
        });
        if (membership?.role !== transition.requiredRole) {
          return forbidden(c, `Requires role: ${transition.requiredRole}`);
        }
      }
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { status, updatedAt: new Date() },
      include: taskInclude,
    });

    void logAuditEvent({
      action: "task.transitioned",
      actorId: actor.type === "human" ? actor.userId : undefined,
      projectId: task.projectId,
      taskId: task.id,
      payload: { from: previousStatus, to: status, actorType: actor.type },
    });

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
