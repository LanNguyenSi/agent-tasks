/**
 * GitHub Delegation Service
 *
 * Finds a team member who has consented to agent delegation
 * and provides their GitHub token for API calls.
 */
import { prisma } from "../lib/prisma.js";

export type DelegationPermission = "allowAgentPrCreate" | "allowAgentPrMerge" | "allowAgentPrComment";

/**
 * Find a user in the team who has:
 * 1. GitHub connected (has access token)
 * 2. The required delegation permission enabled
 *
 * Prefers team admins over regular members.
 */
export async function findDelegationUser(teamId: string, permission: DelegationPermission) {
  const members = await prisma.teamMember.findMany({
    where: { teamId },
    include: {
      user: {
        select: {
          id: true,
          login: true,
          githubAccessToken: true,
          githubConnectedAt: true,
          allowAgentPrCreate: true,
          allowAgentPrMerge: true,
          allowAgentPrComment: true,
        },
      },
    },
    orderBy: { role: "asc" }, // ADMIN first
  });

  for (const member of members) {
    const user = member.user;
    if (user.githubAccessToken && user.githubConnectedAt && user[permission]) {
      return {
        userId: user.id,
        login: user.login,
        githubAccessToken: user.githubAccessToken,
      };
    }
  }

  return null;
}
