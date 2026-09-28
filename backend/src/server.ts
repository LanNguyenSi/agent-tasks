import { serve } from "@hono/node-server";
import { config } from "./config/index.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { scheduleIdempotencySweep } from "./services/idempotency-sweep.js";
import { prisma } from "./lib/prisma.js";
import { composeGroundingRuntime } from "./services/grounding-runtime.js";

try {
  const grounding = await composeGroundingRuntime(config.GROUNDING_RUNTIME_CONFIG, prisma);
  const app = createApp(config.CORS_ORIGINS, grounding.attempts, grounding.completion, grounding.migration);

  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info({ port: info.port }, "agent-tasks API listening");
  });

// Periodic TTL sweep for the webhook_deliveries / tool_invocations
// idempotency tables. See services/idempotency-sweep.ts for retention and
// concurrency-guard details.
  scheduleIdempotencySweep();
} catch {
  logger.error("Backend startup refused: grounding configuration or database prerequisites unavailable");
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
}
