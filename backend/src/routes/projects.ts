import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import { ensureDefaultBoardForProject } from "../services/board-default.js";

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

const updateProjectSchema = createProjectSchema.partial().omit({ teamId: true, slug: true });

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
  const requestedTeamId = c.req.query("teamId");
  let teamId: string;

  if (actor.type === "agent") {
    if (requestedTeamId && requestedTeamId !== actor.teamId) {
      return forbidden(c, "Token is only valid for its own team");
    }
    teamId = actor.teamId;
  } else {
    if (!requestedTeamId) {
      return c.json({ error: "bad_request", message: "teamId required" }, 400);
    }
    teamId = requestedTeamId;
  }

  if (!(await assertMembership(actor, teamId))) {
    return forbidden(c, "Access denied to this team");
  }

  const projects = await prisma.project.findMany({
    where: { teamId },
    orderBy: { createdAt: "desc" },
  });

  return c.json({ projects });
});

// ── List token-available projects (agent-friendly) ──────────────────────────

projectRouter.get("/projects/available", async (c) => {
  const actor = c.get("actor");
  const requestedTeamId = c.req.query("teamId");
  let teamId: string;

  if (actor.type === "agent") {
    if (requestedTeamId && requestedTeamId !== actor.teamId) {
      return forbidden(c, "Token is only valid for its own team");
    }
    teamId = actor.teamId;
  } else {
    if (!requestedTeamId) {
      return c.json({ error: "bad_request", message: "teamId required for human users" }, 400);
    }
    teamId = requestedTeamId;
  }

  if (!(await assertMembership(actor, teamId))) {
    return forbidden(c, "Access denied to this team");
  }

  const projects = await prisma.project.findMany({
    where: { teamId },
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

  if (!(await assertMembership(actor, project.teamId))) {
    return forbidden(c, "Access denied");
  }

  const body = c.req.valid("json");
  const updated = await prisma.project.update({
    where: { id: project.id },
    data: body,
  });

  return c.json({ project: updated });
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
