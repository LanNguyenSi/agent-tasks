import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import { hasProjectAccess, isProjectAdmin } from "../services/team-access.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import {
  defaultWorkflowDefinition,
  type WorkflowDefinitionShape,
} from "../services/default-workflow.js";
import { RULE_CATALOG } from "../services/transition-rules.js";
import { logAuditEvent } from "../services/audit.js";
import { summarizeWorkflowDiff } from "../services/workflow-diff.js";

/**
 * Shape snapshot written into the `workflow.customized` audit payload.
 * A small forensic slice so a future auditor can reconstruct what a
 * user forked without needing git history of `DEFAULT_STATES`.
 */
export interface ForkedFromDefaultSnapshot {
  stateCount: number;
  transitionCount: number;
  stateNames: string[];
  initialState: string;
}

export function buildForkedFromDefaultSnapshot(
  def: WorkflowDefinitionShape,
): ForkedFromDefaultSnapshot {
  return {
    stateCount: def.states.length,
    transitionCount: def.transitions.length,
    stateNames: def.states.map((s) => s.name),
    initialState: def.initialState,
  };
}

export const workflowRouter = new Hono<{ Variables: AppVariables }>();

// State names must match the task.status storage format: lowercase letters,
// digits, and underscores only. This mirrors the frontend editor's
// `STATE_NAME_RE` — enforcing it server-side so a malicious or buggy client
// cannot persist a corrupted workflow graph (e.g. names with shell
// metacharacters, spaces, or null bytes).
const STATE_NAME_RE = /^[a-z0-9_]+$/;

const workflowStateSchema = z.object({
  name: z.string().min(1).regex(STATE_NAME_RE, "State name must match [a-z0-9_]+"),
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

// The frontend editor enforces these invariants client-side, but clients
// cannot be trusted — this is the backend's only structural defense
// against a corrupted workflow graph (duplicate state names, dangling
// initialState, transitions pointing at states that don't exist). Task
// router + transition handler assume these hold, so a bypass here would
// manifest as runtime errors during task operations, not persistence
// errors at PUT time.
export const workflowDefinitionSchema = z
  .object({
    states: z.array(workflowStateSchema).min(1),
    transitions: z.array(workflowTransitionSchema),
    initialState: z.string().min(1),
  })
  .superRefine((def, ctx) => {
    const names = new Set<string>();
    for (const s of def.states) {
      if (names.has(s.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate state name: "${s.name}"`,
          path: ["states"],
        });
      }
      names.add(s.name);
    }
    if (!names.has(def.initialState)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `initialState "${def.initialState}" is not in the states list`,
        path: ["initialState"],
      });
    }
    const seenPairs = new Set<string>();
    for (let i = 0; i < def.transitions.length; i++) {
      const t = def.transitions[i]!;
      if (!names.has(t.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Transition references missing "from" state: "${t.from}"`,
          path: ["transitions", i, "from"],
        });
      }
      if (!names.has(t.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Transition references missing "to" state: "${t.to}"`,
          path: ["transitions", i, "to"],
        });
      }
      // Duplicate (from, to) pairs are client-blocked but we defend here
      // too — a direct API caller could otherwise persist dead config that
      // survives round-trips through the editor (runtime `find` picks the
      // first match, the second is ignored but keeps re-firing validation
      // errors when the user next opens the editor).
      const key = `${t.from}→${t.to}`;
      if (seenPairs.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate transition: ${key}`,
          path: ["transitions", i],
        });
      }
      seenPairs.add(key);
    }
  });

const createWorkflowSchema = z.object({
  name: z.string().min(1).max(100),
  projectId: z.string().uuid(),
  isDefault: z.boolean().default(false),
  definition: workflowDefinitionSchema,
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

    const forkedDef = workflow.definition as unknown as WorkflowDefinitionShape;
    void logAuditEvent({
      action: "workflow.customized",
      actorId: actor.type === "human" ? actor.userId : undefined,
      projectId,
      payload: {
        workflowId: workflow.id,
        forkedFromDefault: buildForkedFromDefaultSnapshot(forkedDef),
      },
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
  // workflow row. `updateMany` returns the count, which we capture for the
  // audit payload so auditors can see the blast radius of a reset.
  const [updateResult] = await prisma.$transaction([
    prisma.task.updateMany({
      where: { workflowId: existing.id },
      data: { workflowId: null },
    }),
    prisma.workflow.delete({ where: { id: existing.id } }),
  ]);

  void logAuditEvent({
    action: "workflow.reset",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId,
    payload: {
      previousWorkflowId: existing.id,
      affectedTaskCount: updateResult.count,
    },
  });

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

    void logAuditEvent({
      action: "workflow.created",
      actorId: actor.userId,
      projectId,
      payload: {
        workflowId: workflow.id,
        name: workflow.name,
        isDefault: workflow.isDefault,
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

    // Compute a small diff summary for the audit payload so auditors can
    // reconstruct what changed without the backend storing every
    // definition snapshot. Only include the diff when the definition
    // actually changed — a name-only update writes a lighter payload.
    const diff = body.definition
      ? summarizeWorkflowDiff(
          workflow.definition as unknown as WorkflowDefinitionShape,
          body.definition as unknown as WorkflowDefinitionShape,
        )
      : null;

    void logAuditEvent({
      action: "workflow.updated",
      actorId: actor.userId,
      projectId: workflow.projectId,
      payload: {
        workflowId: workflow.id,
        ...(body.name && body.name !== workflow.name
          ? { nameChanged: { from: workflow.name, to: body.name } }
          : {}),
        ...(body.isDefault !== undefined && body.isDefault !== workflow.isDefault
          ? { isDefaultChanged: { from: workflow.isDefault, to: body.isDefault } }
          : {}),
        ...(diff ? { definitionDiff: diff } : {}),
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
