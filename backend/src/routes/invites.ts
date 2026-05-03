/**
 * Per-project invitation endpoints.
 *
 * Two routers live in this module:
 *
 *   - `projectInviteAdminRouter` mounts under `/api`. It carries the
 *     project-admin-only routes for creating, listing, revoking invites
 *     and removing project members. Reuses the existing `/api/projects/*`
 *     auth middleware (set up in app.ts) — the path-prefix match catches
 *     these endpoints because they all live under `/projects/:id/`.
 *
 *   - `inviteAcceptRouter` mounts under `/api/invites`. It carries the
 *     token-keyed preview/accept endpoints used by an authenticated user
 *     who clicked a share link. A separate auth-middleware mount in
 *     app.ts keeps the path simple.
 *
 * Plain invite tokens are returned exactly once at creation time. The
 * persisted `tokenHash` follows the same sha256 pattern as agent_tokens
 * so the same threat model applies: token-database read does not yield
 * usable invites.
 */
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { ProjectMemberRole } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import { isProjectAdmin, hasProjectAccess } from "../services/team-access.js";
import { getUserRoleInTeam } from "../repositories/team-repository.js";
import { logAuditEvent } from "../services/audit.js";

export const projectInviteAdminRouter = new Hono<{ Variables: AppVariables }>();
export const inviteAcceptRouter = new Hono<{ Variables: AppVariables }>();

const PROJECT_ROLES = ["PROJECT_VIEWER", "PROJECT_CONTRIBUTOR", "PROJECT_ADMIN"] as const;
const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS = 30;

const createInviteSchema = z.object({
  role: z.enum(PROJECT_ROLES),
  expiresInDays: z.number().int().min(1).max(MAX_TTL_DAYS).optional(),
});

const acceptInviteSchema = z.object({
  token: z.string().min(1),
});

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateInviteToken(): { raw: string; hash: string } {
  const raw = `inv_${randomBytes(24).toString("hex")}`;
  return { raw, hash: hashToken(raw) };
}

function publicInvite(invite: {
  id: string;
  projectId: string;
  role: ProjectMemberRole;
  createdById: string;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedById: string | null;
  createdAt: Date;
}) {
  return {
    id: invite.id,
    projectId: invite.projectId,
    role: invite.role,
    createdById: invite.createdById,
    expiresAt: invite.expiresAt,
    consumedAt: invite.consumedAt,
    consumedById: invite.consumedById,
    createdAt: invite.createdAt,
    status:
      invite.consumedAt !== null
        ? ("consumed" as const)
        : invite.expiresAt < new Date()
          ? ("expired" as const)
          : ("pending" as const),
  };
}

// ── Project-scoped admin routes ──────────────────────────────────────────────

projectInviteAdminRouter.post(
  "/projects/:id/invites",
  zValidator("json", createInviteSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;
    if (actor.type !== "human") {
      return forbidden(c, "Only human admins can create invites");
    }

    const projectId = c.req.param("id");
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, teamId: true, name: true },
    });
    if (!project) return notFound(c);

    if (!(await isProjectAdmin(actor, projectId))) {
      return forbidden(c, "Only project admins can create invites");
    }

    const body = c.req.valid("json");

    // Privilege-escalation guard: granting PROJECT_ADMIN must require team-
    // ADMIN authority, not just project-admin authority. Otherwise a
    // PROJECT_ADMIN (who themselves got there via a per-project invite)
    // could mint additional admin invites and the role would multiply
    // outside team oversight. Aligns with the rule that team-level role
    // assignment stays gated to team admins.
    if (body.role === "PROJECT_ADMIN") {
      const teamRole = await getUserRoleInTeam(project.teamId, actor.userId);
      if (teamRole !== "ADMIN") {
        return forbidden(
          c,
          "Only team admins can mint PROJECT_ADMIN invites",
        );
      }
    }

    const ttlDays = body.expiresInDays ?? DEFAULT_TTL_DAYS;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    const { raw, hash } = generateInviteToken();

    const invite = await prisma.projectInvite.create({
      data: {
        projectId,
        tokenHash: hash,
        role: body.role,
        createdById: actor.userId,
        expiresAt,
      },
    });

    void logAuditEvent({
      action: "project.invite_created",
      actorId: actor.userId,
      projectId,
      payload: { inviteId: invite.id, role: body.role, expiresAt },
    });

    return c.json(
      {
        invite: publicInvite(invite),
        plainToken: raw,
      },
      201,
    );
  },
);

projectInviteAdminRouter.get("/projects/:id/invites", async (c) => {
  const actor = c.get("actor") as Actor;
  const projectId = c.req.param("id");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) return notFound(c);

  if (!(await isProjectAdmin(actor, projectId))) {
    return forbidden(c, "Only project admins can view invites");
  }

  const invites = await prisma.projectInvite.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });

  return c.json({ invites: invites.map(publicInvite) });
});

projectInviteAdminRouter.delete("/projects/:id/invites/:inviteId", async (c) => {
  const actor = c.get("actor") as Actor;
  const projectId = c.req.param("id");
  const inviteId = c.req.param("inviteId");

  const invite = await prisma.projectInvite.findUnique({
    where: { id: inviteId },
    select: { id: true, projectId: true, consumedAt: true, expiresAt: true },
  });
  if (!invite || invite.projectId !== projectId) return notFound(c);

  if (!(await isProjectAdmin(actor, projectId))) {
    return forbidden(c, "Only project admins can revoke invites");
  }

  // Already consumed: nothing to revoke. Already expired: idempotent no-op.
  // Both paths still log the operator's intent for the audit trail.
  if (invite.consumedAt === null && invite.expiresAt > new Date()) {
    await prisma.projectInvite.update({
      where: { id: inviteId },
      data: { expiresAt: new Date() },
    });
  }

  void logAuditEvent({
    action: "project.invite_revoked",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId,
    payload: { inviteId, alreadyConsumed: invite.consumedAt !== null },
  });

  return c.json({ success: true });
});

projectInviteAdminRouter.delete("/projects/:id/members/:userId", async (c) => {
  const actor = c.get("actor") as Actor;
  const projectId = c.req.param("id");
  const targetUserId = c.req.param("userId");

  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: targetUserId } },
    select: { id: true, role: true, userId: true },
  });
  if (!member) return notFound(c);

  // Self-removal is permitted regardless of admin status; the user is
  // declining the share. Otherwise project-admin authority is required.
  const selfRemoval = actor.type === "human" && actor.userId === targetUserId;
  if (!selfRemoval) {
    if (!(await isProjectAdmin(actor, projectId))) {
      return forbidden(c, "Only project admins can remove members");
    }
  }

  // Auto-release any active claims the removed user holds on tasks in
  // this project, so the task pool reflects the membership change. The
  // task history retains the original claim trail; only the live claim
  // pointer clears.
  const releasedClaims = await prisma.task.updateMany({
    where: {
      projectId,
      OR: [
        { claimedByUserId: targetUserId, status: { not: "done" } },
        { reviewClaimedByUserId: targetUserId, status: "review" },
      ],
    },
    data: {
      claimedByUserId: null,
      claimedAt: null,
      reviewClaimedByUserId: null,
      reviewClaimedAt: null,
    },
  });

  await prisma.projectMember.delete({ where: { id: member.id } });

  void logAuditEvent({
    action: "project.member_removed",
    actorId: actor.type === "human" ? actor.userId : undefined,
    projectId,
    payload: {
      removedUserId: targetUserId,
      removedRole: member.role,
      selfRemoval,
      claimsReleased: releasedClaims.count,
    },
  });

  return c.json({ success: true, claimsReleased: releasedClaims.count });
});

// ── Token-scoped accept routes ───────────────────────────────────────────────

inviteAcceptRouter.post(
  "/preview",
  zValidator("json", acceptInviteSchema),
  async (c) => {
    const { token } = c.req.valid("json");
    const hash = hashToken(token);
    const invite = await prisma.projectInvite.findUnique({
      where: { tokenHash: hash },
      include: {
        project: { select: { id: true, name: true, slug: true, teamId: true } },
        createdBy: { select: { login: true } },
      },
    });

    if (!invite) {
      return c.json({ error: "invalid_token", message: "Invite not found" }, 400);
    }
    if (invite.consumedAt !== null) {
      return c.json({ error: "consumed", message: "Invite already used" }, 400);
    }
    if (invite.expiresAt < new Date()) {
      return c.json({ error: "expired", message: "Invite has expired" }, 400);
    }

    return c.json({
      preview: {
        projectId: invite.project.id,
        projectName: invite.project.name,
        projectSlug: invite.project.slug,
        ownerLogin: invite.createdBy.login,
        role: invite.role,
        expiresAt: invite.expiresAt,
      },
    });
  },
);

inviteAcceptRouter.post(
  "/accept",
  zValidator("json", acceptInviteSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;
    if (actor.type !== "human") {
      return forbidden(c, "Only human users can accept invites");
    }

    const { token } = c.req.valid("json");
    const hash = hashToken(token);
    const invite = await prisma.projectInvite.findUnique({
      where: { tokenHash: hash },
    });

    if (!invite) {
      return c.json({ error: "invalid_token", message: "Invite not found" }, 400);
    }
    if (invite.consumedAt !== null) {
      return c.json({ error: "consumed", message: "Invite already used" }, 400);
    }
    if (invite.expiresAt < new Date()) {
      return c.json({ error: "expired", message: "Invite has expired" }, 400);
    }

    // Already a member through any path (TeamMember or ProjectMember)
    // → 409 conflict, do NOT consume the invite. Lets the operator
    // either hand the invite to someone else or revoke it.
    if (await hasProjectAccess(actor, invite.projectId)) {
      return c.json(
        { error: "already_member", message: "You already have access to this project" },
        409,
      );
    }

    // Consume + grant in a single transaction so a partial failure does
    // not leave a "consumed but no membership" or "membership but token
    // still claimable" state. The invite's tokenHash unique constraint
    // is the additional anti-replay guarantee at the DB level.
    try {
      await prisma.$transaction([
        prisma.projectMember.create({
          data: {
            projectId: invite.projectId,
            userId: actor.userId,
            role: invite.role,
            invitedById: invite.createdById,
          },
        }),
        prisma.projectInvite.update({
          where: { id: invite.id },
          data: { consumedAt: new Date(), consumedById: actor.userId },
        }),
      ]);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return c.json(
          { error: "already_member", message: "You already have access to this project" },
          409,
        );
      }
      throw err;
    }

    void logAuditEvent({
      action: "project.invite_consumed",
      actorId: actor.userId,
      projectId: invite.projectId,
      payload: { inviteId: invite.id, role: invite.role },
    });

    return c.json(
      {
        success: true,
        projectId: invite.projectId,
        role: invite.role,
      },
      201,
    );
  },
);
