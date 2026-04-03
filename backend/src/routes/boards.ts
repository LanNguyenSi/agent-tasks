import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import { hasProjectAccess } from "../services/team-access.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";

export const boardRouter = new Hono<{ Variables: AppVariables }>();

const boardColumnSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.string().min(1),
  color: z.string().optional(),
});

const createBoardSchema = z.object({
  name: z.string().min(1).max(100),
  projectId: z.string().uuid(),
  config: z.object({
    columns: z.array(boardColumnSchema).min(1),
    groupBy: z.enum(["none", "service", "level", "priority", "assignee"]).default("none"),
    filters: z.array(z.record(z.string())).default([]),
  }),
});

const updateBoardSchema = createBoardSchema.omit({ projectId: true }).partial();

// ── List boards for a project ─────────────────────────────────────────────────

boardRouter.get("/projects/:projectId/boards", async (c) => {
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");

  if (!(await hasProjectAccess(actor, projectId))) {
    return forbidden(c, "Access denied");
  }

  const boards = await prisma.board.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
  });

  return c.json({ boards });
});

// ── Create board ──────────────────────────────────────────────────────────────

boardRouter.post(
  "/projects/:projectId/boards",
  zValidator("json", createBoardSchema.omit({ projectId: true })),
  async (c) => {
    const actor = c.get("actor");
    const projectId = c.req.param("projectId");

    if (actor.type === "agent") {
      return forbidden(c, "Agents cannot create boards");
    }

    if (!(await hasProjectAccess(actor, projectId))) {
      return forbidden(c, "Access denied");
    }

    const body = c.req.valid("json");
    const board = await prisma.board.create({
      data: {
        projectId,
        name: body.name,
        config: body.config as object,
      },
    });

    return c.json({ board }, 201);
  },
);

// ── Get board ─────────────────────────────────────────────────────────────────

boardRouter.get("/boards/:id", async (c) => {
  const actor = c.get("actor");
  const board = await prisma.board.findUnique({ where: { id: c.req.param("id") } });
  if (!board) return notFound(c);

  if (!(await hasProjectAccess(actor, board.projectId))) {
    return forbidden(c, "Access denied");
  }

  // Enrich with tasks for each column
  const config = board.config as { columns: { status: string }[] };
  const tasks = await prisma.task.findMany({
    where: { projectId: board.projectId },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      claimedByUserId: true,
      claimedByAgentId: true,
      updatedAt: true,
    },
  });

  const columns = config.columns.map((col) => ({
    ...col,
    tasks: tasks.filter((t) => t.status === col.status),
  }));

  return c.json({ board: { ...board, columns } });
});

// ── Update board config ───────────────────────────────────────────────────────

boardRouter.put(
  "/boards/:id",
  zValidator("json", updateBoardSchema),
  async (c) => {
    const actor = c.get("actor");

    if (actor.type === "agent") {
      return forbidden(c, "Agents cannot modify boards");
    }

    const board = await prisma.board.findUnique({ where: { id: c.req.param("id") } });
    if (!board) return notFound(c);

    if (!(await hasProjectAccess(actor, board.projectId))) {
      return forbidden(c, "Access denied");
    }

    const body = c.req.valid("json");
    const updated = await prisma.board.update({
      where: { id: board.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.config ? { config: body.config as object } : {}),
      },
    });

    return c.json({ board: updated });
  },
);
