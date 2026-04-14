#!/usr/bin/env node
import { runStdioServer, DEFAULT_BASE_URL } from "./server.js";

function resolveConfig() {
  const token = process.env.AGENT_TASKS_TOKEN;
  if (!token) {
    throw new Error(
      "AGENT_TASKS_TOKEN env var is required. Obtain a token from the agent-tasks UI under Settings → Agent Tokens.",
    );
  }
  const baseUrl = process.env.AGENT_TASKS_BASE_URL ?? DEFAULT_BASE_URL;
  return { token, baseUrl };
}

runStdioServer(resolveConfig()).catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[agent-tasks-mcp] fatal:", err);
  process.exit(1);
});
