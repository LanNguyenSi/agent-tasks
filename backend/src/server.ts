import { serve } from "@hono/node-server";
import { config } from "./config/index.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { scheduleIdempotencySweep } from "./services/idempotency-sweep.js";
import { prisma } from "./lib/prisma.js";
import { composeGroundingRuntime } from "./services/grounding-runtime.js";
import { startLegacyGithubTokenSweep } from "./services/github-token-crypto.js";

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

// One-off pass that encrypts GitHub tokens stored before encryption existed.
// Not awaited: the server is already serving; see services/github-token-crypto.ts.
  startLegacyGithubTokenSweep();
} catch {
  logger.error("Backend startup refused: grounding configuration or database prerequisites unavailable");
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
}
