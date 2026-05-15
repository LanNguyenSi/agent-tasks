// Smoke test for the `--version` CLI short-circuit. harness doctor's
// `tools.mcp[].min_version` check spawnSyncs `<bin> --version` with a 5s
// timeout; previously the bridge rejected the flag and exited non-zero,
// reporting `version probe failed for agent-tasks-mcp-bridge --version`.
// This test pins the contract.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(__filename, "..", "..");
const CLI_BIN = resolve(PACKAGE_ROOT, "dist", "cli.js");
const PACKAGE_JSON = resolve(PACKAGE_ROOT, "package.json");

function expectedVersion(): string {
  const raw = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string };
  return raw.version;
}

describe("agent-tasks-mcp-bridge CLI --version", () => {
  it("prints package.json#version and exits 0 within the doctor probe budget", () => {
    const result = spawnSync(process.execPath, [CLI_BIN, "--version"], {
      encoding: "utf8",
      timeout: 4_000,
    });
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout.trim()).toBe(expectedVersion());
    // Drift guard: if package.json bumps but the in-file PACKAGE_VERSION
    // is not bumped along with it, this assertion fires loudly.
  });

  it("accepts the -v shorthand alias", () => {
    const result = spawnSync(process.execPath, [CLI_BIN, "-v"], {
      encoding: "utf8",
      timeout: 4_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expectedVersion());
  });

  it("accepts the bare `version` subcommand alongside the flag forms", () => {
    const result = spawnSync(process.execPath, [CLI_BIN, "version"], {
      encoding: "utf8",
      timeout: 4_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expectedVersion());
  });
});
