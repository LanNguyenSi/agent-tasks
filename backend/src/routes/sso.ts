/**
 * SSO (OIDC) routes
 *
 *  GET  /api/auth/sso/discover?email=… — returns login URL for the IdP that
 *                                         owns the email domain, if any.
 *  GET  /api/auth/sso/:teamSlug         — kicks off the OIDC auth code flow.
 *  GET  /api/auth/sso/:teamSlug/callback — handles the IdP callback.
 *
 *  GET  /api/teams/:teamId/sso          — read team's SSO connection (admin)
 *  PUT  /api/teams/:teamId/sso          — create/update (admin)
 *  DELETE /api/teams/:teamId/sso        — remove (admin)
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import { config } from "../config/index.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import {
  buildAuthorizeUrl,
  discover,
  exchangeCode,
  generatePkcePair,
  invalidateDiscovery,
  randomToken,
  verifyIdToken,
} from "../services/oidc.js";
import {
  decryptClientSecret,
  deleteSsoConnection,
  findSsoConnectionForEmail,
  getSsoConnectionByTeamId,
  getSsoConnectionByTeamSlug,
  publicSsoConnection,
  upsertSsoConnection,
  upsertUserFromOidc,
} from "../services/sso.js";
import { createSessionToken, buildSessionCookie } from "../services/session.js";

// Public login-flow endpoints: mounted under /api/auth.
export const ssoLoginRouter = new Hono<{ Variables: AppVariables }>();
// Admin CRUD endpoints: mounted under /api and gated by /api/teams/* auth.
export const ssoAdminRouter = new Hono<{ Variables: AppVariables }>();

// ── Cookie helpers (scoped to this file to avoid coupling to auth.ts) ────────

const STATE_COOKIE = "sso_state";
const NONCE_COOKIE = "sso_nonce";
const TEAM_COOKIE = "sso_team";
const PKCE_COOKIE = "sso_pkce";
const COOKIE_TTL = 600; // 10 min — enough for the round-trip, short enough to limit replay.

function buildCookie(name: string, value: string, maxAge: number, secure: boolean): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    "Path=/",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name: string): string {
  return `${name}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`;
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

function buildRedirectUri(teamSlug: string): string {
  return `${config.BACKEND_URL.replace(/\/+$/, "")}/api/auth/sso/${encodeURIComponent(teamSlug)}/callback`;
}

// ── Login flow: discovery (public) ───────────────────────────────────────────

ssoLoginRouter.get("/sso/discover", async (c) => {
  const email = c.req.query("email");
  if (!email) {
    return c.json({ connection: null });
  }
  const match = await findSsoConnectionForEmail(email);
  if (!match) {
    return c.json({ connection: null });
  }
  return c.json({
    connection: {
      teamSlug: match.team.slug,
      teamName: match.team.name,
      displayName: match.displayName,
      loginUrl: `/api/auth/sso/${encodeURIComponent(match.team.slug)}`,
    },
  });
});

// ── Login flow: authorize ────────────────────────────────────────────────────

ssoLoginRouter.get("/sso/:teamSlug", async (c) => {
  const teamSlug = c.req.param("teamSlug");
  const result = await getSsoConnectionByTeamSlug(teamSlug);
  if (!result || !result.connection.enabled) {
    return c.json({ error: "not_found", message: "SSO not configured for this team" }, 404);
  }
  const { connection } = result;

  try {
    const { discovery } = await discover(connection.issuer);
    const state = randomToken(16);
    const nonce = randomToken(16);
    const pkce = await generatePkcePair();
    const redirectUri = buildRedirectUri(teamSlug);
    const url = buildAuthorizeUrl({
      discovery,
      clientId: connection.clientId,
      redirectUri,
      state,
      nonce,
      codeChallenge: pkce.challenge,
    });

    const isSecure = config.NODE_ENV === "production";
    c.header("Set-Cookie", buildCookie(STATE_COOKIE, state, COOKIE_TTL, isSecure), { append: true });
    c.header("Set-Cookie", buildCookie(NONCE_COOKIE, nonce, COOKIE_TTL, isSecure), { append: true });
    c.header("Set-Cookie", buildCookie(TEAM_COOKIE, teamSlug, COOKIE_TTL, isSecure), { append: true });
    c.header("Set-Cookie", buildCookie(PKCE_COOKIE, pkce.verifier, COOKIE_TTL, isSecure), { append: true });
    return c.redirect(url);
  } catch (err) {
    console.error("SSO authorize error:", (err as Error).message);
    return c.redirect(`${config.FRONTEND_URL}/auth/error?reason=sso_unavailable`);
  }
});

// ── Login flow: callback ─────────────────────────────────────────────────────

ssoLoginRouter.get("/sso/:teamSlug/callback", async (c) => {
  const teamSlug = c.req.param("teamSlug");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const idpError = c.req.query("error");
  const cookieHeader = c.req.header("Cookie");

  const storedState = readCookie(cookieHeader, STATE_COOKIE);
  const storedNonce = readCookie(cookieHeader, NONCE_COOKIE);
  const storedTeam = readCookie(cookieHeader, TEAM_COOKIE);
  const storedVerifier = readCookie(cookieHeader, PKCE_COOKIE);

  // Always clear the transient cookies, regardless of outcome.
  c.header("Set-Cookie", clearCookie(STATE_COOKIE), { append: true });
  c.header("Set-Cookie", clearCookie(NONCE_COOKIE), { append: true });
  c.header("Set-Cookie", clearCookie(TEAM_COOKIE), { append: true });
  c.header("Set-Cookie", clearCookie(PKCE_COOKIE), { append: true });

  if (idpError) {
    // idpError is echoed by the IdP; restrict to a safe charset before
    // forwarding to the frontend error page.
    const safe = idpError.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    return c.redirect(`${config.FRONTEND_URL}/auth/error?reason=${safe}`);
  }
  if (!code || !state || !storedState || !storedNonce || !storedVerifier) {
    return c.redirect(`${config.FRONTEND_URL}/auth/error?reason=bad_request`);
  }
  if (state !== storedState || storedTeam !== teamSlug) {
    return c.redirect(`${config.FRONTEND_URL}/auth/error?reason=state_mismatch`);
  }

  const result = await getSsoConnectionByTeamSlug(teamSlug);
  if (!result || !result.connection.enabled) {
    return c.redirect(`${config.FRONTEND_URL}/auth/error?reason=sso_not_configured`);
  }
  const { connection } = result;

  try {
    const { discovery, jwks } = await discover(connection.issuer);
    const clientSecret = await decryptClientSecret(connection.clientSecretEnc);

    const tokens = await exchangeCode({
      discovery,
      clientId: connection.clientId,
      clientSecret,
      code,
      redirectUri: buildRedirectUri(teamSlug),
      codeVerifier: storedVerifier,
    });

    const claims = await verifyIdToken({
      idToken: tokens.id_token,
      jwks,
      expectedIssuer: connection.issuer,
      expectedAudience: connection.clientId,
      expectedNonce: storedNonce,
    });

    const user = await upsertUserFromOidc(
      {
        id: connection.id,
        teamId: connection.teamId,
        issuer: connection.issuer,
        autoProvision: connection.autoProvision,
        emailDomains: connection.emailDomains,
      },
      claims,
    );

    if (!user) {
      return c.redirect(`${config.FRONTEND_URL}/auth/error?reason=not_provisioned`);
    }

    const sessionToken = await createSessionToken(user.id, config.SESSION_SECRET);
    const isSecure = config.NODE_ENV === "production";
    c.header("Set-Cookie", buildSessionCookie(sessionToken, isSecure), { append: true });

    return c.redirect(`${config.FRONTEND_URL}/teams`);
  } catch (err) {
    // Never include the raw error (may contain token-exchange response body) —
    // log the message alone and fall through to a generic reason.
    console.error("SSO callback error:", (err as Error).message);
    return c.redirect(`${config.FRONTEND_URL}/auth/error?reason=sso_failed`);
  }
});

// ── Admin CRUD on the team's SSO connection ─────────────────────────────────

const upsertSchema = z.object({
  displayName: z.string().min(1).max(100),
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  emailDomains: z.array(z.string().min(1).max(253)).max(20).default([]),
  autoProvision: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

async function requireTeamAdmin(
  c: Context<{ Variables: AppVariables }>,
  teamId: string,
) {
  const actor = c.get("actor");
  if (!actor || actor.type !== "human") {
    return { error: forbidden(c, "Authentication required") } as const;
  }
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: actor.userId } },
  });
  if (!membership || membership.role !== "ADMIN") {
    return { error: forbidden(c, "Only team admins can manage SSO") } as const;
  }
  return { actor } as const;
}

ssoAdminRouter.get("/teams/:teamId/sso", async (c) => {
  const teamId = c.req.param("teamId");
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) return notFound(c);

  const gate = await requireTeamAdmin(c, teamId);
  if ("error" in gate) return gate.error;

  const connection = await getSsoConnectionByTeamId(teamId);
  return c.json({ connection: connection ? publicSsoConnection(connection) : null });
});

ssoAdminRouter.put("/teams/:teamId/sso", zValidator("json", upsertSchema), async (c) => {
  const teamId = c.req.param("teamId");
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) return notFound(c);

  const gate = await requireTeamAdmin(c, teamId);
  if ("error" in gate) return gate.error;

  if (!config.SSO_ENCRYPTION_KEY) {
    return c.json(
      {
        error: "not_configured",
        message: "SSO_ENCRYPTION_KEY must be set on the backend before creating SSO connections",
      },
      503,
    );
  }

  const body = c.req.valid("json");

  // Validate that the issuer actually advertises OIDC discovery before saving —
  // this gives admins fast feedback instead of a broken login button.
  try {
    await discover(body.issuer);
  } catch (err) {
    return c.json(
      {
        error: "invalid_issuer",
        message: `OIDC discovery failed: ${(err as Error).message}`,
      },
      400,
    );
  }

  // Invalidate discovery cache for both the prior issuer (if it's changing)
  // and the new one, so a stale metadata document can't be used on the next
  // login attempt.
  const prior = await getSsoConnectionByTeamId(teamId);
  if (prior && prior.issuer !== body.issuer) {
    invalidateDiscovery(prior.issuer);
  }

  let saved;
  try {
    saved = await upsertSsoConnection(teamId, body);
  } catch (err) {
    return c.json({ error: "bad_request", message: (err as Error).message }, 400);
  }
  invalidateDiscovery(body.issuer);
  return c.json({ connection: publicSsoConnection(saved) });
});

ssoAdminRouter.delete("/teams/:teamId/sso", async (c) => {
  const teamId = c.req.param("teamId");
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) return notFound(c);

  const gate = await requireTeamAdmin(c, teamId);
  if ("error" in gate) return gate.error;

  const prior = await getSsoConnectionByTeamId(teamId);
  await deleteSsoConnection(teamId);
  if (prior) invalidateDiscovery(prior.issuer);
  return c.json({ ok: true });
});
