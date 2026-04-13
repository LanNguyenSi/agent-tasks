import type { Actor } from "../types/auth.js";
import { getProjectTeamId, getUserRoleInTeam } from "../repositories/team-repository.js";

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

