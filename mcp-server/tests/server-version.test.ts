// Drift guard for the MCP handshake version. During the 0.28.0/0.10.0
// release cut, SERVER_VERSION was left at 0.9.0 while package.json bumped to
// 0.10.0 and nothing caught it, so the handshake silently reported a stale
// version. mcp-bridge pins the same contract in tests/cli-version.test.ts;
// this mirrors it for mcp-server, whose version lives in a source constant
// rather than being read from package.json at runtime.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "../src/server.js";

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_JSON = resolve(__filename, "..", "..", "package.json");

function packageVersion(): string {
  const raw = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string };
  return raw.version;
}

describe("SERVER_VERSION", () => {
  it("matches package.json#version", () => {
    // Drift guard: if package.json bumps but the in-source SERVER_VERSION is
    // not bumped along with it (or vice versa), this assertion fires loudly.
    expect(SERVER_VERSION).toBe(packageVersion());
  });
});
