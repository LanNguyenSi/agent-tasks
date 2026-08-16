#!/usr/bin/env node
/**
 * Postbuild guard for the CSP nonce (see src/app/layout.tsx's `await
 * headers()` and src/lib/csp.ts's module doc): the per-request nonce only
 * reaches Next's own RSC-streaming inline scripts if the app routes are
 * rendered dynamically, not prerendered as static HTML at build time.
 * `await headers()` in the root layout is what forces that dynamic
 * rendering; delete it (or otherwise let a route opt back into static
 * prerendering) and the route serves unnonced inline scripts that fail the
 * CSP with zero build-time or test-time signal (tsc, vitest, and `next
 * build` all stay green -- this was verified live).
 *
 * This script reads `.next/prerender-manifest.json`, which Next writes
 * during `next build` and which lists every route that got baked into
 * static HTML. Any app route beyond the explicit allowlist below appearing
 * there means static prerendering crept back in for that route, and the
 * script exits non-zero. Wired as `postbuild` in package.json so it runs
 * automatically after every `next build` (including the frontend CI job's
 * Build step), with no separate CI wiring required.
 *
 * ALLOWLIST is deliberately explicit rather than "N routes total": /icon.svg
 * is a static asset route (an actual SVG file, not a document that runs
 * scripts), so it legitimately prerenders. Nothing else should.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ALLOWLIST = new Set(["/icon.svg"]);

const frontendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(frontendRoot, ".next", "prerender-manifest.json");

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`assert-dynamic-rendering: could not read ${manifestPath}: ${error.message}`);
  process.exit(1);
}

const staticRoutes = Object.keys(manifest.routes ?? {});
const unexpected = staticRoutes.filter((route) => !ALLOWLIST.has(route));

if (unexpected.length > 0) {
  console.error(
    "assert-dynamic-rendering: the following routes were statically prerendered " +
      "instead of rendered dynamically:\n" +
      unexpected.map((route) => `  ${route}`).join("\n") +
      "\n\nThis app relies on per-request dynamic rendering (forced by `await headers()` " +
      "in src/app/layout.tsx) so Next applies the CSP nonce to its own injected inline " +
      "scripts. A route rendering statically means it now serves those scripts unnonced, " +
      "which fails the Content-Security-Policy header silently (no console signal until " +
      "the enforce flip, see docs/development.md). If you removed `await headers()` from " +
      "the root layout, restore it. If this is an intentional new static route, add it to " +
      "ALLOWLIST in scripts/assert-dynamic-rendering.mjs with a comment explaining why it " +
      "doesn't need the nonce.",
  );
  process.exit(1);
}

console.log(
  `assert-dynamic-rendering: ok (${staticRoutes.length} statically prerendered route(s), all allowlisted)`,
);
