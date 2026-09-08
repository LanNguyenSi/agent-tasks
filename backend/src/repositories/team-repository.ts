import { prisma } from "../lib/prisma.js";
import type { Prisma, ProjectMemberRole } from "@prisma/client";

export type ProjectAccessDatabase = Pick<Prisma.TransactionClient, "project" | "teamMember" | "projectMember">;

export async function getProjectTeamId(projectId: string, db: ProjectAccessDatabase = prisma): Promise<string | null> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { teamId: true },
  });
  return project?.teamId ?? null;
}

export async function getUserRoleInTeam(teamId: string, userId: string, db: ProjectAccessDatabase = prisma): Promise<"ADMIN" | "HUMAN_MEMBER" | "REVIEWER" | null> {
  const membership = await db.teamMember.findUnique({
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
  db: ProjectAccessDatabase = prisma,
): Promise<ProjectMemberRole | null> {
  const member = await db.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  return member?.role ?? null;
}

