#!/usr/bin/env node
import { pathToFileURL } from "node:url";
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
// without env stubbing. Exported (not just called locally) so
// tests/index.test.ts can drive both the true/false and the typo-warning
// path directly; the entrypoint call below is guarded so importing this
// module for that test does not also spawn a real stdio server.
export function resolveLegacyFlag(): boolean {
  const raw = process.env.AGENT_TASKS_MCP_LEGACY;
  // Only the literal string "1" turns the flag on. Anything else that is
  // still SET (a truthy-looking typo like "true" or "yes") silently stayed
  // off before this fix, with no signal to the operator that the flag they
  // set had no effect. One line to stderr, not a thrown error: the server
  // still starts in default mode, which is the safe fallback.
  if (raw !== undefined && raw !== "1") {
    // eslint-disable-next-line no-console
    console.error(
      `[agent-tasks-mcp] AGENT_TASKS_MCP_LEGACY is set to "${raw}", not "1"; the legacy verb set stays OFF. Set AGENT_TASKS_MCP_LEGACY=1 (exactly) to enable it.`,
    );
  }
  return raw === "1";
}

// Run only when invoked directly (tsx/node), not when imported by a test.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runStdioServer(resolveConfig(), { legacy: resolveLegacyFlag() }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[agent-tasks-mcp] fatal:", err);
    process.exit(1);
  });
}
