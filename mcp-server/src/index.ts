#!/usr/bin/env node
import { runStdioServer, DEFAULT_BASE_URL } from "./server.js";

function resolveConfig() {
  const token = process.env.AGENT_TASKS_TOKEN;
  if (!token) {
    throw new Error(
      "AGENT_TASKS_TOKEN env var is required. Obtain a token from the agent-tasks UI under Settings → API Tokens.",
    );
  }
  const baseUrl = process.env.AGENT_TASKS_BASE_URL ?? DEFAULT_BASE_URL;
  return { token, baseUrl };
}

// rc-v1-C007: AGENT_TASKS_MCP_LEGACY=1 re-registers the v1 verbs tools.ts's
// buildTools prunes from the default registration (LEGACY_VERB_NAMES), for
// a caller still depending on one of them by name. Read here, at the
// process entrypoint, and forwarded as an explicit option so
// buildTools/createServer/runStdioServer stay testable in both modes
// without env stubbing.
function resolveLegacyFlag(): boolean {
  return process.env.AGENT_TASKS_MCP_LEGACY === "1";
}

runStdioServer(resolveConfig(), { legacy: resolveLegacyFlag() }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[agent-tasks-mcp] fatal:", err);
  process.exit(1);
});
