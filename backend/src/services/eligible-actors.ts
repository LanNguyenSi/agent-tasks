import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Project-scoped enumeration of the actors that may hold a task claim, used by
 * `GET /projects/:id/eligible-actors` and by the admin claim reassignment
 * (`POST /tasks/:id/admin-reassign`), which validates its target against this
 * exact set so the two can never drift apart.
 *
 * Humans: ProjectMember users (PROJECT_VIEWER excluded: that tier is
 * read-only and cannot hold a claim) union TeamMember users of the project's
 * team, deduped by userId. A user present through both paths is reported once,
 * as a team member, which is the same precedence `getProjectMembership` uses.
 *
 * Agents: the non-revoked, non-expired AgentToken rows of the project's team.
 */
export type EligibleActorsDatabase = Pick<
  Prisma.TransactionClient,
  "project" | "projectMember" | "teamMember" | "agentToken"
>;

export interface EligibleHuman {
  userId: string;
  name: string;
  source: "team" | "project";
  role: string;
}

export interface EligibleAgent {
  tokenId: string;
  name: string;
}

export interface EligibleActors {
  humans: EligibleHuman[];
  agents: EligibleAgent[];
}

/** The eligible actors of `projectId`, or `null` when the project does not exist. */
export async function listEligibleActors(
  projectId: string,
  db: EligibleActorsDatabase = prisma,
  now: Date = new Date(),
): Promise<EligibleActors | null> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { teamId: true } });
  if (!project) return null;

  const [teamMembers, projectMembers, tokens] = await Promise.all([
    db.teamMember.findMany({
      where: { teamId: project.teamId },
      select: { userId: true, role: true, user: { select: { name: true, login: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.projectMember.findMany({
      where: { projectId, role: { not: "PROJECT_VIEWER" } },
      select: { userId: true, role: true, user: { select: { name: true, login: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.agentToken.findMany({
      where: {
        teamId: project.teamId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true, name: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const humans = new Map<string, EligibleHuman>();
  for (const m of teamMembers) {
    humans.set(m.userId, { userId: m.userId, name: m.user.name ?? m.user.login, source: "team", role: m.role });
  }
  for (const m of projectMembers) {
    if (humans.has(m.userId)) continue;
    humans.set(m.userId, { userId: m.userId, name: m.user.name ?? m.user.login, source: "project", role: m.role });
  }

  return {
    humans: [...humans.values()],
    agents: tokens.map((t) => ({ tokenId: t.id, name: t.name })),
  };
}
