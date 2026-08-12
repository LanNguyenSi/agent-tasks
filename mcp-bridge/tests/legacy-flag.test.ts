// rc-v1-C007 fix round, item 2: cli.ts used to call
// `runStdioServer({ token, baseUrl })` with no second argument, silently
// dropping AGENT_TASKS_MCP_LEGACY on the floor even when an operator set it.
// The escape hatch existed in @agent-tasks/mcp-server (createServer /
// runStdioServer both accept { legacy?: boolean }) but the bridge never
// forwarded it. governance.test.ts's `createServer(config, { legacy: true
// })` call cannot catch this: it drives the option programmatically,
// bypassing cli.ts's own env-var-to-option wiring entirely. This spawns the
// REAL built binary (dist/cli.js, same as cli-version.test.ts) with a real
// child process environment and a real stdio MCP handshake, so a
// regression back to the inert passthrough fails here.
//
// listTools() alone needs no backend network call (tool registration is
// local); AGENT_TASKS_TOKEN is set to a fake value only so
// resolveTokenStore() short-circuits to EnvStore without touching the OS
// keychain or filesystem token store.

import { describe, expect, it, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(__filename, "..", "..");
const CLI_BIN = resolve(PACKAGE_ROOT, "dist", "cli.js");

let activeClients: Client[] = [];

afterEach(async () => {
  await Promise.all(activeClients.map((c) => c.close().catch(() => {})));
  activeClients = [];
});

async function listToolNames(extraEnv: Record<string, string>): Promise<string[]> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, extraEnv);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_BIN],
    env,
  });
  const client = new Client({ name: "legacy-flag-test-client", version: "0.0.0" });
  activeClients.push(client);
  await client.connect(transport);
  const listed = await client.listTools();
  return listed.tools.map((t) => t.name);
}

describe("cli.ts forwards AGENT_TASKS_MCP_LEGACY to the real spawned server (rc-v1-C007 fix round)", () => {
  it(
    "omits a pruned v1 verb (tasks_claim) from the real process's tools/list when the env var is unset",
    async () => {
      const names = await listToolNames({
        AGENT_TASKS_TOKEN: "fake-token-registration-only",
      });
      expect(names).not.toContain("tasks_claim");
      expect(names).toContain("task_start");
    },
    10_000,
  );

  it(
    "includes the pruned v1 verb set when AGENT_TASKS_MCP_LEGACY=1 is set in the spawned process's environment " +
      "(the assertion that catches the previously-inert passthrough: cli.ts used to drop this option entirely)",
    async () => {
      const names = await listToolNames({
        AGENT_TASKS_TOKEN: "fake-token-registration-only",
        AGENT_TASKS_MCP_LEGACY: "1",
      });
      expect(names).toContain("tasks_claim");
      expect(names).toContain("task_start");
    },
    10_000,
  );
});
