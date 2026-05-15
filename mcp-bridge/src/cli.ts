#!/usr/bin/env node
import { runStdioServer, DEFAULT_BASE_URL } from "@agent-tasks/mcp-server";
import { resolveTokenStore } from "./token-store.js";
import { runLogin, runLogout, runStatus } from "./login.js";

// Single source of truth for the version string emitted by `--version`.
// Bump alongside package.json on release; the cli-version vitest reads
// package.json#version and asserts spawnSync stdout matches.
export const PACKAGE_VERSION = "0.6.0";

const USAGE = `agent-tasks-mcp-bridge — zero-setup MCP bridge for agent-tasks

Usage:
  agent-tasks-mcp-bridge            Start MCP server over stdio (default)
  agent-tasks-mcp-bridge login [--token <t>]
                                    Store a token in the OS keychain (or file fallback)
  agent-tasks-mcp-bridge logout     Remove the stored token
  agent-tasks-mcp-bridge status     Validate the stored token against the backend
  agent-tasks-mcp-bridge --version  Print the package version and exit
  agent-tasks-mcp-bridge --help     Show this help

Environment:
  AGENT_TASKS_TOKEN     If set, used directly (takes precedence over stored token)
  AGENT_TASKS_BASE_URL  Override backend base URL (default: ${DEFAULT_BASE_URL})
`;

interface ParsedArgs {
  command: "serve" | "login" | "logout" | "status" | "help" | "version";
  tokenFlag?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { command: "serve" };
  const [first, ...rest] = argv;
  if (first === "--help" || first === "-h" || first === "help") {
    return { command: "help" };
  }
  if (first === "--version" || first === "-v" || first === "version") {
    return { command: "version" };
  }
  if (first === "login") {
    let tokenFlag: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--token") {
        tokenFlag = rest[i + 1];
        i++;
      } else if (arg?.startsWith("--token=")) {
        tokenFlag = arg.slice("--token=".length);
      }
    }
    return { command: "login", tokenFlag };
  }
  if (first === "logout") return { command: "logout" };
  if (first === "status") return { command: "status" };
  if (first === "serve") return { command: "serve" };
  throw new Error(`Unknown command: ${first}. Run with --help for usage.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (args.command === "version") {
    // Fast-exit before token-store resolution and any network attempt.
    // Tooling that probes installed MCP binaries (e.g. `harness doctor`'s
    // `tools.mcp[]` `min_version` check) otherwise hits its probe timeout.
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  const baseUrl = process.env.AGENT_TASKS_BASE_URL ?? DEFAULT_BASE_URL;
  const store = await resolveTokenStore();

  if (args.command === "login") {
    await runLogin({ baseUrl, store, tokenFromArg: args.tokenFlag });
    return;
  }
  if (args.command === "logout") {
    await runLogout(store);
    return;
  }
  if (args.command === "status") {
    await runStatus(baseUrl, store);
    return;
  }

  const token = await store.get();
  if (!token) {
    throw new Error(
      "No token available. Run 'agent-tasks-mcp-bridge login' or set AGENT_TASKS_TOKEN.",
    );
  }
  await runStdioServer({ token, baseUrl });
}

function sanitize(msg: string): string {
  return msg.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[redacted]");
}

main().catch((err) => {
  const raw = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error("[agent-tasks-mcp-bridge] fatal:", sanitize(raw));
  process.exit(1);
});
