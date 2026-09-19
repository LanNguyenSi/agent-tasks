import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import { hasProjectAccess, hasProjectRole, isProjectAdmin } from "../services/team-access.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import {
  defaultWorkflowDefinition,
  type WorkflowDefinitionShape,
} from "../services/default-workflow.js";
import { RULE_CATALOG } from "../services/transition-rules.js";
import { WORKFLOW_TEMPLATES, findWorkflowTemplate } from "../services/workflow-templates.js";
import { logAuditEvent } from "../services/audit.js";
import { summarizeWorkflowDiff } from "../services/workflow-diff.js";
import { mutateGroundingContext } from "../services/grounding-context-mutation.js";
import { canonicalGroundingJson, GroundingAccessError } from "../services/grounding-context.js";
import { lockGroundingAuthority } from "../services/grounding-direct-authority.js";

type ContextWorkflowResult<T> = T & { changed: boolean };

async function workflowContextMutation<T extends object>(
  projectId: string,
  actor: AppVariables["actor"],
  reason: string,
  select: (db: Parameters<Parameters<typeof mutateGroundingContext>[1]["selectAndAuthorize"]>[0]) => Promise<readonly string[]>,
  mutate: (db: Parameters<Parameters<typeof mutateGroundingContext>[1]["mutate"]>[0]) => Promise<ContextWorkflowResult<T>>,
) {
  return mutateGroundingContext(prisma, {
    projectIds: [projectId], audit: { actor, reason },
    selectAndAuthorize: async db => {
      await lockGroundingAuthority(db, actor, projectId);
      if (!await hasProjectRole(actor, projectId, "ADMIN", db)) throw new GroundingAccessError("forbidden", 403);
      return select(db);
    },
    mutate,
    didMutate: result => result.changed,
  });
}

function inheritedTaskIds(db: Parameters<Parameters<typeof mutateGroundingContext>[1]["selectAndAuthorize"]>[0], projectId: string) {
  return db.task.findMany({ where: { projectId, workflowId: null }, select: { id: true } }).then(tasks => tasks.map(task => task.id));
}

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

// State vocabulary is fixed: open / in_progress / review / done. Transitions,
// gates, role requirements, and per-state label/agentInstructions stay
// configurable per project — the lock applies only to the state SET, not to
// how projects move tasks through it. This is enforced server-side so a
// direct API caller cannot persist a corrupted workflow graph (foreign
// state names that no engine literal-status check would recognize, an
// `initialState` other than `open`, transitions referencing made-up
// states, etc).
export const FIXED_STATE_NAMES = ["open", "in_progress", "review", "done"] as const;
const FIXED_STATE_NAME_SET = new Set<string>(FIXED_STATE_NAMES);
const FIXED_INITIAL_STATE = "open";
const FIXED_TERMINAL_STATES = new Set<string>(["done"]);

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

      if (!FIXED_STATE_NAME_SET.has(s.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Unknown state name "${s.name}". The state vocabulary is fixed: ` +
            `${FIXED_STATE_NAMES.join(", ")}. Add/rename/remove of states is not supported.`,
          path: ["states"],
        });
      }
      // Terminal flag must match the lock-in: only "done" is terminal.
      const shouldBeTerminal = FIXED_TERMINAL_STATES.has(s.name);
      if (s.terminal !== shouldBeTerminal) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `State "${s.name}" terminal flag must be ${shouldBeTerminal}`,
          path: ["states"],
        });
      }
    }

    // The state set must be exactly the fixed vocabulary — no missing names
    // either, because the engine has hardcoded literal-status checks
    // (merge gate, distinct-reviewer guard, dependency gating) that assume
    // every workflow exposes "open", "in_progress", "review", "done".
    for (const required of FIXED_STATE_NAMES) {
      if (!names.has(required)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Required state "${required}" is missing from the workflow`,
          path: ["states"],
        });
      }
    }

    if (def.initialState !== FIXED_INITIAL_STATE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `initialState must be "${FIXED_INITIAL_STATE}", got "${def.initialState}"`,
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
  if (!(await isProjectAdmin(actor, projectId))) return forbidden(c, "Only team admins can customize a workflow");
  try {
    const result = await workflowContextMutation(projectId, actor, "workflow_customize_grounding_context", async db => {
      const existing = await db.workflow.findFirst({
        where: { projectId, isDefault: true },
      });
      return existing ? [] : inheritedTaskIds(db, projectId);
    }, async db => {
      const existing = await db.workflow.findFirst({ where: { projectId, isDefault: true } });
      if (existing) return { changed: false, conflict: existing.id };
      const workflow = await db.workflow.create({
        data: {
          projectId,
          name: "Custom workflow",
          isDefault: true,
          definition: defaultWorkflowDefinition() as object,
        },
      });
      return { changed: true, workflow };
    });

    if ("conflict" in result) {
      return c.json({ error: "conflict", message: "This project already has a custom workflow", workflowId: result.conflict }, 409);
    }
    const workflow = result.workflow;

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
    if (err instanceof GroundingAccessError) {
      if (err.code === "not_found") return notFound(c);
      if (err.code === "forbidden") return forbidden(c, "Only team admins can customize a workflow");
      return c.json({ error: err.code }, 409);
    }
    throw err;
  }
});

// ── Workflow templates ──────────────────────────────────────────────────────

/**
 * List available workflow templates. No auth required beyond project access
 * — templates are public metadata, not secrets.
 */
workflowRouter.get("/workflow-templates", (c) => {
  return c.json({
    templates: WORKFLOW_TEMPLATES.map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      stateCount: t.definition.states.length,
      initialState: t.definition.initialState,
    })),
  });
});

/**
 * Apply a predefined workflow template to a project. Works like customize
 * but seeds the definition from the template instead of copying the
 * built-in default. Replaces any existing custom workflow.
 */
workflowRouter.post("/projects/:projectId/workflow/apply-template/:slug", async (c) => {
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");
  const slug = c.req.param("slug");
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return notFound(c);
  if (!(await isProjectAdmin(actor, projectId))) return forbidden(c, "Only team admins can apply workflow templates");

  const template = findWorkflowTemplate(slug);
  if (!template) {
    return c.json(
      { error: "not_found", message: `Unknown workflow template: "${slug}"` },
      404,
    );
  }

  let workflow;
  try {
    const result = await workflowContextMutation(projectId, actor, "workflow_template_apply_grounding_context", async db => {
      const existing = await db.workflow.findFirst({ where: { projectId, isDefault: true } });
      if (existing && canonicalGroundingJson(existing.definition) === canonicalGroundingJson(template.definition)) return [];
      const tasks = await db.task.findMany({ where: { projectId, OR: [{ workflowId: null }, ...(existing ? [{ workflowId: existing.id }] : [])] }, select: { id: true } });
      return tasks.map(task => task.id);
    }, async db => {
      const existing = await db.workflow.findFirst({ where: { projectId, isDefault: true } });
      const definitionChanged = !existing || canonicalGroundingJson(existing.definition) !== canonicalGroundingJson(template.definition);
      const next = existing
        ? await db.workflow.update({ where: { id: existing.id }, data: { name: template.name, definition: template.definition as object } })
        : await db.workflow.create({ data: { projectId, name: template.name, isDefault: true, definition: template.definition as object } });
      return { changed: definitionChanged, workflow: next };
    });
    workflow = result.workflow;
  } catch (err) {
    if (err instanceof GroundingAccessError) {
      if (err.code === "not_found") return notFound(c);
      if (err.code === "forbidden") return forbidden(c, "Only team admins can apply workflow templates");
      return c.json({ error: err.code }, 409);
    }
    throw err;
  }

  void logAuditEvent({
    action: "workflow.template_applied",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId,
    payload: {
      workflowId: workflow.id,
      templateSlug: template.slug,
      templateName: template.name,
      stateCount: template.definition.states.length,
      transitionCount: template.definition.transitions.length,
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
});

// ── Reset (drop the custom row, revert to default) ──────────────────────────

workflowRouter.delete("/projects/:projectId/workflow", async (c) => {
  const actor = c.get("actor");
  const projectId = c.req.param("projectId");
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return notFound(c);
  if (!(await isProjectAdmin(actor, projectId))) return forbidden(c, "Only team admins can reset a workflow");

  try {
    const result = await workflowContextMutation(projectId, actor, "workflow_reset_grounding_context", async db => {
      const existing = await db.workflow.findFirst({ where: { projectId, isDefault: true } });
      if (!existing) return [];
      const tasks = await db.task.findMany({ where: { projectId, OR: [{ workflowId: existing.id }, { workflowId: null }] }, select: { id: true } });
      return tasks.map(task => task.id);
    }, async db => {
      const existing = await db.workflow.findFirst({ where: { projectId, isDefault: true } });
      if (!existing) return { changed: false, missing: true, affectedTaskCount: 0, previousWorkflowId: "" };
      const updateResult = await db.task.updateMany({ where: { projectId, workflowId: existing.id }, data: { workflowId: null } });
      await db.workflow.delete({ where: { id: existing.id } });
      return { changed: true, missing: false, affectedTaskCount: updateResult.count, previousWorkflowId: existing.id };
    });
    if (result.missing) return c.json({ error: "not_found", message: "This project has no custom workflow to reset" }, 404);

    void logAuditEvent({
    action: "workflow.reset",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId,
    payload: {
      previousWorkflowId: result.previousWorkflowId,
      affectedTaskCount: result.affectedTaskCount,
    },
    });

    return c.json({
    source: "default" as const,
    workflowId: null,
    definition: defaultWorkflowDefinition(),
    });
  } catch (err) {
    if (err instanceof GroundingAccessError) {
      if (err.code === "not_found") return notFound(c);
      if (err.code === "forbidden") return forbidden(c, "Only team admins can reset a workflow");
      return c.json({ error: err.code }, 409);
    }
    throw err;
  }
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
    if (!(await isProjectAdmin(actor, projectId))) return forbidden(c, "Only team admins can create workflows");

    const body = c.req.valid("json");
    let workflow;
    try {
      const result = await workflowContextMutation(projectId, actor, "workflow_create_grounding_context", db => body.isDefault ? inheritedTaskIds(db, projectId) : Promise.resolve([]), async db => {
        if (body.isDefault) await db.workflow.updateMany({ where: { projectId, isDefault: true }, data: { isDefault: false } });
        const next = await db.workflow.create({ data: { projectId, name: body.name, isDefault: body.isDefault ?? false, definition: body.definition as object } });
        return { changed: body.isDefault ?? false, workflow: next };
      });
      workflow = result.workflow;
    } catch (err) {
      if (err instanceof GroundingAccessError) {
        if (err.code === "not_found") return notFound(c);
        if (err.code === "forbidden") return forbidden(c, "Only team admins can create workflows");
        return c.json({ error: err.code }, 409);
      }
      throw err;
    }

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
    if (!(await isProjectAdmin(actor, workflow.projectId))) return forbidden(c, "Only team admins can modify workflows");

    const body = c.req.valid("json");
    let updated;
    let before = workflow;
    try {
      const result = await workflowContextMutation(workflow.projectId, actor, "workflow_update_grounding_context", async db => {
        const current = await db.workflow.findUnique({ where: { id: workflow.id } });
        if (!current) throw new GroundingAccessError("not_found", 404);
        const definitionChanged = body.definition !== undefined && canonicalGroundingJson(body.definition) !== canonicalGroundingJson(current.definition);
        const defaultChanged = body.isDefault !== undefined && body.isDefault !== current.isDefault;
        const contextChanged = definitionChanged || defaultChanged;
        if (!contextChanged) return [];
        const ids = new Set<string>();
        if (definitionChanged) {
          for (const task of await db.task.findMany({ where: { projectId: current.projectId, workflowId: current.id }, select: { id: true } })) ids.add(task.id);
        }
        if (defaultChanged || (definitionChanged && current.isDefault)) {
          for (const task of await db.task.findMany({ where: { projectId: current.projectId, workflowId: null }, select: { id: true } })) ids.add(task.id);
        }
        return [...ids];
      }, async db => {
        const current = await db.workflow.findUnique({ where: { id: workflow.id } });
        if (!current) throw new GroundingAccessError("not_found", 404);
        before = current;
        if (body.isDefault) await db.workflow.updateMany({ where: { projectId: current.projectId, isDefault: true }, data: { isDefault: false } });
        const next = await db.workflow.update({ where: { id: current.id }, data: { ...(body.name ? { name: body.name } : {}), ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}), ...(body.definition ? { definition: body.definition as object } : {}) } });
        return { changed: (body.definition !== undefined && canonicalGroundingJson(body.definition) !== canonicalGroundingJson(current.definition)) || (body.isDefault !== undefined && body.isDefault !== current.isDefault), workflow: next };
      });
      updated = result.workflow;
    } catch (err) {
      if (err instanceof GroundingAccessError) {
        if (err.code === "not_found") return notFound(c);
        if (err.code === "forbidden") return forbidden(c, "Only team admins can modify workflows");
        return c.json({ error: err.code }, 409);
      }
      throw err;
    }

    // Compute a small diff summary for the audit payload so auditors can
    // reconstruct what changed without the backend storing every
    // definition snapshot. Only include the diff when the definition
    // actually changed — a name-only update writes a lighter payload.
    const diff = body.definition
      ? summarizeWorkflowDiff(
          before.definition as unknown as WorkflowDefinitionShape,
          body.definition as unknown as WorkflowDefinitionShape,
        )
      : null;

    void logAuditEvent({
      action: "workflow.updated",
      actorId: actor.userId,
      projectId: workflow.projectId,
      payload: {
        workflowId: workflow.id,
        ...(body.name && body.name !== before.name
          ? { nameChanged: { from: before.name, to: body.name } }
          : {}),
        ...(body.isDefault !== undefined && body.isDefault !== before.isDefault
          ? { isDefaultChanged: { from: before.isDefault, to: body.isDefault } }
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
