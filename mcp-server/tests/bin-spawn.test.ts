// rc-v1-C007 fix round 2 (HIGH: the hole that let the CRITICAL entrypoint
// regression through). Round 1's src/index.ts guarded its real entrypoint
// call behind `invokedDirectly` (process.argv[1] === import.meta.url, via
// pathToFileURL(process.argv[1])), added only so importing the module from
// a test would not also spawn a real stdio server. That guard silently
// broke the npm bin path: node_modules/.bin/agent-tasks-mcp is a SYMLINK
// npm creates from the package.json `bin` key, so process.argv[1] is the
// symlink path while import.meta.url is Node's realpath-resolved target --
// the two never matched, invokedDirectly was always false, and the
// published binary exited 0 having done nothing. Measured directly: a real
// `npm pack` -> install -> `npx` round trip in a sandbox produced zero
// stdout/stderr output.
//
// No existing test caught this because every other spawn test in this repo
// (mcp-bridge/tests/cli-version.test.ts, mcp-bridge/tests/
// legacy-flag.test.ts) invokes `node <real-dist-path>` directly -- argv[1]
// and import.meta.url only diverge when the invoked path is ITSELF a
// symlink, which the real dist path never is. This test creates an actual
// symlink to dist/index.js in a scratch temp directory, reproducing
// node_modules/.bin's exact shape, and spawns that symlink path: a
// regression back to any argv[1]-vs-import.meta.url (or similar
// path-identity) guard fails here, not silently in production.
//
// The round-2 fix removed the guard entirely (resolveLegacyFlag moved to
// its own module, src/legacy-flag.ts, so index.ts's entrypoint call needs
// no import-vs-invocation guard at all) -- this test exists to keep that
// class of regression from coming back, whatever form it takes.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(__filename, "..", "..");
const REAL_DIST_ENTRY = resolve(PACKAGE_ROOT, "dist", "index.js");

let scratchDir: string;
let BIN_SYMLINK: string;

beforeAll(() => {
  // node_modules/.bin/agent-tasks-mcp is exactly this: a symlink named
  // after the package's `bin` key, pointing at the built dist entrypoint.
  scratchDir = mkdtempSync(join(tmpdir(), "agent-tasks-mcp-bin-spawn-"));
  BIN_SYMLINK = join(scratchDir, "agent-tasks-mcp");
  symlinkSync(REAL_DIST_ENTRY, BIN_SYMLINK);
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

let activeClients: Client[] = [];

afterEach(async () => {
  await Promise.all(activeClients.map((c) => c.close().catch(() => {})));
  activeClients = [];
});

async function connectOverSymlink(extraEnv: Record<string, string>): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Same fix as mcp-bridge/tests/legacy-flag.test.ts (rc-v1-C007 fix round
  // 2, item 4b): drop both vars from the copied parent env before layering
  // extraEnv on top, so an ambient AGENT_TASKS_MCP_LEGACY or
  // AGENT_TASKS_BASE_URL in the environment this suite itself runs under
  // cannot leak into a case whose extraEnv does not set it.
  delete env.AGENT_TASKS_MCP_LEGACY;
  delete env.AGENT_TASKS_BASE_URL;
  Object.assign(env, extraEnv);

  // `node <symlink-path>` reproduces the exact argv[1] npm's own bin
  // resolution produces: the symlink path itself, not its realpath. This
  // is the precise input the round-1 invokedDirectly guard got wrong.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN_SYMLINK],
    env,
  });
  const client = new Client({ name: "bin-spawn-test-client", version: "0.0.0" });
  activeClients.push(client);
  await client.connect(transport);
  return client;
}

describe("agent-tasks-mcp spawned through a node_modules/.bin-shaped symlink (rc-v1-C007 fix round 2)", () => {
  it(
    "responds to initialize with the real serverInfo and registers the default (non-legacy) tool set",
    async () => {
      const client = await connectOverSymlink({
        AGENT_TASKS_TOKEN: "fake-token-registration-only",
      });

      const serverInfo = client.getServerVersion();
      expect(serverInfo?.name).toBe("agent-tasks-mcp");

      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      expect(listed.tools.length).toBe(23);
      expect(names).toContain("task_start");
      // A pruned v1 verb stays absent by default.
      expect(names).not.toContain("tasks_claim");
    },
    10_000,
  );

  it(
    "registers the full 37-tool legacy set when AGENT_TASKS_MCP_LEGACY=1 is set in the spawned process's environment",
    async () => {
      const client = await connectOverSymlink({
        AGENT_TASKS_TOKEN: "fake-token-registration-only",
        AGENT_TASKS_MCP_LEGACY: "1",
      });

      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      expect(listed.tools.length).toBe(37);
      expect(names).toContain("task_start");
      expect(names).toContain("tasks_claim");
    },
    10_000,
  );
});
