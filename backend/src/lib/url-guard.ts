import { z } from "zod";

// Allow only http(s) URLs — blocks javascript:/data:/vbscript:/file:/etc.
export function isHttpScheme(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

// Zod builder for a user/agent-writable URL field that must be http(s).
// Use this instead of a bare z.string().url() anywhere a URL comes from a
// request body, so the scheme allowlist is never accidentally omitted.
//
// The optional `max` option applies a character-length cap BEFORE the scheme
// refine (ZodEffects does not expose .max()), so the two constraints are
// composed in the correct order: validate shape → cap length → check scheme.
export function httpUrl(opts?: { max?: number }) {
  let base = z.string().url();
  if (opts?.max !== undefined) {
    base = base.max(opts.max);
  }
  return base.refine(isHttpScheme, {
    message: "URL must use the http or https scheme",
  });
}
