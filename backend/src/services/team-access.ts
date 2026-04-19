import type { Actor } from "../types/auth.js";
import { getProjectTeamId, getUserRoleInTeam } from "../repositories/team-repository.js";
import { prisma } from "../lib/prisma.js";

/**
 * Outcome of resolving which team a request should act on.
 *
 * Routes call `resolveTeamId(actor, c.req.query("teamId"))` and map the
 * result into the HTTP response. Centralising the logic means every
 * team-scoped endpoint has the same "prefer explicit, fall back to the
 * user's single team membership" semantics — avoids the historical
 * "teamId required for human users" 400s that broke project-pilot's
 * identity-broker flow post-OAuth.
 */
export type ResolveTeamIdResult =
  | { ok: true; teamId: string }
  | { ok: false; status: 400; code: "multiple_teams"; message: string; teamIds: string[] }
  | { ok: false; status: 400; code: "no_teams"; message: string }
  | { ok: false; status: 403; code: "forbidden"; message: string };

/**
 * Shape the non-ok branches of `resolveTeamId` into the JSON body routes
 * emit. Avoids repeating the conditional `teamIds` spread at every caller.
 */
export function resolveTeamIdErrorBody(
  result: Extract<ResolveTeamIdResult, { ok: false }>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: result.code,
    message: result.message,
  };
  if ("teamIds" in result) body.teamIds = result.teamIds;
  return body;
}

export async function resolveTeamId(
  actor: Actor,
  requestedTeamId: string | undefined,
): Promise<ResolveTeamIdResult> {
  if (actor.type === "agent") {
    // Agent tokens carry their team implicitly. A mismatched claim is a
    // cross-team-access attempt and must fail closed.
    if (requestedTeamId && requestedTeamId !== actor.teamId) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: "Token is only valid for its own team",
      };
    }
    return { ok: true, teamId: actor.teamId };
  }

  // Human actor.
  if (requestedTeamId) {
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: requestedTeamId, userId: actor.userId } },
      select: { teamId: true },
    });
    if (!membership) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: "Access denied to this team",
      };
    }
    return { ok: true, teamId: requestedTeamId };
  }

  // No explicit teamId — default to the user's sole membership if unambiguous.
  // Order deterministically so the multiple_teams error always returns the
  // same list order for a given user (stable ID for UX / caching).
  const memberships = await prisma.teamMember.findMany({
    where: { userId: actor.userId },
    select: { teamId: true },
    orderBy: { teamId: "asc" },
  });

  if (memberships.length === 0) {
    return {
      ok: false,
      status: 400,
      code: "no_teams",
      message: "User is not a member of any team",
    };
  }
  if (memberships.length === 1) {
    return { ok: true, teamId: memberships[0]!.teamId };
  }
  return {
    ok: false,
    status: 400,
    code: "multiple_teams",
    message: "User is a member of multiple teams; specify teamId query parameter",
    teamIds: memberships.map((m) => m.teamId),
  };
}

export async function hasProjectAccess(actor: Actor, projectId: string): Promise<boolean> {
  const teamId = await getProjectTeamId(projectId);
  if (!teamId) return false;

  if (actor.type === "agent") {
    return actor.teamId === teamId;
  }

  const role = await getUserRoleInTeam(teamId, actor.userId);
  return role !== null;
}

export async function canViewTeamTokens(actor: Actor, teamId: string): Promise<boolean> {
  if (actor.type === "agent") {
    return actor.teamId === teamId;
  }

  const role = await getUserRoleInTeam(teamId, actor.userId);
  return role !== null;
}

export async function canManageTeamTokens(actor: Actor, teamId: string): Promise<boolean> {
  if (actor.type !== "human") {
    return false;
  }

  const role = await getUserRoleInTeam(teamId, actor.userId);
  return role === "ADMIN";
}

/**
 * A concrete project membership role, or the `"any"` sentinel meaning
 * "any membership will do". Kept in sync with the `MemberRole` enum in
 * `prisma/schema.prisma` and the return type of `getUserRoleInTeam`.
 */
export type ProjectRole = "ADMIN" | "HUMAN_MEMBER" | "REVIEWER" | "any";

/**
 * True iff the actor holds `role` in the team that owns `projectId`.
 *
 * - `role === "any"` means "any membership"; delegates to `hasProjectAccess`
 *   so agents in the owning team also pass (matches the legacy semantics
 *   of routes/tasks.ts where the `"any"` case short-circuited the role
 *   gate entirely for any actor that had already cleared project access).
 * - Concrete roles are human-only: agents always return false without a
 *   DB lookup, because the membership model assigns roles to users.
 * - Missing project returns false.
 *
 * Use this for every project-scoped role gate. `isProjectAdmin` is a thin
 * wrapper for the common `role === "ADMIN"` case.
 */
export async function hasProjectRole(
  actor: Actor,
  projectId: string,
  role: ProjectRole,
): Promise<boolean> {
  if (role === "any") {
    return hasProjectAccess(actor, projectId);
  }
  if (actor.type !== "human") return false;
  const teamId = await getProjectTeamId(projectId);
  if (!teamId) return false;
  const userRole = await getUserRoleInTeam(teamId, actor.userId);
  return userRole === role;
}

/**
 * Thin wrapper over `hasProjectRole(..., "ADMIN")`. Kept for call-site
 * readability on admin-gated endpoints (force transitions, workflow
 * customize/reset/PUT). Delegates all semantics to `hasProjectRole`.
 */
export async function isProjectAdmin(actor: Actor, projectId: string): Promise<boolean> {
  return hasProjectRole(actor, projectId, "ADMIN");
}

