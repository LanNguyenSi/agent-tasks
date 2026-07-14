import { serve } from "@hono/node-server";
import { config } from "./config/index.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { scheduleIdempotencySweep } from "./services/idempotency-sweep.js";

const app = createApp(config.CORS_ORIGINS);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, "agent-tasks API listening");
});

// Periodic TTL sweep for the webhook_deliveries / tool_invocations
// idempotency tables. See services/idempotency-sweep.ts for retention and
// concurrency-guard details.
scheduleIdempotencySweep();
