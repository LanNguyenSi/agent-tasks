import type { Prisma } from "@prisma/client";
import type { Actor } from "../types/auth.js";
import { GroundingAccessError } from "./grounding-context.js";

/** Call after the parent lock. A grant changed while waiting must refresh the Serializable snapshot. */
export async function lockGroundingAuthority(db: Prisma.TransactionClient, actor: Actor, projectId: string) {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { teamId: true } });
  if (!project) throw new GroundingAccessError("not_found", 404);
  await db.$queryRaw`SELECT id FROM team_members WHERE "teamId" = ${project.teamId} AND "userId" = ${actor.userId} FOR SHARE`;
  await db.$queryRaw`SELECT id FROM project_members WHERE "projectId" = ${projectId} AND "userId" = ${actor.userId} FOR SHARE`;
  if (actor.type === "agent") {
    await db.$queryRaw`SELECT id FROM agent_tokens WHERE id = ${actor.tokenId} FOR SHARE`;
    const token = await db.agentToken.findUnique({ where: { id: actor.tokenId } });
    // Match middleware identity and validity, and reject scopes revoked since admission.
    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt < new Date()) || token.teamId !== actor.teamId || token.createdById !== actor.userId || actor.scopes.some(scope => !token.scopes.includes(scope))) throw new GroundingAccessError("forbidden", 403);
  }
}
