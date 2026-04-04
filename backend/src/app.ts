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
import { docsRouter } from "./routes/docs.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rate-limit.js";
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
  app.use("/api/auth/login", rateLimit({ windowMs: 60_000, max: 10 }));
  app.use("/api/auth/github/*", rateLimit({ windowMs: 60_000, max: 10 }));

  // Public
  app.route("/api/health", healthRouter);
  app.route("/api/webhooks", webhookRouter); // GitHub webhooks — signature-verified, no auth
  app.route("/", docsRouter);

  // Protected
  app.use("/api/auth/me", authMiddleware);
  app.use("/api/auth/logout", authMiddleware);
  app.use("/api/auth/github/connect", authMiddleware);
  app.use("/api/teams/*", authMiddleware);
  app.use("/api/agent-tokens/*", authMiddleware);
  app.use("/api/tasks/*", authMiddleware);
  app.use("/api/projects/*", authMiddleware);

  app.route("/api/auth", authRouter);
  app.route("/api", teamRouter);
  app.route("/api/agent-tokens", agentTokenRouter);
  app.route("/api", projectRouter);
  app.route("/api", taskRouter);
  app.route("/api", workflowRouter);
  app.route("/api", boardRouter);
  app.route("/api", auditRouter);

  // 404
  app.notFound((c) => c.json({ error: "not_found", message: "Route not found" }, 404));

  // Global error handler — prevents uncaught exceptions from crashing the server
  app.onError((err, c) => {
    console.error(`[${c.req.method}] ${c.req.path} — unhandled error:`, err.message);
    return c.json(
      { error: "internal_error", message: "An unexpected error occurred" },
      500,
    );
  });

  return app;
}
