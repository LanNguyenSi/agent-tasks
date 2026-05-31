import type { Actor } from "../types/auth.js";
import {
  getProjectTeamId,
  getUserRoleInTeam,
  getUserRoleInProject,
} from "../repositories/team-repository.js";
import { prisma } from "../lib/prisma.js";
import type { ProjectMemberRole } from "@prisma/client";

/**
 * Outcome of resolving which team a request should act on.
 *
 * Routes call `resolveTeamId(actor, c.req.query("teamId"))` and map the
 * result into the HTTP response. Centralising the logic means every
 * team-scoped endpoint has the same "prefer explicit, fall back to the
 * user's single team membership" semantics — avoids the historical
 * "teamId required for human users" 400s that broke project-pilot's
 * identity-broker flow post-OAuth.
 */
export type ResolveTeamIdResult =
  | { ok: true; teamId: string }
  | { ok: false; status: 400; code: "multiple_teams"; message: string; teamIds: string[] }
  | { ok: false; status: 400; code: "no_teams"; message: string }
  | { ok: false; status: 403; code: "forbidden"; message: string };

/**
 * Shape the non-ok branches of `resolveTeamId` into the JSON body routes
 * emit. Avoids repeating the conditional `teamIds` spread at every caller.
 */
export function resolveTeamIdErrorBody(
  result: Extract<ResolveTeamIdResult, { ok: false }>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: result.code,
    message: result.message,
  };
  if ("teamIds" in result) body.teamIds = result.teamIds;
  return body;
}

export async function resolveTeamId(
  actor: Actor,
  requestedTeamId: string | undefined,
): Promise<ResolveTeamIdResult> {
  if (actor.type === "agent") {
    // Agent tokens carry their team implicitly. A mismatched claim is a
    // cross-team-access attempt and must fail closed.
    if (requestedTeamId && requestedTeamId !== actor.teamId) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: "Token is only valid for its own team",
      };
    }
    return { ok: true, teamId: actor.teamId };
  }

  // Human actor.
  if (requestedTeamId) {
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: requestedTeamId, userId: actor.userId } },
      select: { teamId: true },
    });
    if (!membership) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: "Access denied to this team",
      };
    }
    return { ok: true, teamId: requestedTeamId };
  }

  // No explicit teamId — default to the user's sole membership if unambiguous.
  // Order deterministically so the multiple_teams error always returns the
  // same list order for a given user (stable ID for UX / caching).
  const memberships = await prisma.teamMember.findMany({
    where: { userId: actor.userId },
    select: { teamId: true },
    orderBy: { teamId: "asc" },
  });

  if (memberships.length === 0) {
    return {
      ok: false,
      status: 400,
      code: "no_teams",
      message: "User is not a member of any team",
    };
  }
  if (memberships.length === 1) {
    return { ok: true, teamId: memberships[0]!.teamId };
  }
  return {
    ok: false,
    status: 400,
    code: "multiple_teams",
    message: "User is a member of multiple teams; specify teamId query parameter",
    teamIds: memberships.map((m) => m.teamId),
  };
}

export async function hasProjectAccess(actor: Actor, projectId: string): Promise<boolean> {
  const teamId = await getProjectTeamId(projectId);
  if (!teamId) return false;

  if (actor.type === "agent") {
    if (actor.teamId === teamId) return true;
    // Agent token's owning user may have a per-project grant even when
    // the token's team doesn't own the project. Honors the same
    // attribution principle as github-delegation: the agent acts as its
    // creator's user.
    return (await getUserRoleInProject(projectId, actor.userId)) !== null;
  }

  const teamRole = await getUserRoleInTeam(teamId, actor.userId);
  if (teamRole !== null) return true;
  return (await getUserRoleInProject(projectId, actor.userId)) !== null;
}

/**
 * Project-scope membership accessor with the source of access. Useful when
 * a route needs to know not just "is this user allowed" but "are they here
 * via team membership or via a per-project invite", e.g. to mark UI rows
 * or to scope which projects appear on the user's project list.
 *
 * Returns `null` when the actor has NO access. The "no access" answer is
 * always the literal `null`. A successful return always includes both
 * `source` and `role`, where `role: null` is reserved for the agent-via-
 * team case (agent actors don't carry a per-user team role and the
 * project-id-based access alone is the relevant fact). Distinguishing
 * "no access" from "agent in team": check the outer return shape, not the
 * `role` field.
 */
export async function getProjectMembership(
  actor: Actor,
  projectId: string,
): Promise<
  | null
  | { source: "team"; role: "ADMIN" | "HUMAN_MEMBER" | "REVIEWER" | null }
  | { source: "project"; role: ProjectMemberRole }
> {
  const teamId = await getProjectTeamId(projectId);
  if (!teamId) return null;

  if (actor.type === "agent") {
    if (actor.teamId === teamId) return { source: "team", role: null };
    const projectRole = await getUserRoleInProject(projectId, actor.userId);
    return projectRole ? { source: "project", role: projectRole } : null;
  }

  const teamRole = await getUserRoleInTeam(teamId, actor.userId);
  if (teamRole !== null) return { source: "team", role: teamRole };
  const projectRole = await getUserRoleInProject(projectId, actor.userId);
  return projectRole ? { source: "project", role: projectRole } : null;
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

/**
 * A concrete project membership role, or the `"any"` sentinel meaning
 * "any membership will do". Kept in sync with the `MemberRole` enum in
 * `prisma/schema.prisma` and the return type of `getUserRoleInTeam`.
 */
export type ProjectRole = "ADMIN" | "HUMAN_MEMBER" | "REVIEWER" | "any";

/**
 * True iff the actor holds `role` in the team that owns `projectId`,
 * or holds an equivalent PROJECT_-level role via per-project invite.
 *
 * - `role === "any"` means "any membership"; delegates to `hasProjectAccess`
 *   so agents in the owning team also pass (matches the legacy semantics
 *   of routes/tasks.ts where the `"any"` case short-circuited the role
 *   gate entirely for any actor that had already cleared project access).
 * - Concrete roles are human-only: agents always return false without a
 *   DB lookup, because the membership model assigns roles to users.
 * - Missing project returns false.
 *
 * ## Project-role to team-role mapping
 *
 * Workflow transitions are gated on the Team-side role taxonomy
 * (ADMIN / HUMAN_MEMBER / REVIEWER), but per-project members hold the
 * Project-side taxonomy (PROJECT_ADMIN / PROJECT_CONTRIBUTOR / VIEWER).
 * To let a shared project's collaborators pass team-role gates without
 * forcing every gate-aware route to know two taxonomies, this helper
 * maps:
 *
 *   PROJECT_ADMIN       → satisfies ADMIN, HUMAN_MEMBER, REVIEWER
 *   PROJECT_CONTRIBUTOR → satisfies HUMAN_MEMBER, REVIEWER
 *   PROJECT_VIEWER      → satisfies none of the role gates (read-only;
 *                         only the `"any"` membership check passes)
 *
 * Rationale: PROJECT_ADMIN is the most-privileged actor on a shared
 * project and must clear every per-project gate, otherwise an invited
 * admin would be locked out of transitions a team REVIEWER could make.
 * PROJECT_CONTRIBUTOR is the "claim + transition + review" tier.
 * PROJECT_VIEWER is read-only and intentionally does NOT clear write
 * gates. Routes that want a finer split should check the project-side
 * role directly via `getProjectMembership`.
 *
 * `isProjectAdmin` is a thin wrapper for the common `role === "ADMIN"`
 * case.
 */
export async function hasProjectRole(
  actor: Actor,
  projectId: string,
  role: ProjectRole,
): Promise<boolean> {
  if (role === "any") {
    return hasProjectAccess(actor, projectId);
  }
  if (actor.type !== "human") return false;
  const teamId = await getProjectTeamId(projectId);
  if (!teamId) return false;
  const userRole = await getUserRoleInTeam(teamId, actor.userId);
  if (userRole === role) return true;

  const projectRole = await getUserRoleInProject(projectId, actor.userId);
  if (projectRole === null) return false;

  if (role === "ADMIN") return projectRole === "PROJECT_ADMIN";
  if (role === "HUMAN_MEMBER" || role === "REVIEWER") {
    return projectRole === "PROJECT_ADMIN" || projectRole === "PROJECT_CONTRIBUTOR";
  }
  return false;
}

/**
 * Thin wrapper over `hasProjectRole(..., "ADMIN")`. Kept for call-site
 * readability on admin-gated endpoints (force transitions, workflow
 * customize/reset/PUT). Delegates all semantics to `hasProjectRole`.
 */
export async function isProjectAdmin(actor: Actor, projectId: string): Promise<boolean> {
  return hasProjectRole(actor, projectId, "ADMIN");
}

/**
 * True iff the actor may MUTATE task state in `projectId`. This is the
 * write-tier gate that task-mutating endpoints must use instead of the
 * mere-membership `hasProjectAccess`.
 *
 * The only read-only tier in the access model is the per-project
 * PROJECT_VIEWER role: a user invited to a shared project as a viewer can
 * see tasks but must not edit, delete, comment-author, attach, or wire
 * dependencies. Every other principal that already cleared project access
 * is write-capable:
 *
 *   - Agents: their write authority is gated per-endpoint by token scopes
 *     (tasks:update / tasks:comment / ...) and the agent model has no
 *     read-only tier; once `hasProjectAccess` passes they may write.
 *   - Team members (ADMIN / HUMAN_MEMBER / REVIEWER): all team roles are
 *     write-capable on tasks; the read-only restriction is project-scoped.
 *   - Per-project PROJECT_ADMIN / PROJECT_CONTRIBUTOR: write tiers.
 *
 * Fails closed: any principal without access, and any human whose only
 * grant is a PROJECT_VIEWER per-project membership, returns false.
 */
export async function requireProjectWrite(actor: Actor, projectId: string): Promise<boolean> {
  // Must hold at least baseline access first (fail closed on no access).
  if (!(await hasProjectAccess(actor, projectId))) return false;

  // Agents that cleared access are write-capable (scope-gated elsewhere).
  if (actor.type !== "human") return true;

  const teamId = await getProjectTeamId(projectId);
  if (!teamId) return false;

  // Any concrete team role is write-capable.
  if ((await getUserRoleInTeam(teamId, actor.userId)) !== null) return true;

  // Otherwise the access came via a per-project grant. PROJECT_VIEWER is
  // read-only; only the write tiers may mutate.
  const projectRole = await getUserRoleInProject(projectId, actor.userId);
  return projectRole === "PROJECT_ADMIN" || projectRole === "PROJECT_CONTRIBUTOR";
}

