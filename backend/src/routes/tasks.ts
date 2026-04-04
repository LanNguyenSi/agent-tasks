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
import { templateDataSchema, calculateConfidence, type TemplateData, type TemplateFields } from "../lib/confidence.js";

export const taskRouter = new Hono<{ Variables: AppVariables }>();

const taskInclude = {
  attachments: { orderBy: { createdAt: "desc" as const } },
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
};

const createTaskSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.enum(["open", "in_progress", "review", "done"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  workflowId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
  templateData: templateDataSchema.optional(),
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

  const tasks = await prisma.task.findMany({
    where: { projectId },
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

    const task = await prisma.task.create({
      data: {
        projectId,
        title: body.title,
        description: body.description,
        ...(body.status !== undefined ? { status: body.status } : {}),
        priority: body.priority,
        workflowId: body.workflowId,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        ...(body.templateData !== undefined ? { templateData: body.templateData } : {}),
        createdByUserId: actor.type === "human" ? actor.userId : null,
        createdByAgentId: actor.type === "agent" ? actor.tokenId : null,
      },
      include: taskInclude,
    });

    return c.json({ task }, 201);
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
    include: { comments: true, ...taskInclude },
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
  }

  const tpl = task.project.taskTemplate as { fields?: TemplateFields } | null;
  const { score, missing } = calculateConfidence({
    title: task.title,
    description: task.description,
    templateData: task.templateData as TemplateData | null,
    templateFields: tpl?.fields ?? null,
  });

  return c.json({
    task,
    currentState,
    agentInstructions: currentState?.agentInstructions ?? null,
    allowedTransitions,
    updatableFields: ["branchName", "prUrl", "prNumber", "result"],
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
  const updated = await prisma.task.update({
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
      updatedAt: new Date(),
    },
    include: taskInclude,
  });

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

// ── Claim task ────────────────────────────────────────────────────────────────

taskRouter.post("/tasks/:id/claim", async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type === "agent" && !actor.scopes.includes("tasks:claim")) {
    return forbidden(c, "Missing scope: tasks:claim");
  }

  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    include: { project: { select: { confidenceThreshold: true, taskTemplate: true } } },
  });
  if (!task) return notFound(c);

  if (!(await hasProjectAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  // Already claimed
  if (task.claimedByUserId || task.claimedByAgentId) {
    return conflict(c, "Task is already claimed");
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

    return c.json({ task: updated });
  },
);
