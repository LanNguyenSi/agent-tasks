import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import { createAgentToken, listAgentTokens, renameAgentToken, revokeAgentToken } from "../services/agent-token-service.js";
import { ALL_SCOPES, SCOPE_LABELS } from "../services/scopes.js";
import { resolveTeamId, resolveTeamIdErrorBody } from "../services/team-access.js";

export const agentTokenRouter = new Hono<{ Variables: AppVariables }>();

// GET /api/agent-tokens/scopes — the canonical scope list + human labels.
// The settings UI fetches this instead of hard-coding its own list so the
// two sources of truth stay in lockstep. Public (no team required) because
// the list is not sensitive — it's the menu of permissions a token can
// carry, not any actual grants.
agentTokenRouter.get("/scopes", (c) => {
  return c.json({
    scopes: ALL_SCOPES.map((id) => ({ id, label: SCOPE_LABELS[id] })),
  });
});

// Shared display-metadata rule for a token's `name`, used by BOTH
// createTokenSchema and renameTokenSchema below so the two token-mutating
// verbs can't drift apart on what counts as a valid name. `.trim()` runs
// before `.min(1)` in the check chain, which is a deliberate tightening
// over the old plain `.min(1)`: a whitespace-only name (e.g. "   ") now
// 400s instead of being stored verbatim, and the value actually persisted
// is always the trimmed string for both create and rename.
const tokenNameSchema = z.string().trim().min(1).max(100);

const createTokenSchema = z.object({
  teamId: z.string().uuid(),
  name: tokenNameSchema,
  // Reject unknown scopes at the edge so a typo ("task:update" instead of
  // "tasks:update") fails loudly at token-creation time instead of silently
  // producing a permanently-403'd token.
  scopes: z.array(z.enum(ALL_SCOPES)).default([]),
  expiresAt: z.string().datetime().optional(),
});

agentTokenRouter.get("/", async (c) => {
  const actor = c.get("actor") as Actor;
  const resolved = await resolveTeamId(actor, c.req.query("teamId"));
  if (!resolved.ok) {
    return c.json(
      resolveTeamIdErrorBody(resolved),
      resolved.status,
    );
  }

  const result = await listAgentTokens(actor, resolved.teamId);
  if (!result.ok) {
    return forbidden(c, "Access denied to this team");
  }

  return c.json(result.data);
});

agentTokenRouter.post(
  "/",
  zValidator("json", createTokenSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;
    const body = c.req.valid("json");
    const result = await createAgentToken(actor, body);
    if (!result.ok) {
      return forbidden(c, "Only team admins can create agent tokens");
    }

    return c.json(result.data, 201);
  },
);

// Reuses tokenNameSchema — a renamed token must satisfy the exact same
// display-metadata constraint as a freshly minted one.
const renameTokenSchema = z.object({
  name: tokenNameSchema,
});

agentTokenRouter.patch(
  "/:id",
  zValidator("json", renameTokenSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;
    const body = c.req.valid("json");
    const result = await renameAgentToken(actor, c.req.param("id"), body.name);

    if (!result.ok && result.error === "not_found") {
      return notFound(c);
    }
    if (!result.ok) {
      return forbidden(c, "Only team admins can rename agent tokens");
    }

    return c.json(result.data);
  },
);

agentTokenRouter.post("/:id/revoke", async (c) => {
  const actor = c.get("actor") as Actor;
  const result = await revokeAgentToken(actor, c.req.param("id"));

  if (!result.ok && result.error === "not_found") {
    return notFound(c);
  }
  if (!result.ok) {
    return forbidden(c, "Only team admins can revoke agent tokens");
  }

  return c.json({ message: "Token revoked" });
});
