import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import { hasProjectAccess } from "../services/team-access.js";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import { defaultWorkflowDefinition } from "../services/default-workflow.js";
import { RULE_CATALOG } from "../services/transition-rules.js";

export const workflowRouter = new Hono<{ Variables: AppVariables }>();

/**
 * Check that the actor is a human team ADMIN on the team owning `projectId`.
 * Mirrors the pattern used by the transition force-check; extracted here
 * because the customize / reset endpoints need the same gate.
 */
async function isProjectAdmin(actor: Actor, projectId: string): Promise<boolean> {
  if (actor.type !== "human") return false;
  const membership = await prisma.teamMember.findFirst({
    where: {
      userId: actor.userId,
      team: { projects: { some: { id: projectId } } },
    },
  });
  return membership?.role === "ADMIN";
}

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
  // Built-in preconditions that must be satisfied before this transition is
  // allowed. See backend/src/routes/tasks.ts for the list of known rule names.
  // Unknown rules are ignored (not blocking) so forward compatibility across
  // backend versions is safe.
  requires: z.array(z.string().min(1)).max(10).optional(),
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

// ── Rules catalog (public-ish: needs auth but no role) ──────────────────────

workflowRouter.get("/workflow-rules", (c) => {
  return c.json({ rules: RULE_CATALOG });
});

// ── Effective workflow for a project ────────────────────────────────────────

/**
 * Returns the workflow currently in force for the project — either the
 * custom Workflow row (if any) or the built-in default. The response shape
 * is stable in both cases so the UI can render it identically.
 */
workflowRouter.get("/projects/:projectId/effective-workflow", async (c) => {
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");

  if (!(await hasProjectAccess(actor, projectId))) {
    return forbidden(c, "Access denied to this project");
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return notFound(c);

  const custom = await prisma.workflow.findFirst({
    where: { projectId, isDefault: true },
    orderBy: { createdAt: "asc" },
  });

  if (custom) {
    return c.json({
      source: "custom" as const,
      workflowId: custom.id,
      definition: custom.definition,
    });
  }

  return c.json({
    source: "default" as const,
    workflowId: null,
    definition: defaultWorkflowDefinition(),
  });
});

// ── Customize (fork the default into a custom Workflow row) ─────────────────

workflowRouter.post("/projects/:projectId/workflow/customize", async (c) => {
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return notFound(c);

  if (!(await isProjectAdmin(actor, projectId))) {
    return forbidden(c, "Only team admins can customize a workflow");
  }

  // Wrap the check-then-create in a transaction so two concurrent POSTs
  // cannot both pass the findFirst check and end up creating duplicate
  // default workflow rows for the same project.
  try {
    const workflow = await prisma.$transaction(async (tx) => {
      const existing = await tx.workflow.findFirst({
        where: { projectId, isDefault: true },
      });
      if (existing) {
        throw new WorkflowConflictError(existing.id);
      }
      return tx.workflow.create({
        data: {
          projectId,
          name: "Custom workflow",
          isDefault: true,
          definition: defaultWorkflowDefinition() as object,
        },
      });
    });

    return c.json(
      {
        source: "custom" as const,
        workflowId: workflow.id,
        definition: workflow.definition,
      },
      201,
    );
  } catch (err) {
    if (err instanceof WorkflowConflictError) {
      return c.json(
        {
          error: "conflict",
          message: "This project already has a custom workflow",
          workflowId: err.workflowId,
        },
        409,
      );
    }
    throw err;
  }
});

class WorkflowConflictError extends Error {
  constructor(public workflowId: string) {
    super("Workflow already customized");
  }
}

// ── Reset (drop the custom row, revert to default) ──────────────────────────

workflowRouter.delete("/projects/:projectId/workflow", async (c) => {
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return notFound(c);

  if (!(await isProjectAdmin(actor, projectId))) {
    return forbidden(c, "Only team admins can reset a workflow");
  }

  const existing = await prisma.workflow.findFirst({
    where: { projectId, isDefault: true },
  });
  if (!existing) {
    return c.json(
      { error: "not_found", message: "This project has no custom workflow to reset" },
      404,
    );
  }

  // Task.workflow has no explicit `onDelete` in schema.prisma, so Prisma's
  // default (NoAction) would fail the FK constraint on delete. Unset the
  // workflowId on all referencing tasks first — atomically with the delete,
  // so a mid-flight error doesn't leave tasks detached from a still-present
  // workflow row.
  await prisma.$transaction([
    prisma.task.updateMany({
      where: { workflowId: existing.id },
      data: { workflowId: null },
    }),
    prisma.workflow.delete({ where: { id: existing.id } }),
  ]);

  return c.json({
    source: "default" as const,
    workflowId: null,
    definition: defaultWorkflowDefinition(),
  });
});

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

    // Gate workflow mutations on team ADMIN, not just project access. A
    // team member who isn't an admin should not be able to silently swap
    // out gates — otherwise the UI's admin-only editor branch can be
    // trivially bypassed by a direct API call.
    if (!(await isProjectAdmin(actor, workflow.projectId))) {
      return forbidden(c, "Only team admins can modify workflows");
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
