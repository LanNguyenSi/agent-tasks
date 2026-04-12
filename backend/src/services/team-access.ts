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
 * True iff the actor is a human with the ADMIN role in the team that owns
 * the given project. Agents always return false — force and workflow
 * mutations are human-only decisions. The project must exist; a missing
 * project returns false.
 *
 * Consolidated from prior inline duplicates in routes/tasks.ts (force
 * path) and routes/workflows.ts (customize/reset/PUT gate). Reuse this
 * helper for every future admin-gated project-scoped endpoint.
 */
export async function isProjectAdmin(actor: Actor, projectId: string): Promise<boolean> {
  if (actor.type !== "human") return false;
  const teamId = await getProjectTeamId(projectId);
  if (!teamId) return false;
  const role = await getUserRoleInTeam(teamId, actor.userId);
  return role === "ADMIN";
}

