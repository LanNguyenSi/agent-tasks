import { createHash, randomBytes } from "node:crypto";
import type { Actor } from "../types/auth.js";
import { canManageTeamTokens, canViewTeamTokens } from "./team-access.js";
import { createToken, findActiveTokensByTeamId, findTokenById, revokeToken, updateTokenName } from "../repositories/agent-token-repository.js";

export interface CreateAgentTokenInput {
  teamId: string;
  name: string;
  scopes: string[];
  expiresAt?: string;
}

type ServiceError = "forbidden" | "not_found";

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: ServiceError };

function generateToken(): { raw: string; hash: string } {
  const raw = `at_${randomBytes(32).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

export async function listAgentTokens(actor: Actor, teamId: string): Promise<ServiceResult<{ tokens: unknown[] }>> {
  const canView = await canViewTeamTokens(actor, teamId);
  if (!canView) {
    return { ok: false, error: "forbidden" };
  }

  const tokens = await findActiveTokensByTeamId(teamId);
  return { ok: true, data: { tokens } };
}

export async function createAgentToken(actor: Actor, input: CreateAgentTokenInput): Promise<ServiceResult<{ token: unknown; rawToken: string }>> {
  const canManage = await canManageTeamTokens(actor, input.teamId);
  if (!canManage || actor.type !== "human") {
    return { ok: false, error: "forbidden" };
  }

  const { raw, hash } = generateToken();
  const token = await createToken({
    teamId: input.teamId,
    createdById: actor.userId,
    name: input.name,
    tokenHash: hash,
    scopes: input.scopes,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
  });

  return { ok: true, data: { token, rawToken: raw } };
}

export async function revokeAgentToken(actor: Actor, id: string): Promise<ServiceResult<null>> {
  const token = await findTokenById(id);
  if (!token) {
    return { ok: false, error: "not_found" };
  }

  const canManage = await canManageTeamTokens(actor, token.teamId);
  if (!canManage) {
    return { ok: false, error: "forbidden" };
  }

  if (token.revokedAt) {
    return { ok: true, data: null };
  }

  await revokeToken(token.id);
  return { ok: true, data: null };
}

/**
 * Rename an existing agent token in place, so the caller identity shown in
 * claims/signals/audit views stays meaningful without forcing a
 * revoke-and-reissue (which would also rotate the secret and break whatever
 * currently holds it).
 *
 * Authz mirrors `createAgentToken`: team admin AND a human actor. Agent
 * actors are already excluded by `canManageTeamTokens` (human-only), but the
 * explicit `actor.type !== "human"` check is kept for parity with create so
 * the two admin-gated token mutations read the same way.
 *
 * `findTokenById` runs first (mirrors `revokeAgentToken`'s ordering) so an
 * unknown id 404s even for a caller who would otherwise be forbidden.
 *
 * Renaming a revoked token is intentionally allowed: `name` is display
 * metadata, not an access control — revocation already blocks the token
 * from authenticating, and letting an admin relabel it (e.g. fixing a typo
 * before archiving) does not reopen any access.
 *
 * Denormalization note: no audit/claim/comment row stores the token's NAME
 * — audit rows key off `actorId` (a User id) and Comment/Signal rows key
 * off `authorAgentId`/`recipientAgentId` (a FK to AgentToken.id), so those
 * views re-resolve the live name on every read/render and reflect a rename
 * immediately, including for historical rows. The one exception is the
 * one-time `actorName` snapshot baked into `Signal.context` JSON at signal
 * *creation* time (see task-signal.ts `emitTaskAvailableSignal`,
 * review-signal.ts `buildSignalContext`, self-merge-notice.ts
 * `emitSelfMergeNotice`): those already-emitted signals keep the old name
 * forever — this rename does not, and should not, backfill them.
 */
export async function renameAgentToken(actor: Actor, id: string, name: string): Promise<ServiceResult<{ token: unknown }>> {
  const token = await findTokenById(id);
  if (!token) {
    return { ok: false, error: "not_found" };
  }

  const canManage = await canManageTeamTokens(actor, token.teamId);
  if (!canManage || actor.type !== "human") {
    return { ok: false, error: "forbidden" };
  }

  const updated = await updateTokenName(token.id, name);
  return { ok: true, data: { token: updated } };
}
