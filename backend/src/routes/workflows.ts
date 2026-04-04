import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import { hasProjectAccess } from "../services/team-access.js";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";

export const workflowRouter = new Hono<{ Variables: AppVariables }>();

const workflowStateSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  terminal: z.boolean().default(false),
  agentInstructions: z.string().optional(),
});

const workflowTransitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional(),
  requiredRole: z.enum(["ADMIN", "HUMAN_MEMBER", "REVIEWER", "any"]).default("any"),
});

const createWorkflowSchema = z.object({
  name: z.string().min(1).max(100),
  projectId: z.string().uuid(),
  isDefault: z.boolean().default(false),
  definition: z.object({
    states: z.array(workflowStateSchema).min(1),
    transitions: z.array(workflowTransitionSchema),
    initialState: z.string().min(1),
  }),
});

const updateWorkflowSchema = createWorkflowSchema
  .omit({ projectId: true })
  .partial();

// ── List workflows for a project ──────────────────────────────────────────────

workflowRouter.get("/projects/:projectId/workflows", async (c) => {
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");

  if (!(await hasProjectAccess(actor, projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const workflows = await prisma.workflow.findMany({
    where: { projectId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

  return c.json({ workflows });
});

// ── Create workflow ───────────────────────────────────────────────────────────

workflowRouter.post(
  "/projects/:projectId/workflows",
  zValidator("json", createWorkflowSchema.omit({ projectId: true })),
  async (c) => {
    const actor = c.get("actor");
    const projectId = c.req.param("projectId");

    if (actor.type === "agent") {
      return forbidden(c, "Agents cannot create workflows");
    }

    if (!(await hasProjectAccess(actor, projectId))) {
      return forbidden(c, "Access denied to this project");
    }

    const body = c.req.valid("json");

    // If this is set as default, unset existing default
    if (body.isDefault) {
      await prisma.workflow.updateMany({
        where: { projectId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const workflow = await prisma.workflow.create({
      data: {
        projectId,
        name: body.name,
        isDefault: body.isDefault ?? false,
        definition: body.definition as object,
      },
    });

    return c.json({ workflow }, 201);
  },
);

// ── Get workflow ──────────────────────────────────────────────────────────────

workflowRouter.get("/workflows/:id", async (c) => {
  const actor = c.get("actor");
  const workflow = await prisma.workflow.findUnique({
    where: { id: c.req.param("id") },
  });

  if (!workflow) return notFound(c);

  if (!(await hasProjectAccess(actor, workflow.projectId))) {
    return forbidden(c, "Access denied");
  }

  return c.json({ workflow });
});

// ── Update workflow ───────────────────────────────────────────────────────────

workflowRouter.put(
  "/workflows/:id",
  zValidator("json", updateWorkflowSchema),
  async (c) => {
    const actor = c.get("actor");

    if (actor.type === "agent") {
      return forbidden(c, "Agents cannot modify workflows");
    }

    const workflow = await prisma.workflow.findUnique({
      where: { id: c.req.param("id") },
    });
    if (!workflow) return notFound(c);

    if (!(await hasProjectAccess(actor, workflow.projectId))) {
      return forbidden(c, "Access denied");
    }

    const body = c.req.valid("json");

    if (body.isDefault) {
      await prisma.workflow.updateMany({
        where: { projectId: workflow.projectId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const updated = await prisma.workflow.update({
      where: { id: workflow.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
        ...(body.definition ? { definition: body.definition as object } : {}),
      },
    });

    return c.json({ workflow: updated });
  },
);

// ── Validate a transition ─────────────────────────────────────────────────────

const validateTransitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  actorRole: z.string().optional(),
});

workflowRouter.post(
  "/workflows/:id/validate-transition",
  zValidator("json", validateTransitionSchema),
  async (c) => {
  const actor = c.get("actor");
  const body = c.req.valid("json");

  const workflow = await prisma.workflow.findUnique({ where: { id: c.req.param("id") } });
  if (!workflow) return notFound(c);

  if (!(await hasProjectAccess(actor, workflow.projectId))) {
    return forbidden(c, "Access denied");
  }

  const def = workflow.definition as {
    states: { name: string }[];
    transitions: { from: string; to: string; requiredRole?: string }[];
  };

  const transition = def.transitions.find(
    (t) => t.from === body.from && t.to === body.to,
  );

  if (!transition) {
    return c.json({ valid: false, reason: `No transition defined from '${body.from}' to '${body.to}'` });
  }

  if (transition.requiredRole && transition.requiredRole !== "any" && body.actorRole !== transition.requiredRole) {
    return c.json({ valid: false, reason: `Requires role: ${transition.requiredRole}` });
  }

  return c.json({ valid: true });
  },
);
