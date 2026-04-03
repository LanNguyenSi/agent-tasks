import { Hono } from "hono";
import type { AppVariables } from "../types/hono.js";
import { config } from "../config/index.js";
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
import { upsertUserFromGitHub, getUserById } from "../services/user.js";

export const authRouter = new Hono<{ Variables: AppVariables }>();

const oauthConfig = {
  clientId: config.GITHUB_CLIENT_ID,
  clientSecret: config.GITHUB_CLIENT_SECRET,
};

// ── Initiate OAuth ────────────────────────────────────────────────────────────

authRouter.get("/github", (c) => {
  const state = generateState();
  const url = buildAuthorizationUrl(oauthConfig, state);

  // Store state in cookie for CSRF protection
  c.header("Set-Cookie", `oauth_state=${state}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/`);

  return c.redirect(url);
});

// ── OAuth Callback ────────────────────────────────────────────────────────────

authRouter.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieHeader = c.req.header("Cookie");
  const storedState = cookieHeader?.match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1];

  if (!code) {
    return c.json({ error: "bad_request", message: "Missing code parameter" }, 400);
  }

  // CSRF state check
  if (!storedState || storedState !== state) {
    return c.json({ error: "bad_request", message: "Invalid OAuth state" }, 400);
  }

  try {
    const tokenResponse = await exchangeCodeForToken(oauthConfig, code);
    const githubUser = await fetchGitHubUser(tokenResponse.access_token);
    const user = await upsertUserFromGitHub(githubUser);

    const sessionToken = await createSessionToken(user.id, tokenResponse.access_token, config.SESSION_SECRET);
    const isSecure = config.NODE_ENV === "production";

    c.header("Set-Cookie", buildSessionCookie(sessionToken, isSecure), { append: true });
    c.header("Set-Cookie", "oauth_state=; Max-Age=0; Path=/", { append: true }); // clear state cookie

    return c.redirect(`${config.FRONTEND_URL}/dashboard`);
  } catch (err) {
    console.error("OAuth callback error:", err);
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

  return c.json({
    user: {
      id: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      email: user.email,
    },
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────

authRouter.post("/logout", (c) => {
  c.header("Set-Cookie", buildClearSessionCookie());
  return c.json({ message: "Logged out" });
});
