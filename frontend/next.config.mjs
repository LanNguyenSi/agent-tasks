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
  // Legacy `/teams` -> `/projects` (UI/IA stage 3). Exact source: only the
  // `/teams` list URL redirects, `/teams/tokens` keeps its own page. Next
  // appends the request's query string to a destination that carries none,
  // so `/teams?teamId=t1` 307s to `Location: /projects?teamId=t1` (proven
  // with `curl -sI` against `next start`, and pinned by
  // tests/unit/next-config.test.ts). permanent: false -> 307, so browsers
  // do not cache a redirect the IA restructure may still move.
  // `next start` evaluates redirects() at boot (same lifecycle as env above),
  // so the prod image needs no src for it.
  async redirects() {
    return [
      {
        source: "/teams",
        destination: "/projects",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
