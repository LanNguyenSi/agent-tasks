/**
 * GitHub Delegation Service
 *
 * Resolves which user's GitHub access token is used when an agent (or
 * a route acting on behalf of an agent) needs to call the GitHub API.
 *
 * Resolution order:
 *   1. `opts.preferUserId` if that user is a team member with the
 *      required consent and a connected GitHub. This is the actor-aware
 *      path: the user who owns the agent token (or the human actor
 *      themselves) acts under their own GitHub identity.
 *   2. Team-wide pool fallback: any team member with the required
 *      consent and a connected GitHub. Admins are preferred over regular
 *      members. This preserves the legacy behavior so workflows where
 *      the token owner has not connected GitHub still succeed via a
 *      consenting teammate.
 *
 * Returns null when neither path produces a candidate.
 */
import { prisma } from "../lib/prisma.js";

export type DelegationPermission = "allowAgentPrCreate" | "allowAgentPrMerge" | "allowAgentPrComment";

export interface DelegationUser {
  userId: string;
  login: string;
  githubAccessToken: string;
}

export interface DelegationOptions {
  preferUserId?: string;
}

const userSelect = {
  id: true,
  login: true,
  githubAccessToken: true,
  githubConnectedAt: true,
  allowAgentPrCreate: true,
  allowAgentPrMerge: true,
  allowAgentPrComment: true,
} as const;

type DelegationCandidate = {
  id: string;
  login: string;
  githubAccessToken: string | null;
  githubConnectedAt: Date | null;
  allowAgentPrCreate: boolean;
  allowAgentPrMerge: boolean;
  allowAgentPrComment: boolean;
};

function pickIfEligible(
  user: DelegationCandidate | null | undefined,
  permission: DelegationPermission,
): DelegationUser | null {
  if (!user) return null;
  if (!user.githubAccessToken) return null;
  if (!user.githubConnectedAt) return null;
  if (!user[permission]) return null;
  return {
    userId: user.id,
    login: user.login,
    githubAccessToken: user.githubAccessToken,
  };
}

export async function findDelegationUser(
  teamId: string,
  permission: DelegationPermission,
  opts: DelegationOptions = {},
): Promise<DelegationUser | null> {
  if (opts.preferUserId) {
    const preferred = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: opts.preferUserId } },
      include: { user: { select: userSelect } },
    });
    const eligible = pickIfEligible(preferred?.user, permission);
    if (eligible) return eligible;
  }

  const members = await prisma.teamMember.findMany({
    where: { teamId },
    include: { user: { select: userSelect } },
    orderBy: { role: "asc" }, // ADMIN first
  });

  for (const member of members) {
    const eligible = pickIfEligible(member.user, permission);
    if (eligible) return eligible;
  }

  return null;
}
