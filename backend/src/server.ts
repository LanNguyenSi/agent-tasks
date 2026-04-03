import { serve } from "@hono/node-server";
import { config } from "./config/index.js";
import { createApp } from "./app.js";

const app = createApp(config.CORS_ORIGINS);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`🚀 agent-tasks API running on http://localhost:${info.port}`);
});
