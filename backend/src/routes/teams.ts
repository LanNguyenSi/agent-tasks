import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import { logAuditEvent } from "../services/audit.js";

export const teamRouter = new Hono<{ Variables: AppVariables }>();

const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes"),
});

// ── List user's teams ─────────────────────────────────────────────────────────

teamRouter.get("/teams", async (c) => {
  const actor = c.get("actor");

  if (actor.type !== "human") {
    return c.json({ teams: [] });
  }

  const memberships = await prisma.teamMember.findMany({
    where: { userId: actor.userId },
    include: {
      team: {
        include: {
          _count: { select: { members: true, projects: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const teams = memberships.map((m) => ({
    ...m.team,
    role: m.role,
    memberCount: m.team._count.members,
    projectCount: m.team._count.projects,
  }));

  return c.json({ teams });
});

// ── Create team ───────────────────────────────────────────────────────────────

teamRouter.post("/teams", zValidator("json", createTeamSchema), async (c) => {
  const actor = c.get("actor");

  if (actor.type !== "human") {
    return forbidden(c, "Agents cannot create teams");
  }

  const body = c.req.valid("json");

  // Check slug uniqueness
  const existing = await prisma.team.findUnique({ where: { slug: body.slug } });
  if (existing) {
    return c.json({ error: "conflict", message: "Team slug already taken" }, 409);
  }

  // Create team + add creator as ADMIN atomically
  const team = await prisma.$transaction(async (tx) => {
    const newTeam = await tx.team.create({
      data: { name: body.name, slug: body.slug },
    });
    await tx.teamMember.create({
      data: { teamId: newTeam.id, userId: actor.userId, role: "ADMIN" },
    });
    return newTeam;
  });

  await logAuditEvent({
    action: "project.created",
    actorId: actor.userId,
    payload: { teamId: team.id, teamName: team.name },
  });

  return c.json({ team }, 201);
});

// ── Get team ──────────────────────────────────────────────────────────────────

teamRouter.get("/teams/:id", async (c) => {
  const actor = c.get("actor");

  if (actor.type !== "human") {
    return forbidden(c);
  }

  const team = await prisma.team.findUnique({
    where: { id: c.req.param("id") },
    include: {
      members: {
        include: { user: { select: { id: true, login: true, name: true, avatarUrl: true } } },
      },
      _count: { select: { projects: true } },
    },
  });

  if (!team) return notFound(c);

  // Check membership
  const isMember = team.members.some((m) => m.userId === actor.userId);
  if (!isMember) return forbidden(c, "Not a member of this team");

  return c.json({ team });
});

// ── Invite member (by GitHub login) ──────────────────────────────────────────

teamRouter.post(
  "/teams/:id/members",
  zValidator("json", z.object({ userId: z.string().uuid(), role: z.enum(["HUMAN_MEMBER", "REVIEWER", "ADMIN"]).default("HUMAN_MEMBER") })),
  async (c) => {
    const actor = c.get("actor");

    if (actor.type !== "human") {
      return forbidden(c);
    }

    const team = await prisma.team.findUnique({ where: { id: c.req.param("id") } });
    if (!team) return notFound(c);

    // Only ADMIN can add members
    const actorMembership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: team.id, userId: actor.userId } },
    });
    if (!actorMembership || actorMembership.role !== "ADMIN") {
      return forbidden(c, "Only team admins can add members");
    }

    const { userId, role } = c.req.valid("json");

    const member = await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: team.id, userId } },
      update: { role },
      create: { teamId: team.id, userId, role },
    });

    return c.json({ member }, 201);
  },
);
