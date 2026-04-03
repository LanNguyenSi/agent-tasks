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
import { webhookRouter } from "./routes/webhooks.js";
import { authMiddleware } from "./middleware/auth.js";
import type { AppVariables } from "./types/hono.js";

export function createApp(corsOrigins: string): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: corsOrigins.split(",").map((s) => s.trim()),
      credentials: true,
    }),
  );

  // Public
  app.route("/api/health", healthRouter);
  app.route("/api/webhooks", webhookRouter); // GitHub webhooks — signature-verified, no auth

  // Protected
  app.use("/api/auth/me", authMiddleware);
  app.use("/api/auth/logout", authMiddleware);
  app.use("/api/agent-tokens/*", authMiddleware);
  app.use("/api/tasks/*", authMiddleware);
  app.use("/api/projects/*", authMiddleware);
  app.use("/api/auth/me", authMiddleware);

  app.route("/api/auth", authRouter);
  app.route("/api/agent-tokens", agentTokenRouter);
  app.route("/api", projectRouter);
  app.route("/api", taskRouter);
  app.route("/api", workflowRouter);
  app.route("/api", boardRouter);
  app.route("/api", auditRouter);

  // 404
  app.notFound((c) => c.json({ error: "not_found", message: "Route not found" }, 404));

  return app;
}
