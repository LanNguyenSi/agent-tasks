import type { Context, Next } from "hono";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import type { Actor } from "../types/auth.js";

const prisma = new PrismaClient();

/**
 * Extracts and validates the actor from the request.
 * - Bearer token → AgentActor (API token)
 * - Session cookie → HumanActor (GitHub OAuth session)
 */
export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const authorization = c.req.header("Authorization");

  // Agent token auth (Bearer)
  if (authorization?.startsWith("Bearer ")) {
    const rawToken = authorization.slice(7).trim();
    const tokenHash = hashToken(rawToken);

    const token = await prisma.agentToken.findUnique({
      where: { tokenHash },
    });

    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt < new Date())) {
      return c.json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
    }

    // Update last used
    await prisma.agentToken.update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() },
    });

    const actor: Actor = {
      type: "agent",
      tokenId: token.id,
      teamId: token.teamId,
      scopes: token.scopes,
    };
    c.set("actor", actor);
    return next();
  }

  // Session auth (cookie-based — placeholder for Wave 2 OAuth)
  const sessionUserId = c.req.header("X-Session-User-Id"); // temp for dev
  if (sessionUserId) {
    const actor: Actor = { type: "human", userId: sessionUserId };
    c.set("actor", actor);
    return next();
  }

  return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
}

/** Optional auth — sets actor if present but doesn't block */
export async function optionalAuth(c: Context, next: Next): Promise<Response | void> {
  try {
    await authMiddleware(c, async () => {});
  } catch {
    // ignore auth errors
  }
  return next();
}

/** Require agent token to have a specific scope */
export function requireScope(scope: string) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const actor = c.get("actor") as Actor | undefined;
    if (!actor || actor.type !== "agent") {
      return c.json({ error: "forbidden", message: "Agent token required" }, 403);
    }
    if (!actor.scopes.includes(scope)) {
      return c.json({ error: "forbidden", message: `Token missing scope: ${scope}` }, 403);
    }
    return next();
  };
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
