import { createHash, randomBytes } from "node:crypto";
import type { Actor } from "../types/auth.js";
import { canManageTeamTokens, canViewTeamTokens } from "./team-access.js";
import { createToken, findActiveTokensByTeamId, findTokenById, revokeToken } from "../repositories/agent-token-repository.js";

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
