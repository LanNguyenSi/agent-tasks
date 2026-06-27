/**
 * Regression guard: ensures no bare z.string().url() survives in request schemas.
 *
 * Every user/agent-writable URL field in a route must use httpUrl() from
 * lib/url-guard instead of a bare z.string().url(). The bare form accepts
 * javascript:/data:/vbscript: URLs, which become stored XSS once rendered
 * as an <a href> in the UI.
 *
 * This test reads every .ts file under backend/src/routes/ at CI time and
 * fails if the forbidden pattern is found, naming the offending file(s) so
 * the developer knows to switch to httpUrl() from lib/url-guard.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routesDir = path.resolve(__dirname, "../../src/routes");

const FORBIDDEN = "z.string().url(";

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("url-guard regression: no bare z.string().url() in routes", () => {
  it("all route files use httpUrl() from lib/url-guard instead of bare z.string().url()", () => {
    const tsFiles = collectTsFiles(routesDir);
    expect(tsFiles.length).toBeGreaterThan(0);

    const offenders = tsFiles.filter((file) => {
      const content = readFileSync(file, "utf-8");
      return content.includes(FORBIDDEN);
    });

    if (offenders.length > 0) {
      const names = offenders
        .map((f) => path.relative(routesDir, f))
        .join(", ");
      throw new Error(
        `Found bare ${FORBIDDEN}) in route file(s): ${names}. ` +
          "Use httpUrl() from lib/url-guard instead of z.string().url() for " +
          "user/agent-writable URL fields to enforce the http(s) scheme allowlist.",
      );
    }

    expect(offenders).toHaveLength(0);
  });
});
