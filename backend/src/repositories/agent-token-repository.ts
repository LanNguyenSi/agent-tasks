import { prisma } from "../lib/prisma.js";

export function findActiveTokensByTeamId(teamId: string) {
  return prisma.agentToken.findMany({
    where: { teamId, revokedAt: null },
    select: {
      id: true,
      name: true,
      scopes: true,
      expiresAt: true,
      lastUsedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export function findTokenById(id: string) {
  return prisma.agentToken.findUnique({
    where: { id },
    // `name` is selected so callers (renameAgentToken) can capture the
    // pre-rename value for the `token.renamed` audit event's `from` field.
    select: { id: true, teamId: true, name: true, revokedAt: true },
  });
}

export function createToken(params: {
  teamId: string;
  createdById: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  expiresAt: Date | null;
}) {
  return prisma.agentToken.create({
    data: params,
    select: {
      id: true,
      name: true,
      scopes: true,
      expiresAt: true,
      createdAt: true,
    },
  });
}

export function revokeToken(id: string) {
  return prisma.agentToken.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
}

export function updateTokenName(id: string, name: string) {
  return prisma.agentToken.update({
    where: { id },
    data: { name },
    // Field-identical to findActiveTokensByTeamId's list-row select (no
    // `revokedAt`) so a rename response has the same shape as a list row.
    select: {
      id: true,
      name: true,
      scopes: true,
      expiresAt: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });
}

