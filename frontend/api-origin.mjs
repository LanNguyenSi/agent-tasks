// @ts-check
/**
 * Resolves and validates the API origin the frontend calls for the JSON API.
 *
 * Deliberately lives here, at the frontend package root outside `src/`, and
 * as plain ESM rather than TypeScript: `next.config.mjs` imports this at
 * module scope, and keeping the whole import chain out of `src/` and free
 * of a TypeScript transpile step means the prod Docker image can ship
 * `next.config.mjs` (and this file) without needing `frontend/src`,
 * `tsconfig.json`, or the `typescript` package at all -- see the 2026-08-17
 * incident (frontend/Dockerfile's prod stage used to COPY all three in as a
 * hotfix, because `next.config.ts` needed on-the-fly TS transpilation to
 * re-evaluate at container start).
 *
 * `src/lib/csp.ts` re-exports this function so every existing importer
 * (middleware.ts, tests/unit/csp.test.ts) keeps working unchanged. Config
 * and middleware resolve their origin through this one module today; the
 * anti-drift assertions in tests/unit/csp.test.ts are what KEEP that true.
 * Precisely: for next.config.mjs any inline re-implementation is caught
 * (the validation-rejection test), while the middleware half is guarded by
 * VALUE agreement -- a drifted inline copy turns a test red, but a
 * behavior-identical inline copy in middleware.ts would pass until it
 * drifts.
 *
 * This value gets concatenated directly into the CSP header string (see
 * `buildCsp`'s connect-src in src/lib/csp.ts), so it's validated
 * defensively: it must parse as a URL, and it must not contain a `;` or
 * whitespace -- those are CSP directive delimiters, and an unvalidated
 * value containing them could inject extra directives into the header
 * instead of just extending connect-src.
 *
 * NEXT_PUBLIC_API_URL is meant to be a build-time value (see
 * docs/development.md: changing it requires rebuilding the frontend image,
 * a Docker build-arg baked into the build, not a runtime env var) -- but
 * this function is also invoked again at every `next start`, via
 * next.config.mjs's top-level `env.NEXT_PUBLIC_API_URL` call, because a
 * config file (plain ESM now, no transpile) is re-evaluated on every server
 * boot, not only at build. In the prod runtime image NEXT_PUBLIC_API_URL is
 * deliberately unset at container start (it's only ever supplied as a
 * Docker build-arg, never a runtime env var), so that start-time call just
 * resolves to the http://localhost:3001 fallback and is inert: `next start`
 * serves the already-built `.next` output, so neither the client bundle's
 * baked value nor middleware.ts's build-time-bundled connect-src origin
 * (both validated and fixed at `next build`, since middleware is compiled
 * ahead of time into an edge bundle) are affected by it. Failing fast here
 * still matters for the build itself: a bad value breaks `next build`
 * loudly instead of shipping a corrupted CSP.
 *
 * Consequence of the above: setting NEXT_PUBLIC_API_URL as a RUNTIME env
 * var on the prod container is unsupported -- an invalid value fails
 * `next start` hard (config evaluation throws) while a valid one is
 * silently ignored (the baked build-time value keeps serving).
 *
 * @returns {string} the validated API origin.
 */
export function resolveApiOrigin() {
  const value = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  try {
    new URL(value);
  } catch {
    throw new Error(`NEXT_PUBLIC_API_URL must be a valid absolute URL, got: ${JSON.stringify(value)}`);
  }
  if (/[;\s]/.test(value)) {
    throw new Error(
      `NEXT_PUBLIC_API_URL must not contain ';' or whitespace (CSP directive delimiters), got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}
