import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import { createAgentToken, listAgentTokens, revokeAgentToken } from "../services/agent-token-service.js";
import { ALL_SCOPES, SCOPE_LABELS } from "../services/scopes.js";

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

const createTokenSchema = z.object({
  teamId: z.string().uuid(),
  name: z.string().min(1).max(100),
  // Reject unknown scopes at the edge so a typo ("task:update" instead of
  // "tasks:update") fails loudly at token-creation time instead of silently
  // producing a permanently-403'd token.
  scopes: z.array(z.enum(ALL_SCOPES)).default([]),
  expiresAt: z.string().datetime().optional(),
});

agentTokenRouter.get("/", async (c) => {
  const actor = c.get("actor") as Actor;
  const teamId = c.req.query("teamId");

  if (!teamId) {
    return c.json({ error: "bad_request", message: "teamId required" }, 400);
  }

  const result = await listAgentTokens(actor, teamId);
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
