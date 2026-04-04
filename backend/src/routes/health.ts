import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";

export const healthRouter = new Hono();

healthRouter.get("/", async (c) => {
  let dbStatus: "ok" | "error" = "ok";
  let dbLatencyMs: number | null = null;

  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - dbStart;
  } catch {
    dbStatus = "error";
  }

  const healthy = dbStatus === "ok";

  return c.json(
    {
      status: healthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      service: "agent-tasks-api",
      uptime: Math.floor(process.uptime()),
      dependencies: {
        database: { status: dbStatus, latencyMs: dbLatencyMs },
      },
    },
    healthy ? 200 : 503,
  );
});
