import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { agentTokenRouter } from "./routes/agent-tokens.js";
import { taskRouter } from "./routes/tasks.js";
import { projectRouter } from "./routes/projects.js";
import { workflowRouter } from "./routes/workflows.js";
import { boardRouter } from "./routes/boards.js";
import { auditRouter } from "./routes/audit.js";
import { teamRouter } from "./routes/teams.js";
import { webhookRouter } from "./routes/webhooks.js";
import { signalRouter } from "./routes/signals.js";
import { githubRouter } from "./routes/github.js";
import { mcpRouter, setApp as setMcpApp } from "./routes/mcp.js";
import { docsRouter } from "./routes/docs.js";
import { ssoLoginRouter, ssoAdminRouter } from "./routes/sso.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { appErrorHandler } from "./lib/error-handler.js";
import type { AppVariables } from "./types/hono.js";

export function createApp(corsOrigins: string): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", logger());

  // Security headers
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("X-XSS-Protection", "1; mode=block");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  app.use(
    "*",
    cors({
      origin: corsOrigins.split(",").map((s) => s.trim()),
      credentials: true,
    }),
  );

  // Rate limiting on auth endpoints
  app.use("/api/auth/register", rateLimit({ windowMs: 60_000, max: 5 }));
  app.use("/api/auth/register-from-project-pilot", rateLimit({ windowMs: 60_000, max: 10 }));
  app.use("/api/auth/login", rateLimit({ windowMs: 60_000, max: 10 }));
  app.use("/api/auth/github/*", rateLimit({ windowMs: 60_000, max: 10 }));
  app.use("/api/auth/sso/*", rateLimit({ windowMs: 60_000, max: 20 }));
  app.use("/api/sso/whoami", rateLimit({ windowMs: 60_000, max: 20 }));

  // Public
  app.route("/api/health", healthRouter);
  app.route("/api/webhooks", webhookRouter); // GitHub webhooks — signature-verified, no auth
  app.route("/", docsRouter);

  // Protected
  app.use("/api/auth/me", authMiddleware);
  app.use("/api/auth/logout", authMiddleware);
  app.use("/api/auth/delegation", authMiddleware);
  app.use("/api/auth/github/connect", authMiddleware);
  // /api/teams/:teamId/sso has its OWN token+scope gate (ssoAdminGuard) and
  // must not go through the session-based authMiddleware — otherwise a valid
  // session alone would establish an actor on the request, weakening the
  // defense-in-depth intent of the scope-gated endpoint.
  app.use("/api/teams/*", async (c, next) => {
    if (/^\/api\/teams\/[^/]+\/sso$/.test(c.req.path)) return next();
    return authMiddleware(c, next);
  });
  app.use("/api/agent-tokens/*", authMiddleware);
  app.use("/api/tasks/*", authMiddleware);
  app.use("/api/agent/signals/*", authMiddleware);
  app.use("/api/agent/signals", authMiddleware);
  app.use("/api/projects/*", authMiddleware);
  app.use("/api/github/*", authMiddleware);
  // `/api/mcp` is exact-match for POST, and the mcpRouter also has
  // 405 handlers for GET/DELETE. Both need the outer authMiddleware
  // — the POST path to validate the Bearer token before any MCP
  // machinery runs, the 405 handlers to keep an unauthenticated GET
  // from leaking the method info (they still 405, but only after
  // auth, so an unauthed probe gets 401).
  app.use("/api/mcp", authMiddleware);

  // SSO login endpoints — public, under /api/auth/sso/*
  app.route("/api/auth", ssoLoginRouter);
  // SSO admin endpoints — auth-gated by the /api/teams/* middleware above
  app.route("/api", ssoAdminRouter);

  app.route("/api/auth", authRouter);
  app.route("/api", teamRouter);
  app.route("/api/agent-tokens", agentTokenRouter);
  app.route("/api", projectRouter);
  app.route("/api", taskRouter);
  app.route("/api", workflowRouter);
  app.route("/api", boardRouter);
  app.route("/api", auditRouter);
  app.route("/api", signalRouter);
  app.route("/api/github", githubRouter);
  app.route("/api/mcp", mcpRouter);

  // Make the Hono app available to the MCP route's self-dispatch
  // helper. Must happen after every `app.route(...)` call so the
  // inner router sees a fully-wired stack.
  setMcpApp(app);

  // 404
  app.notFound((c) => c.json({ error: "not_found", message: "Route not found" }, 404));

  // Global error handler — see `lib/error-handler.ts`.
  app.onError(appErrorHandler);

  return app;
}
