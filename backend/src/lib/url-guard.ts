import { z } from "zod";

// Allow only http(s) URLs — blocks javascript:/data:/vbscript:/file:/etc.
export function isHttpScheme(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

// Zod builder for a user/agent-writable URL field that must be http(s).
// Use this instead of a bare z.url() (or its v3 alias z.string().url())
// anywhere a URL comes from a request body, so the scheme allowlist is never
// accidentally omitted.
//
// The optional `max` option applies a character-length cap BEFORE the scheme
// refine (a plain URL format does not compose with .max() alone), so the two
// constraints are composed in the correct order: validate shape → cap length →
// check scheme.
//
// v4 note: `z.url()` is the v4 home of v3's `.url()`; its accept-set was
// verified identical to zod 3.25.76 on a URL battery (see the migration report),
// so the http(s) scheme refine below yields the same final accept-set as the
// base — no new scheme is let through.
export function httpUrl(opts?: { max?: number }) {
  let base = z.url();
  if (opts?.max !== undefined) {
    base = base.max(opts.max);
  }
  return base.refine(isHttpScheme, {
    message: "URL must use the http or https scheme",
  });
}
