/**
 * Regression guard: no bare z.string().url() may survive in backend source.
 *
 * Every user/agent-writable URL field must use httpUrl() from lib/url-guard
 * instead of a bare z.string().url(). The bare form accepts javascript:/data:/
 * vbscript: URLs, which become stored XSS once rendered as an <a href> in the
 * UI (and weakens the SSRF posture for server-consumed URLs).
 *
 * This test scans every .ts file under backend/src/ at CI time and fails if
 * the forbidden pattern appears outside the two legitimate sites, naming the
 * offending file(s) so the developer switches to httpUrl().
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, "../../src");

// Whitespace-tolerant so a reformatted `z.string()\n  .url(` cannot slip past.
const FORBIDDEN = /z\s*\.\s*string\s*\(\s*\)\s*\.\s*url\s*\(/;

// The only legitimate bare-url sites:
//  - lib/url-guard.ts: the canonical helper (defines httpUrl over .url()).
//  - config/index.ts: server env schema (DATABASE_URL etc.) — not request input.
const ALLOWLIST = [
  path.join("lib", "url-guard.ts"),
  path.join("config", "index.ts"),
];

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("url-guard regression: no bare z.string().url() in backend source", () => {
  it("all URL fields use httpUrl() from lib/url-guard instead of bare z.string().url()", () => {
    const tsFiles = collectTsFiles(srcDir);
    expect(tsFiles.length).toBeGreaterThan(0);

    const offenders = tsFiles.filter((file) => {
      if (ALLOWLIST.some((suffix) => file.endsWith(suffix))) return false;
      return FORBIDDEN.test(readFileSync(file, "utf-8"));
    });

    if (offenders.length > 0) {
      const names = offenders.map((f) => path.relative(srcDir, f)).join(", ");
      throw new Error(
        `Found bare z.string().url() in: ${names}. Use httpUrl() from ` +
          "lib/url-guard for user/agent-writable URL fields to enforce the " +
          "http(s) scheme allowlist (or add the file to the allowlist if it is " +
          "a non-request, server-only URL).",
      );
    }

    expect(offenders).toHaveLength(0);
  });
});
