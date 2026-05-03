import { prisma } from "../lib/prisma.js";
import type { ProjectMemberRole } from "@prisma/client";

export async function getProjectTeamId(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { teamId: true },
  });
  return project?.teamId ?? null;
}

export async function getUserRoleInTeam(teamId: string, userId: string): Promise<"ADMIN" | "HUMAN_MEMBER" | "REVIEWER" | null> {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  });
  return membership?.role ?? null;
}

/**
 * Per-project membership lookup. Returns the user's role in the
 * ProjectMember table for `projectId`, or null if they have no project-
 * level grant. Independent of team membership; callers that need the
 * combined "team OR project" access should use the helpers in
 * services/team-access.ts.
 */
export async function getUserRoleInProject(
  projectId: string,
  userId: string,
): Promise<ProjectMemberRole | null> {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  return member?.role ?? null;
}

