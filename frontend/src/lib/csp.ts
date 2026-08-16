import { THEME_INIT_SCRIPT } from "./theme";

/**
 * Content-Security-Policy for the frontend.
 *
 * The app itself renders exactly one inline script: THEME_INIT_SCRIPT,
 * injected via dangerouslySetInnerHTML in layout.tsx, which resolves and
 * applies the theme before first paint so the page never flashes the
 * wrong theme. script-src allows that one script by its sha256 hash
 * instead of 'unsafe-inline'.
 *
 * That alone is not enough, though: the Next.js App Router itself injects
 * several more inline `<script>` tags per page to stream RSC payloads to
 * the client for hydration (`self.__next_f.push(...)`), and their content
 * varies per request/page, so they can't be hash-pinned. This was
 * verified live against a production build (`next build` + `next start`)
 * -- a hash-only script-src produced dozens of CSP violations from these
 * framework-injected scripts alone. Next's documented fix is a per-request
 * nonce set on the CSP response header: middleware.ts generates one and
 * Next automatically tags its own injected inline scripts with it, no
 * hash needed for those. That's why the CSP header is emitted from
 * middleware.ts (which runs per request, so a nonce is available) rather
 * than next.config.ts's headers() (evaluated once at build time, so it
 * cannot carry a per-request value).
 *
 * The theme-init hash is derived from THEME_INIT_SCRIPT itself rather
 * than hardcoded, so it can never silently drift out of sync with the
 * script layout.tsx actually renders: editing theme.ts recomputes this
 * hash automatically. tests/unit/csp.test.ts additionally pins the
 * current hash value as a mutation probe: an edit to THEME_INIT_SCRIPT
 * changes the computed hash and turns that pinned assertion red, forcing
 * a conscious, reviewed update instead of a silent CSP break.
 *
 * Hashing uses the Web Crypto API (`crypto.subtle`), not node:crypto: this
 * module is imported by middleware.ts, which Next.js bundles for the Edge
 * runtime, and that bundler rejects `node:*` imports. `crypto.subtle` is
 * available in the Edge runtime, in Node.js (globally, no import needed,
 * on the Node >=22 this repo requires), and in browsers, so one
 * implementation covers every place this module is imported from.
 */

/** Origin the frontend calls for the JSON API. Shared so next.config.ts's
 * `env.NEXT_PUBLIC_API_URL` passthrough and middleware.ts's connect-src
 * directive resolve the same fallback and can't drift apart.
 *
 * This value gets concatenated directly into the CSP header string (see
 * buildCsp's connect-src below), so it's validated defensively: it must
 * parse as a URL, and it must not contain a `;` or whitespace -- those are
 * CSP directive delimiters, and an unvalidated value containing them could
 * inject extra directives into the header instead of just extending
 * connect-src. NEXT_PUBLIC_API_URL is a build-time value (see
 * docs/development.md: changing it requires rebuilding the frontend
 * image, a Docker build-arg baked into the build, not a runtime env var),
 * so failing fast here means a bad value breaks the build loudly instead
 * of shipping a corrupted CSP. */
export function resolveApiOrigin(): string {
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

export async function sha256Base64(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Memoized: the hash never changes within a running process (it's a pure
// function of the THEME_INIT_SCRIPT source constant), so there's no need
// to recompute it on every request.
let themeInitScriptHashPromise: Promise<string> | null = null;

export function getThemeInitScriptHash(): Promise<string> {
  if (!themeInitScriptHashPromise) {
    themeInitScriptHashPromise = sha256Base64(THEME_INIT_SCRIPT);
  }
  return themeInitScriptHashPromise;
}

export interface BuildCspOptions {
  /** Origin the frontend calls for the JSON API, e.g. http://localhost:3001. */
  apiOrigin: string;
  /** Per-request nonce (see module doc) that covers Next's own injected inline scripts. */
  nonce: string;
  /**
   * `next dev`'s Fast Refresh / source maps rely on eval(). Never set this
   * for a production build (`next build` then `next start`) -- only for
   * `next dev`, which this CSP is not verified against (see AGENTS.md:
   * verification always runs against a production build).
   */
  allowDevEval: boolean;
}

/**
 * Builds the CSP directive string. Report-only for now (see middleware.ts):
 * the enforce flip (Content-Security-Policy instead of
 * Content-Security-Policy-Report-Only) is a follow-up task once report-only
 * has run clean in production for a burn-in period.
 */
export async function buildCsp({ apiOrigin, nonce, allowDevEval }: BuildCspOptions): Promise<string> {
  const themeInitScriptHash = await getThemeInitScriptHash();
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, `'sha256-${themeInitScriptHash}'`];
  if (allowDevEval) {
    scriptSrc.push("'unsafe-eval'");
  }

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    // React's `style={{...}}` prop (12 files at last count) compiles to a
    // DOM style attribute, which CSP treats as an inline style. Unlike
    // scripts, nonces and hashes don't cover the style *attribute* per the
    // CSP spec (only `<style>` elements) -- 'unsafe-hashes' would, but has
    // inconsistent browser support -- so 'unsafe-inline' is the only
    // standard way to allow it. No styled-jsx `<style jsx>` usage exists in
    // the app; this is purely for the style-attribute case. The
    // script-src/style-src security postures are intentionally different:
    // style injection can't execute arbitrary JS the way inline script
    // injection can, so keeping script-src strict while allowing
    // style-src 'unsafe-inline' is the standard trade-off (e.g. GitHub's
    // CSP does the same).
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // avatarUrl (GitHub OAuth and SSO OIDC picture claims) renders as a plain
    // <img> on every authenticated page (AppHeader.tsx and others). GitHub
    // avatars are served from avatars.githubusercontent.com, so that origin
    // is allowlisted here. SSO deployments must add their own IdP's avatar
    // origin (see docs/development.md) before the enforce flip, or SSO-linked
    // avatars will be blocked once the header stops being report-only.
    ["img-src", ["'self'", "data:", "https://avatars.githubusercontent.com"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", apiOrigin]],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    // Every form in the app submits via onSubmit (fetch/JS), not a plain
    // HTML form action, so restricting form submission targets to 'self'
    // doesn't break anything and closes off form-hijacking via injected
    // markup.
    ["form-action", ["'self'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
