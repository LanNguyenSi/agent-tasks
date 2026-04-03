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

