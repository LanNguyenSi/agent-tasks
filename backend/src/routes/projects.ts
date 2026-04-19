import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import { ensureDefaultBoardForProject } from "../services/board-default.js";
import { taskTemplateSchema } from "../lib/confidence.js";
import { isProjectAdmin, resolveTeamId, resolveTeamIdErrorBody } from "../services/team-access.js";
import { logAuditEvent } from "../services/audit.js";

export const projectRouter = new Hono<{ Variables: AppVariables }>();

const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes"),
  description: z.string().optional(),
  teamId: z.string().uuid(),
  githubRepo: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, "GitHub repo format: owner/repo")
    .optional(),
});

const updateProjectSchema = createProjectSchema.partial().omit({ teamId: true, slug: true }).extend({
  taskTemplate: taskTemplateSchema.nullable().optional(),
  confidenceThreshold: z.number().int().min(0).max(100).optional(),
  requireDistinctReviewer: z.boolean().optional(),
  soloMode: z.boolean().optional(),
});

async function assertMembership(actor: Actor, teamId: string): Promise<boolean> {
  if (actor.type === "agent") {
    return actor.teamId === teamId;
  }
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: actor.userId } },
  });
  return !!membership;
}

// ── List projects ─────────────────────────────────────────────────────────────

projectRouter.get("/projects", async (c) => {
  const actor = c.get("actor");
  const resolved = await resolveTeamId(actor, c.req.query("teamId"));
  if (!resolved.ok) {
    return c.json(
      resolveTeamIdErrorBody(resolved),
      resolved.status,
    );
  }

  const projects = await prisma.project.findMany({
    where: { teamId: resolved.teamId },
    orderBy: { createdAt: "desc" },
  });

  return c.json({ projects });
});

// ── List token-available projects (agent-friendly) ──────────────────────────

projectRouter.get("/projects/available", async (c) => {
  const actor = c.get("actor");
  const resolved = await resolveTeamId(actor, c.req.query("teamId"));
  if (!resolved.ok) {
    return c.json(
      resolveTeamIdErrorBody(resolved),
      resolved.status,
    );
  }

  const projects = await prisma.project.findMany({
    where: { teamId: resolved.teamId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      githubRepo: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return c.json({
    projects: projects.map((project) => ({
      ...project,
      displayName: `${project.name} (${project.slug})`,
    })),
  });
});

// ── Get project by slug ──────────────────────────────────────────────────────

projectRouter.get("/projects/by-slug/:slug", async (c) => {
  const actor = c.get("actor");
  const slug = c.req.param("slug");

  const resolved = await resolveTeamId(actor, c.req.query("teamId"));
  if (!resolved.ok) {
    return c.json(
      resolveTeamIdErrorBody(resolved),
      resolved.status,
    );
  }
  const teamId = resolved.teamId;

  const project = await prisma.project.findUnique({
    where: { teamId_slug: { teamId, slug } },
  });

  if (!project) return notFound(c);

  return c.json({ project });
});

// ── Create project ────────────────────────────────────────────────────────────

projectRouter.post("/projects", zValidator("json", createProjectSchema), async (c) => {
  const actor = c.get("actor");
  const body = c.req.valid("json");

  // Only humans can create projects
  if (actor.type === "agent") {
    return forbidden(c, "Agents cannot create projects");
  }

  if (!(await assertMembership(actor, body.teamId))) {
    return forbidden(c, "Access denied to this team");
  }

  // Check slug uniqueness within team
  const existing = await prisma.project.findUnique({
    where: { teamId_slug: { teamId: body.teamId, slug: body.slug } },
  });
  if (existing) {
    return c.json({ error: "conflict", message: "Project slug already exists in this team" }, 409);
  }

  const project = await prisma.project.create({
    data: {
      teamId: body.teamId,
      name: body.name,
      slug: body.slug,
      description: body.description,
      githubRepo: body.githubRepo,
    },
  });

  await ensureDefaultBoardForProject(project.id);

  return c.json({ project }, 201);
});

// ── Get project ───────────────────────────────────────────────────────────────

projectRouter.get("/projects/:id", async (c) => {
  const actor = c.get("actor");
  const project = await prisma.project.findUnique({
    where: { id: c.req.param("id") },
  });

  if (!project) return notFound(c);

  if (!(await assertMembership(actor, project.teamId))) {
    return forbidden(c, "Access denied");
  }

  return c.json({ project });
});

// ── Update project ────────────────────────────────────────────────────────────

projectRouter.patch("/projects/:id", zValidator("json", updateProjectSchema), async (c) => {
  const actor = c.get("actor");

  if (actor.type === "agent") {
    return forbidden(c, "Agents cannot update projects");
  }

  const project = await prisma.project.findUnique({ where: { id: c.req.param("id") } });
  if (!project) return notFound(c);

  // Project settings carry governance semantics (confidence threshold,
  // distinct-reviewer gate, task template). Any team member used to be
  // able to flip these — which means a careless or malicious member could
  // silently disable the distinct-reviewer gate before self-approving
  // a task. Require admin on the whole PATCH path, matching the existing
  // `DELETE /projects/:id` check above.
  if (!(await isProjectAdmin(actor, project.id))) {
    return forbidden(c, "Only team admins can update project settings");
  }

  const body = c.req.valid("json");
  const { taskTemplate, ...rest } = body;
  const data: Prisma.ProjectUpdateInput = { ...rest };
  if (taskTemplate !== undefined) {
    data.taskTemplate = taskTemplate === null ? Prisma.JsonNull : taskTemplate;
  }
  const updated = await prisma.project.update({
    where: { id: project.id },
    data,
  });

  // Audit the toggle so flipping the governance flag is traceable.
  // Scoped to the fields that carry real authorization meaning —
  // cosmetic renames are covered by updatedAt.
  const governanceChange: Record<string, unknown> = {};
  if (body.requireDistinctReviewer !== undefined && body.requireDistinctReviewer !== project.requireDistinctReviewer) {
    governanceChange.requireDistinctReviewer = {
      from: project.requireDistinctReviewer,
      to: body.requireDistinctReviewer,
    };
  }
  if (body.confidenceThreshold !== undefined && body.confidenceThreshold !== project.confidenceThreshold) {
    governanceChange.confidenceThreshold = {
      from: project.confidenceThreshold,
      to: body.confidenceThreshold,
    };
  }
  if (body.soloMode !== undefined && body.soloMode !== project.soloMode) {
    governanceChange.soloMode = {
      from: project.soloMode,
      to: body.soloMode,
    };
  }
  if (Object.keys(governanceChange).length > 0) {
    void logAuditEvent({
      action: "project.updated",
      actorId: actor.userId,
      projectId: project.id,
      payload: { changes: governanceChange },
    });
  }

  return c.json({ project: updated });
});

// ── Delete project ────────────────────────────────────────────────────────────

projectRouter.delete("/projects/:id", async (c) => {
  const actor = c.get("actor");

  if (actor.type === "agent") {
    return forbidden(c, "Agents cannot delete projects");
  }

  const project = await prisma.project.findUnique({ where: { id: c.req.param("id") } });
  if (!project) return notFound(c);

  if (!(await assertMembership(actor, project.teamId))) {
    return forbidden(c, "Access denied");
  }

  await prisma.project.delete({ where: { id: project.id } });

  return c.json({ success: true });
});

// ── GitHub sync trigger (placeholder for Wave 3) ─────────────────────────────

projectRouter.post("/projects/:id/sync", async (c) => {
  const actor = c.get("actor");

  if (actor.type === "agent") {
    return forbidden(c, "Agents cannot trigger project sync");
  }

  const project = await prisma.project.findUnique({ where: { id: c.req.param("id") } });
  if (!project) return notFound(c);

  if (!(await assertMembership(actor, project.teamId))) {
    return forbidden(c, "Access denied");
  }

  if (!project.githubRepo) {
    return c.json({ error: "bad_request", message: "Project has no GitHub repository configured" }, 400);
  }

  const user = await prisma.user.findUnique({ where: { id: actor.userId } });
  if (!user?.githubAccessToken) {
    return c.json(
      { error: "forbidden", message: "Connect your GitHub account in settings before syncing" },
      403,
    );
  }

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { githubSyncAt: new Date() },
  });

  await ensureDefaultBoardForProject(updated.id);

  return c.json({ project: updated, message: "Sync initiated (Wave 3: full implementation)" });
});
