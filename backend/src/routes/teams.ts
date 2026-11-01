import { Hono } from "hono";
import { z } from "zod";
import { zValidate } from "../lib/z-validate.js";
import { teamNameSchema } from "../lib/team-name.js";
import { prisma } from "../lib/prisma.js";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import { logAuditEvent } from "../services/audit.js";
import { listUserRepos } from "../services/github-sync.js";
import { ensureDefaultBoardForProject } from "../services/board-default.js";
import { githubRepoEqualsInsensitive } from "../lib/github-repo-match.js";
import { isGithubFenceConflict } from "../services/grounding-github-fence.js";

export const teamRouter = new Hono<{ Variables: AppVariables }>();

const createTeamSchema = z.object({
  name: teamNameSchema,
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes"),
});

// The same name rule as team creation (`teamNameSchema`, lib/team-name.ts).
// The slug is not part of the body and never changes on rename.
const renameTeamSchema = z.object({
  name: teamNameSchema,
});

function toSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 100) : "project";
}

async function ensureUniqueProjectSlug(teamId: string, baseName: string): Promise<string> {
  const base = toSlug(baseName);
  let index = 0;
  while (true) {
    const slug = index === 0 ? base : `${base}-${index}`;
    const existing = await prisma.project.findUnique({
      where: { teamId_slug: { teamId, slug } },
      select: { id: true },
    });
    if (!existing) return slug;
    index += 1;
  }
}

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

teamRouter.post("/teams", zValidate("json", createTeamSchema, { message: true }), async (c) => {
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

// ── Rename team ───────────────────────────────────────────────────────────────

teamRouter.patch("/teams/:id", zValidate("json", renameTeamSchema, { message: true }), async (c) => {
  const actor = c.get("actor");

  if (actor.type !== "human") {
    return forbidden(c, "Agents cannot rename teams");
  }

  const team = await prisma.team.findUnique({ where: { id: c.req.param("id") } });
  if (!team) return notFound(c);

  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: team.id, userId: actor.userId } },
  });
  if (!membership) return forbidden(c, "Not a member of this team");
  if (membership.role !== "ADMIN") {
    return forbidden(c, "Only team admins can rename the team");
  }

  const { name } = c.req.valid("json");

  // Only the display name is written; the slug is an identifier and stays.
  const updated = await prisma.team.update({
    where: { id: team.id },
    data: { name },
  });

  // Team creation logs its event as "project.created" with a team payload;
  // the rename follows that convention with { teamId, from, to }.
  void logAuditEvent({
    action: "project.updated",
    actorId: actor.userId,
    payload: { teamId: team.id, from: team.name, to: updated.name },
  });

  return c.json({ team: updated });
});

// ── Invite member (by GitHub login) ──────────────────────────────────────────

teamRouter.post(
  "/teams/:id/members",
  zValidate("json", z.object({ userId: z.guid(), role: z.enum(["HUMAN_MEMBER", "REVIEWER", "ADMIN"]).default("HUMAN_MEMBER") })),
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

// ── Sync team projects from connected GitHub account ─────────────────────────

teamRouter.post("/teams/:id/sync", async (c) => {
  const actor = c.get("actor");
  const teamId = c.req.param("id");

  if (actor.type !== "human") {
    return forbidden(c, "Agents cannot trigger sync");
  }

  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: actor.userId } },
  });
  if (!membership) {
    return forbidden(c, "Not a member of this team");
  }

  const user = await prisma.user.findUnique({ where: { id: actor.userId } });
  if (!user?.githubAccessToken) {
    return c.json(
      { error: "forbidden", message: "Connect your GitHub account in settings before syncing" },
      403,
    );
  }

  const repos = await listUserRepos(user.githubAccessToken);
  const repoFullNames = repos.map((repo) => repo.full_name);
  const now = new Date();
  let created = 0;
  let updated = 0;
  let pruned = 0;

  let fenced = 0;
  let pruneDeferred = false;

  for (const repo of repos) {
    // GitHub repository names are case-insensitive, while `project.githubRepo`
    // keeps whatever case the binding was written in, so an exact match missed
    // the project and a duplicate was created (then pruned). The exact
    // spelling wins when it exists; otherwise the case-insensitive match
    // (LIKE-escaped, so `my_repo` never selects `my-repo`, see
    // lib/github-repo-match.ts), oldest first so two rows that differ only in
    // case resolve deterministically.
    const existingProject =
      (await prisma.project.findFirst({
        where: { teamId, githubRepo: repo.full_name },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })) ??
      (await prisma.project.findFirst({
        where: { teamId, githubRepo: githubRepoEqualsInsensitive(repo.full_name) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }));

    try {
      if (existingProject) {
        await prisma.project.update({
          where: { id: existingProject.id },
          data: {
            name: repo.name,
            description: repo.description ?? undefined,
            // GitHub's own spelling keeps the binding in step with every later
            // exact comparison (the `push` sync lookup in
            // services/github-webhook.ts). Written only when it differs, so the
            // row's fenced columns stay unchanged on a plain re-sync.
            ...(existingProject.githubRepo !== repo.full_name
              ? { githubRepo: repo.full_name }
              : {}),
            githubSyncAt: now,
          },
        });
        await ensureDefaultBoardForProject(existingProject.id);
        updated += 1;
        continue;
      }

      const slug = await ensureUniqueProjectSlug(teamId, repo.name);
      const project = await prisma.project.create({
        data: {
          teamId,
          name: repo.name,
          slug,
          description: repo.description ?? undefined,
          githubRepo: repo.full_name,
          githubSyncAt: now,
        },
      });

      await ensureDefaultBoardForProject(project.id);
      created += 1;
    } catch (err) {
      // An active repository fence refuses the write. Skip this repo and keep
      // syncing the others; the next sync retries it.
      if (!isGithubFenceConflict(err)) throw err;
      fenced += 1;
    }
  }

  // Stale bindings are picked in code (lowercased) and deleted by id. The
  // DELETE repeats the team scope and the case-insensitive `notIn` as defense
  // in depth: `mode` applies to `notIn` on the Postgres engine (checked against
  // a real database), so a binding that differs from a listed repo only in
  // letter case is never removed even if the id list were wrong.
  if (repoFullNames.length > 0) {
    const listed = new Set(repoFullNames.map((fullName) => fullName.toLowerCase()));
    const boundProjects = await prisma.project.findMany({
      where: { teamId, githubRepo: { not: null } },
      select: { id: true, githubRepo: true },
    });
    const staleIds = boundProjects
      .filter(
        (project) =>
          project.githubRepo !== null && !listed.has(project.githubRepo.toLowerCase()),
      )
      .map((project) => project.id);

    if (staleIds.length > 0) {
      try {
        const deleted = await prisma.project.deleteMany({
          where: {
            id: { in: staleIds },
            teamId,
            githubRepo: { not: null, notIn: repoFullNames, mode: "insensitive" },
          },
        });
        pruned = deleted.count;
      } catch (err) {
        // A stale binding under an active grounding fence rejects the whole
        // statement (one transaction, nothing removed). The loop above has
        // already written, so answer 200 and let the next sync retry the
        // prune instead of turning the sync into a 500.
        if (!isGithubFenceConflict(err)) throw err;
        pruneDeferred = true;
      }
    }
  }

  const skippedPrune = repoFullNames.length === 0;

  return c.json({
    synced: repos.length,
    created,
    updated,
    pruned,
    fenced,
    pruneDeferred,
    skippedPrune,
    message: skippedPrune
      ? "GitHub sync returned 0 repositories; prune was skipped for safety."
      : `Synced ${repos.length} repositories (${created} created, ${updated} updated, ${pruned} pruned)` +
        (fenced > 0
          ? `; ${fenced} skipped because a repository operation is in flight, sync again shortly`
          : "") +
        (pruneDeferred
          ? "; removal of stale projects was postponed because a repository operation is in flight, sync again shortly"
          : ""),
  });
});
