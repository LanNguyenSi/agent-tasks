import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import type { Actor } from "../types/auth.js";
import { forbidden, notFound } from "../middleware/error.js";

export const agentTokenRouter = new Hono();

const createTokenSchema = z.object({
  teamId: z.string().uuid(),
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).default([]),
  expiresAt: z.string().datetime().optional(),
});

function generateToken(): { raw: string; hash: string } {
  const raw = `at_${randomBytes(32).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

agentTokenRouter.get("/", async (c) => {
  const actor = c.get("actor") as Actor;
  const teamId = c.req.query("teamId");

  if (!teamId) {
    return c.json({ error: "bad_request", message: "teamId required" }, 400);
  }

  const tokens = await prisma.agentToken.findMany({
    where: { teamId, revokedAt: null },
    select: {
      id: true,
      name: true,
      scopes: true,
      expiresAt: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });

  return c.json({ tokens });
});

agentTokenRouter.post(
  "/",
  zValidator("json", createTokenSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;

    // Only admins can create tokens
    if (actor.type !== "human") {
      return forbidden(c, "Only humans can create agent tokens");
    }

    const body = c.req.valid("json");
    const { raw, hash } = generateToken();

    const token = await prisma.agentToken.create({
      data: {
        teamId: body.teamId,
        createdById: actor.userId,
        name: body.name,
        tokenHash: hash,
        scopes: body.scopes,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
      select: {
        id: true,
        name: true,
        scopes: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    return c.json({ token, rawToken: raw }, 201);
  },
);

agentTokenRouter.post("/:id/revoke", async (c) => {
  const actor = c.get("actor") as Actor;

  if (actor.type !== "human") {
    return forbidden(c);
  }

  const token = await prisma.agentToken.findUnique({
    where: { id: c.req.param("id") },
  });

  if (!token) return notFound(c);

  await prisma.agentToken.update({
    where: { id: token.id },
    data: { revokedAt: new Date() },
  });

  return c.json({ message: "Token revoked" });
});
