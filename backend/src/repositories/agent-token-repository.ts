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
    select: { id: true, teamId: true, revokedAt: true },
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

