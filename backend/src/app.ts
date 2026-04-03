import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { agentTokenRouter } from "./routes/agent-tokens.js";
import { taskRouter } from "./routes/tasks.js";
import { authMiddleware } from "./middleware/auth.js";

export function createApp(corsOrigins: string): Hono {
  const app = new Hono();

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
  app.route("/api/auth", authRouter);

  // Protected
  app.use("/api/agent-tokens/*", authMiddleware);
  app.use("/api/tasks/*", authMiddleware);
  app.use("/api/projects/*", authMiddleware);

  app.route("/api/agent-tokens", agentTokenRouter);
  app.route("/api", taskRouter);

  // 404
  app.notFound((c) => c.json({ error: "not_found", message: "Route not found" }, 404));

  return app;
}
