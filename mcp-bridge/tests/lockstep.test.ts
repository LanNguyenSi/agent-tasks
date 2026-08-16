// Release-order lockstep guard (rc-v1-C008). The bridge ships an EXACT
// @agent-tasks/mcp-server pin, and the npm publish workflow's bridge
// preflight only checks that the pinned version exists on npm — a bridge
// release cut against a stale pin would pass both CI and that preflight,
// silently shipping an old tool surface to npx consumers. This pins the
// workspace invariant: the bridge's dependency pin equals the workspace
// mcp-server version, so a server bump without the bridge pin (or vice
// versa) fails the suite instead of the release.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(__filename, "..", "..");
const MCP_SERVER_ROOT = resolve(PACKAGE_ROOT, "..", "mcp-server");

function readPackageJson(path: string): {
  version: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  exports?: Record<string, Record<string, string>>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    version: string;
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    exports?: Record<string, Record<string, string>>;
  };
}

// tsconfig.typecheck.json carries `//` comments, which plain JSON.parse
// rejects. Parse it the same way tsc itself does, so this test reads the
// config tsc will actually see.
function readTsconfigJsonc(path: string): {
  compilerOptions?: { paths?: Record<string, string[]> };
} {
  const text = readFileSync(path, "utf8");
  const { config, error } = ts.parseConfigFileTextToJson(path, text);
  if (error) {
    throw new Error(`failed to parse ${path}: ${JSON.stringify(error)}`);
  }
  return config as { compilerOptions?: { paths?: Record<string, string[]> } };
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

// Guards the fresh-checkout typecheck path (002d187b): CI builds
// mcp-server before mcp-bridge's own typecheck runs, so a regression here
// (typecheck script pointed back at the plain tsconfig, or the paths
// mapping pointed at a stale/missing/wrong sibling file) would still pass
// CI green while shipping a bridge that fails `npm run typecheck` in any
// worktree/checkout that hasn't built mcp-server first.
describe("bridge typecheck config (no-prior-build guard)", () => {
  it("routes `npm run typecheck` through tsconfig.typecheck.json", () => {
    const bridge = readPackageJson(resolve(PACKAGE_ROOT, "package.json"));
    expect(bridge.scripts?.typecheck).toMatch(
      /-p\s+tsconfig\.typecheck\.json\b/,
    );
  });

  it("maps @agent-tasks/mcp-server to a source file that exists", () => {
    const tsconfig = readTsconfigJsonc(
      resolve(PACKAGE_ROOT, "tsconfig.typecheck.json"),
    );
    const mapping =
      tsconfig.compilerOptions?.paths?.["@agent-tasks/mcp-server"];
    expect(mapping).toBeDefined();
    expect(mapping).toHaveLength(1);
    // No baseUrl is set, so tsc resolves this "paths" target relative to
    // the tsconfig file's own directory (mcp-bridge/), matching PACKAGE_ROOT.
    const mappedTarget = resolve(PACKAGE_ROOT, mapping![0]);
    expect(existsSync(mappedTarget)).toBe(true);
  });

  it("maps to the src twin of mcp-server's declared types entry", () => {
    const tsconfig = readTsconfigJsonc(
      resolve(PACKAGE_ROOT, "tsconfig.typecheck.json"),
    );
    const mapping =
      tsconfig.compilerOptions?.paths?.["@agent-tasks/mcp-server"]?.[0];
    const server = readPackageJson(resolve(MCP_SERVER_ROOT, "package.json"));
    const typesEntry = server.exports?.["."]?.types;
    // Non-vacuity: mcp-server must actually declare a types entry to derive
    // the expected src twin from.
    expect(typesEntry).toMatch(/^\.\/dist\/.+\.d\.ts$/);

    // Derive the source twin of the declared dist .d.ts entry, e.g.
    // "./dist/server.d.ts" -> "src/server.ts", and require the bridge's
    // paths mapping to point at exactly that file (as a path relative to
    // mcp-server's own root) — not just any file under mcp-server/src.
    const expectedSrcTwin = typesEntry!
      .replace(/^\.\//, "")
      .replace(/^dist\//, "src/")
      .replace(/\.d\.ts$/, ".ts");

    expect(mapping).toBeDefined();
    const mappedRelativeToServerRoot = resolve(
      PACKAGE_ROOT,
      mapping!,
    ).slice(MCP_SERVER_ROOT.length + 1);
    expect(mappedRelativeToServerRoot).toBe(expectedSrcTwin);
  });
});
