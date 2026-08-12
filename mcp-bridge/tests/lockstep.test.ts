// Release-order lockstep guard (rc-v1-C008). The bridge ships an EXACT
// @agent-tasks/mcp-server pin, and the npm publish workflow's bridge
// preflight only checks that the pinned version exists on npm — a bridge
// release cut against a stale pin would pass both CI and that preflight,
// silently shipping an old tool surface to npx consumers. This pins the
// workspace invariant: the bridge's dependency pin equals the workspace
// mcp-server version, so a server bump without the bridge pin (or vice
// versa) fails the suite instead of the release.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(__filename, "..", "..");

function readPackageJson(path: string): {
  version: string;
  dependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    version: string;
    dependencies?: Record<string, string>;
  };
}

describe("mcp-server pin lockstep", () => {
  it("pins exactly the workspace mcp-server version", () => {
    const bridge = readPackageJson(resolve(PACKAGE_ROOT, "package.json"));
    const server = readPackageJson(
      resolve(PACKAGE_ROOT, "..", "mcp-server", "package.json"),
    );
    const pin = bridge.dependencies?.["@agent-tasks/mcp-server"];
    // Non-vacuity: both sides must exist and be plain exact versions.
    expect(server.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin).toBe(server.version);
  });
});
