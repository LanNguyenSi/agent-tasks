/**
 * Agent Signal Routes
 *
 * Pull-based inbox for local agents. No webhook/callback required.
 *
 * GET  /api/agent/signals       — fetch unacknowledged signals for current token
 * POST /api/agent/signals/:id/ack — acknowledge a signal
 */
import { Hono } from "hono";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import { getAgentSignals, getUserSignals, acknowledgeSignal } from "../services/signal.js";

export const signalRouter = new Hono<{ Variables: AppVariables }>();

// ── Fetch signals (inbox) ───────────────────────────────────────────────────

signalRouter.get("/agent/signals", async (c) => {
  const actor = c.get("actor") as Actor;
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  if (actor.type === "agent") {
    const signals = await getAgentSignals(actor.tokenId, { limit });
    return c.json({ signals });
  }

  if (actor.type === "human") {
    const signals = await getUserSignals(actor.userId, { limit });
    return c.json({ signals });
  }

  return forbidden(c, "Unknown actor type");
});

// ── Acknowledge signal ──────────────────────────────────────────────────────

signalRouter.post("/agent/signals/:id/ack", async (c) => {
  const actor = c.get("actor") as Actor;
  const signalId = c.req.param("id");

  const updated = await acknowledgeSignal(
    signalId,
    actor.type === "agent" ? actor.tokenId : undefined,
    actor.type === "human" ? actor.userId : undefined,
  );

  if (!updated) {
    return notFound(c);
  }

  return c.json({ signal: updated });
});
