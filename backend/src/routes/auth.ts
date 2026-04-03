import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

export const authRouter = new Hono();

/**
 * GitHub OAuth callback — Wave 2 implementation.
 * Placeholder: accepts code from GitHub, exchanges for access token, upserts user.
 */
authRouter.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.json({ error: "bad_request", message: "Missing code parameter" }, 400);
  }

  // TODO (Wave 2): Exchange code for access token via GitHub OAuth
  // const tokenResponse = await exchangeGitHubCode(code);
  // const user = await upsertUserFromGitHub(tokenResponse.access_token);
  // Set session cookie...

  return c.json({ message: "OAuth callback — Wave 2 implementation pending" }, 501);
});

authRouter.post("/logout", async (c) => {
  // TODO (Wave 2): Invalidate session
  return c.json({ message: "Logged out" });
});

authRouter.get("/me", async (c) => {
  const actor = c.get("actor");
  if (!actor) {
    return c.json({ error: "unauthorized", message: "Not authenticated" }, 401);
  }
  return c.json({ actor });
});
