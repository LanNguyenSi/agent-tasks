// @ts-check
// (tsconfig's include only covers *.ts/*.tsx and checkJs is off, so without
// this pragma the @type annotation below would be inert and a type error
// here would only surface at next build. This file only enters the tsc
// program at all via tests/unit/csp.test.ts importing it -- deleting those
// tests would silently disable this checking too.)
import { resolveApiOrigin } from "./api-origin.mjs";

// The Content-Security-Policy header is set in src/middleware.ts, not here.
// It needs a fresh nonce per request (see csp.ts's module doc for why the
// RSC-streaming inline scripts Next.js itself injects require one), and
// next.config.mjs's headers() is evaluated once at build/start time, so it
// cannot carry a per-request value.
//
// Plain ESM (.mjs), not TypeScript: `next start` re-evaluates this file on
// every container boot, and doing that without a TS transpile step is what
// lets the prod Docker image skip shipping frontend/src, tsconfig.json, and
// the typescript package (see api-origin.mjs's doc comment and the
// 2026-08-17 incident it links).
/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: resolveApiOrigin(),
  },
};

export default nextConfig;
