import { prisma } from "../lib/prisma.js";

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

