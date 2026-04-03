import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import type { Actor } from "../types/auth.js";
import { forbidden, notFound, conflict } from "../middleware/error.js";

/** Verify actor has access to the project's team */
async function assertTeamAccess(actor: Actor, projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { teamId: true },
  });
  if (!project) return false;

  if (actor.type === "agent") {
    return actor.teamId === project.teamId;
  }

  // Human: check team membership
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: project.teamId, userId: actor.userId } },
  });
  return !!membership;
}

export const taskRouter = new Hono();

const createTaskSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  workflowId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
});

const transitionSchema = z.object({
  status: z.string().min(1),
});

// ── List tasks for a project ─────────────────────────────────────────────────

taskRouter.get("/projects/:projectId/tasks", async (c) => {
  const actor = c.get("actor") as Actor;
  const projectId = c.req.param("projectId");

  if (!(await assertTeamAccess(actor, projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const tasks = await prisma.task.findMany({
    where: { projectId },
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
    const body = c.req.valid("json");

    // Agents need tasks:create scope
    if (actor.type === "agent" && !actor.scopes.includes("tasks:create")) {
      return forbidden(c, "Missing scope: tasks:create");
    }

    const task = await prisma.task.create({
      data: {
        projectId: c.req.param("projectId"),
        title: body.title,
        description: body.description,
        priority: body.priority,
        workflowId: body.workflowId,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        createdByUserId: actor.type === "human" ? actor.userId : null,
        createdByAgentId: actor.type === "agent" ? actor.tokenId : null,
      },
    });

    return c.json({ task }, 201);
  },
);

// ── Get task ─────────────────────────────────────────────────────────────────

taskRouter.get("/tasks/:id", async (c) => {
  const actor = c.get("actor") as Actor;
  const task = await prisma.task.findUnique({
    where: { id: c.req.param("id") },
    include: { comments: true },
  });
  if (!task) return notFound(c);

  if (!(await assertTeamAccess(actor, task.projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  return c.json({ task });
});

// ── Claim task ────────────────────────────────────────────────────────────────

taskRouter.post("/tasks/:id/claim", async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type === "agent" && !actor.scopes.includes("tasks:claim")) {
    return forbidden(c, "Missing scope: tasks:claim");
  }

  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

  // Already claimed
  if (task.claimedByUserId || task.claimedByAgentId) {
    return conflict(c, "Task is already claimed");
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      claimedByUserId: actor.type === "human" ? actor.userId : null,
      claimedByAgentId: actor.type === "agent" ? actor.tokenId : null,
      claimedAt: new Date(),
      status: "in_progress",
    },
  });

  return c.json({ task: updated });
});

// ── Release task ──────────────────────────────────────────────────────────────

taskRouter.post("/tasks/:id/release", async (c) => {
  const actor = c.get("actor") as Actor;
  const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
  if (!task) return notFound(c);

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

    const task = await prisma.task.findUnique({ where: { id: c.req.param("id") } });
    if (!task) return notFound(c);

    const { status } = c.req.valid("json");

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { status, updatedAt: new Date() },
    });

    return c.json({ task: updated });
  },
);
