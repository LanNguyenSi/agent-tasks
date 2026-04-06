import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppVariables } from "../types/hono.js";
import { config, hasGitHubOAuthConfigured } from "../config/index.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
  generateState,
} from "../services/github-oauth.js";
import {
  createSessionToken,
  verifySessionToken,
  extractSessionCookie,
  buildSessionCookie,
  buildClearSessionCookie,
} from "../services/session.js";
import {
  upsertUserFromGitHub,
  getUserById,
  getUserByEmail,
  createLocalUser,
  connectGitHubToExistingUser,
  updateUserDelegation,
} from "../services/user.js";
import { verifyPassword } from "../services/password.js";

export const authRouter = new Hono<{ Variables: AppVariables }>();

const oauthConfig = {
  clientId: config.GITHUB_CLIENT_ID,
  clientSecret: config.GITHUB_CLIENT_SECRET,
};

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const OAUTH_STATE_COOKIE = "oauth_state";
const OAUTH_INTENT_COOKIE = "oauth_intent";
const OAUTH_CONNECT_USER_COOKIE = "oauth_connect_user";
type CookieWriter = {
  header: (name: string, value: string, options?: { append?: boolean }) => void;
};

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

function buildCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}; Path=/`;
}

function clearCookie(name: string): string {
  return `${name}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`;
}

function appendOAuthCookies(c: CookieWriter, options: {
  state: string;
  intent: "login" | "connect";
  connectUserId?: string;
}): void {
  c.header("Set-Cookie", buildCookie(OAUTH_STATE_COOKIE, options.state, 600), { append: true });
  c.header("Set-Cookie", buildCookie(OAUTH_INTENT_COOKIE, options.intent, 600), { append: true });
  if (options.connectUserId) {
    c.header("Set-Cookie", buildCookie(OAUTH_CONNECT_USER_COOKIE, options.connectUserId, 600), {
      append: true,
    });
  } else {
    c.header("Set-Cookie", clearCookie(OAUTH_CONNECT_USER_COOKIE), { append: true });
  }
}

function clearOAuthCookies(c: CookieWriter): void {
  c.header("Set-Cookie", clearCookie(OAUTH_STATE_COOKIE), { append: true });
  c.header("Set-Cookie", clearCookie(OAUTH_INTENT_COOKIE), { append: true });
  c.header("Set-Cookie", clearCookie(OAUTH_CONNECT_USER_COOKIE), { append: true });
}

function buildUserResponse(user: {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  githubConnectedAt: Date | null;
  githubAccessToken: string | null;
  allowAgentPrCreate: boolean;
  allowAgentPrMerge: boolean;
  allowAgentPrComment: boolean;
}) {
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    email: user.email,
    githubConnected: Boolean(user.githubConnectedAt && user.githubAccessToken),
    allowAgentPrCreate: user.allowAgentPrCreate,
    allowAgentPrMerge: user.allowAgentPrMerge,
    allowAgentPrComment: user.allowAgentPrComment,
  };
}

// ── Register / Login ─────────────────────────────────────────────────────────

authRouter.post("/register", zValidator("json", registerSchema), async (c) => {
  const body = c.req.valid("json");
  const email = body.email.toLowerCase().trim();

  const existing = await getUserByEmail(email);
  if (existing) {
    return c.json({ error: "conflict", message: "Email already registered" }, 409);
  }

  const user = await createLocalUser({
    email,
    password: body.password,
    name: body.name,
  });

  const sessionToken = await createSessionToken(user.id, config.SESSION_SECRET);
  const isSecure = config.NODE_ENV === "production";
  c.header("Set-Cookie", buildSessionCookie(sessionToken, isSecure));

  return c.json({ user: buildUserResponse(user) }, 201);
});

authRouter.post("/login", zValidator("json", loginSchema), async (c) => {
  const body = c.req.valid("json");
  const user = await getUserByEmail(body.email.toLowerCase().trim());

  if (!user || !user.passwordHash) {
    return c.json({ error: "unauthorized", message: "Invalid email or password" }, 401);
  }

  const valid = await verifyPassword(body.password, user.passwordHash);
  if (!valid) {
    return c.json({ error: "unauthorized", message: "Invalid email or password" }, 401);
  }

  const sessionToken = await createSessionToken(user.id, config.SESSION_SECRET);
  const isSecure = config.NODE_ENV === "production";
  c.header("Set-Cookie", buildSessionCookie(sessionToken, isSecure));

  return c.json({ user: buildUserResponse(user) });
});

// ── Initiate OAuth ────────────────────────────────────────────────────────────

authRouter.get("/github", (c) => {
  if (!hasGitHubOAuthConfigured) {
    return c.json({ error: "not_configured", message: "GitHub OAuth is not configured" }, 503);
  }

  const state = generateState();
  const url = buildAuthorizationUrl(oauthConfig, state);

  appendOAuthCookies(c, { state, intent: "login" });
  return c.redirect(url);
});

authRouter.get("/github/connect", (c) => {
  if (!hasGitHubOAuthConfigured) {
    return c.json({ error: "not_configured", message: "GitHub OAuth is not configured" }, 503);
  }

  const actor = c.get("actor");
  if (!actor || actor.type !== "human") {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }

  const state = generateState();
  const url = buildAuthorizationUrl(oauthConfig, state);

  appendOAuthCookies(c, { state, intent: "connect", connectUserId: actor.userId });
  return c.redirect(url);
});

// ── OAuth Callback ────────────────────────────────────────────────────────────

authRouter.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieHeader = c.req.header("Cookie");

  const storedState = readCookie(cookieHeader, OAUTH_STATE_COOKIE);
  const intent = readCookie(cookieHeader, OAUTH_INTENT_COOKIE);
  const connectUserId = readCookie(cookieHeader, OAUTH_CONNECT_USER_COOKIE);

  if (!code) {
    return c.json({ error: "bad_request", message: "Missing code parameter" }, 400);
  }

  if (!storedState || storedState !== state) {
    return c.json({ error: "bad_request", message: "Invalid OAuth state" }, 400);
  }

  try {
    const tokenResponse = await exchangeCodeForToken(oauthConfig, code);
    const githubUser = await fetchGitHubUser(tokenResponse.access_token);

    if (intent === "connect") {
      const sessionToken = extractSessionCookie(cookieHeader);
      const session = sessionToken
        ? await verifySessionToken(sessionToken, config.SESSION_SECRET)
        : null;

      if (!session || !connectUserId || session.userId !== connectUserId) {
        clearOAuthCookies(c);
        return c.redirect(`${config.FRONTEND_URL}/auth/error`);
      }

      await connectGitHubToExistingUser(session.userId, githubUser, tokenResponse.access_token);
      clearOAuthCookies(c);
      return c.redirect(`${config.FRONTEND_URL}/settings?github_connected=1`);
    }

    const user = await upsertUserFromGitHub(githubUser, tokenResponse.access_token);

    const sessionToken = await createSessionToken(user.id, config.SESSION_SECRET);
    const isSecure = config.NODE_ENV === "production";

    c.header("Set-Cookie", buildSessionCookie(sessionToken, isSecure), { append: true });
    clearOAuthCookies(c);

    return c.redirect(`${config.FRONTEND_URL}/teams`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    clearOAuthCookies(c);
    return c.redirect(`${config.FRONTEND_URL}/auth/error`);
  }
});

// ── Current User ──────────────────────────────────────────────────────────────

authRouter.get("/me", async (c) => {
  const cookieHeader = c.req.header("Cookie");
  const sessionToken = extractSessionCookie(cookieHeader);

  if (!sessionToken) {
    return c.json({ user: null });
  }

  const session = await verifySessionToken(sessionToken, config.SESSION_SECRET);
  if (!session) {
    return c.json({ user: null });
  }

  const user = await getUserById(session.userId);
  if (!user) {
    return c.json({ user: null });
  }

  return c.json({ user: buildUserResponse(user) });
});

// ── Agent Delegation Settings ────────────────────────────────────────────────

const delegationSchema = z.object({
  allowAgentPrCreate: z.boolean(),
  allowAgentPrMerge: z.boolean(),
  allowAgentPrComment: z.boolean(),
});

authRouter.put("/delegation", zValidator("json", delegationSchema), async (c) => {
  const actor = c.get("actor");
  if (!actor || actor.type !== "human") {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }

  const body = c.req.valid("json");
  const user = await updateUserDelegation(actor.userId, body);
  if (!user) {
    return c.json({ error: "not_found", message: "User not found" }, 404);
  }

  return c.json({ user: buildUserResponse(user) });
});

// ── Logout ────────────────────────────────────────────────────────────────────

authRouter.post("/logout", (c) => {
  c.header("Set-Cookie", buildClearSessionCookie());
  return c.json({ message: "Logged out" });
});
