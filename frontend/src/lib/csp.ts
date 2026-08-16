import crypto from "node:crypto";
import { THEME_INIT_SCRIPT } from "./theme";

/**
 * Content-Security-Policy for the frontend.
 *
 * There is exactly one inline script in the app: the THEME_INIT_SCRIPT
 * injected via dangerouslySetInnerHTML in layout.tsx, which resolves and
 * applies the theme before first paint so the page never flashes the
 * wrong theme. There is no nonce infrastructure (next.config.ts headers()
 * runs once per build, not per request, so a per-request nonce isn't
 * available here without switching to middleware.ts), so script-src
 * allows that one script by its sha256 hash instead of 'unsafe-inline'.
 *
 * The hash is derived from THEME_INIT_SCRIPT itself rather than
 * hardcoded, so the header can never silently drift out of sync with the
 * script layout.tsx actually renders: editing theme.ts recomputes this
 * hash automatically. tests/unit/csp.test.ts additionally pins the
 * current hash value as a mutation probe: an edit to THEME_INIT_SCRIPT
 * changes the computed hash and turns that pinned assertion red, forcing
 * a conscious, reviewed update instead of a silent CSP break (the app
 * would still work post-edit since the header stays in sync, but the red
 * test flags that the security-sensitive inline script changed).
 */
export function sha256Base64(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("base64");
}

export const THEME_INIT_SCRIPT_HASH = sha256Base64(THEME_INIT_SCRIPT);

export interface BuildCspOptions {
  /** Origin the frontend calls for the JSON API, e.g. http://localhost:3001. */
  apiOrigin: string;
  /**
   * `next dev`'s Fast Refresh / source maps rely on eval(). Never set this
   * for a production build (`next build` then `next start`) -- only for
   * `next dev`, which this CSP is not verified against (see AGENTS.md:
   * verification always runs against a production build).
   */
  allowDevEval: boolean;
}

/**
 * Builds the CSP directive string. Report-only for now (see next.config.ts):
 * the enforce flip (Content-Security-Policy instead of
 * Content-Security-Policy-Report-Only) is a follow-up task once report-only
 * has run clean in production for a burn-in period.
 */
export function buildCsp({ apiOrigin, allowDevEval }: BuildCspOptions): string {
  const scriptSrc = ["'self'", `'sha256-${THEME_INIT_SCRIPT_HASH}'`];
  if (allowDevEval) {
    scriptSrc.push("'unsafe-eval'");
  }

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    // No styled-jsx `<style jsx>` usage in the app and next/font self-hosts
    // fonts as static files (no injected inline @font-face style tag), so
    // style-src doesn't need 'unsafe-inline'. Re-verify this if styled-jsx
    // or a runtime inline-style-injecting library is introduced.
    ["style-src", ["'self'"]],
    ["img-src", ["'self'", "data:"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", apiOrigin]],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
