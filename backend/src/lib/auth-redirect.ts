/**
 * Validator for the post-login redirect target that GitHub OAuth and SSO carry
 * through the provider round-trip in a short-lived HttpOnly cookie.
 *
 * The target arrives from a query string (`/api/auth/github?redirect=`,
 * `/api/auth/sso/:team?redirect=`) and again from the cookie, so both ends run
 * it through here; an absent or rejected value means "no target" and the
 * callback falls back to `/home`. The rules mirror `safeRedirect` in
 * frontend/src/lib/routes.ts (the frontend validates before it forwards, the
 * backend never trusts that) plus a length cap, and the allowlist is the same:
 * `/invite/...` and `/projects/<id>...`.
 *
 * Rules, in order (each one is pinned by its own test):
 *  1. a string
 *  2. at most MAX_REDIRECT_LENGTH characters
 *  3. one decodeURIComponent must succeed
 *  4. no control character, DEL, whitespace or backslash in the decoded value
 *     (a raw occurrence survives decoding, so this covers the raw value too)
 *  5. no `//` in the decoded path part (cut at the first `?` or `#`)
 *  6. no `.` or `..` segment in the decoded path part
 *  7. the raw value must resolve as a URL path to itself on the same origin
 *     (an encoded `?` or `#` would otherwise hide dot segments from rules 5
 *     and 6)
 *  8. the allowlist, anchored at the start: a single leading `/` followed by
 *     `invite/` or `projects/<id>`; a protocol-relative `//host`, an absolute
 *     URL or any other path is refused
 */

export const MAX_REDIRECT_LENGTH = 2048;

// Whitespace and backslash by pattern; the control range (C0 and DEL) by code
// point, since a control character inside a regex literal trips no-control-regex.
const WHITESPACE_OR_BACKSLASH = /[\s\\]/;
function hasBadChar(value: string): boolean {
  if (WHITESPACE_OR_BACKSLASH.test(value)) return true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
const PROJECTS_PATH = /^\/projects\/[^/?#]+(\/[^?#]*)?(\?[^#]*)?$/;

export function safeAuthRedirect(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_REDIRECT_LENGTH) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (hasBadChar(decoded)) return null;

  const decodedPath = decoded.split(/[?#]/)[0] ?? "";
  if (decodedPath.includes("//")) return null;
  if (decodedPath.split("/").some((segment) => segment === "." || segment === "..")) return null;

  let resolved: URL;
  try {
    resolved = new URL(raw, "http://redirect.invalid");
  } catch {
    return null;
  }
  if (resolved.pathname + resolved.search !== raw) return null;

  if (raw.startsWith("/invite/")) return raw;
  if (PROJECTS_PATH.test(raw)) return raw;
  return null;
}
