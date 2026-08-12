#!/usr/bin/env node
import { runStdioServer, DEFAULT_BASE_URL } from "./server.js";
import { resolveLegacyFlag } from "./legacy-flag.js";

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

// rc-v1-C007 fix round 2 (CRITICAL): the call below used to be guarded by an
// `invokedDirectly` check comparing import.meta.url against
// pathToFileURL(process.argv[1]), added only so importing this module from
// a test would not also spawn a real stdio server. That guard broke the
// npm bin path: node_modules/.bin/agent-tasks-mcp is a SYMLINK, so
// process.argv[1] is the symlink path while import.meta.url is Node's
// realpath-resolved target -- the two never matched, and the published
// binary silently did nothing (measured: a real npm pack/install/npx round
// trip produced no output and exit 0). resolveLegacyFlag (the only export
// the guard needed to shield from a bare import) now lives in
// legacy-flag.ts, so tests import it directly from there and this
// entrypoint needs no guard at all: it is only ever loaded as the
// package's `bin` target, or via `node dist/index.js` / `tsx
// src/index.ts`, never imported by test code.
runStdioServer(resolveConfig(), { legacy: resolveLegacyFlag() }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[agent-tasks-mcp] fatal:", err);
  process.exit(1);
});
