import { urlString } from "./zod-formats.js";

// Allow only http(s) URLs — blocks javascript:/data:/vbscript:/file:/etc.
export function isHttpScheme(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

// Zod builder for a user/agent-writable URL field that must be http(s).
// Use this instead of a bare urlString() (or zod 4's z.url(), or zod 3's
// z.string().url()) anywhere a URL comes from a request body, so the scheme
// allowlist is never accidentally omitted.
//
// The optional `max` option applies a character-length cap BEFORE the scheme
// refine (a plain URL check does not compose with .max() alone), so the two
// constraints are composed in the correct order: validate shape → cap length →
// check scheme.
//
// v4 note: the base used zod 3's `z.string().url()`, which only checked that
// `new URL(value)` does not throw and returned the value UNCHANGED. The URL
// check here is `urlString()` from lib/zod-formats.ts (URL.canParse, value
// unchanged: no trim, no tab/CR/LF stripping), so the http(s) scheme refine
// below runs on the unchanged value and the final accept-set equals the base,
// with no new scheme let through.
export function httpUrl(opts?: { max?: number }) {
  let base = urlString();
  if (opts?.max !== undefined) {
    base = base.max(opts.max);
  }
  return base.refine(isHttpScheme, {
    message: "URL must use the http or https scheme",
  });
}
