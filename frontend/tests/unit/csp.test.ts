import { describe, it, expect } from "vitest";
import { buildCsp, sha256Base64, THEME_INIT_SCRIPT_HASH } from "@/lib/csp";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import nextConfig from "../../next.config";

// Pinned sha256 (base64) of the current THEME_INIT_SCRIPT, computed the same
// way CSP hash-sources are: over the exact inline-script bytes, utf-8,
// base64-encoded (no <script> tags, no trailing newline). Recomputed here
// with a locally-declared implementation of the CSP hashing rule (not by
// importing sha256Base64) so this assertion doesn't just check the module
// against itself.
//
// Mutation probe: edit THEME_INIT_SCRIPT in src/lib/theme.ts and this test
// goes red, because the header would now serve a different hash than this
// pinned value. The header itself never drifts out of sync (THEME_INIT_SCRIPT_HASH
// is derived from THEME_INIT_SCRIPT at import time), but a change to a
// security-sensitive inline script should be a conscious, reviewed action --
// this pinned value forces exactly that: update it deliberately once you've
// confirmed the new script is intended.
const PINNED_THEME_INIT_SCRIPT_HASH = "34dvh5zd63a947o/A3NSvvdq/R1O/d5yRMSK+PeQE7U=";

describe("THEME_INIT_SCRIPT_HASH", () => {
  it("matches the pinned hash of the current theme-init script", () => {
    expect(THEME_INIT_SCRIPT_HASH).toBe(PINNED_THEME_INIT_SCRIPT_HASH);
  });

  it("is derived from the live THEME_INIT_SCRIPT constant, not a hardcoded literal", async () => {
    const { createHash } = await import("node:crypto");
    const independentlyComputed = createHash("sha256")
      .update(THEME_INIT_SCRIPT, "utf8")
      .digest("base64");
    expect(THEME_INIT_SCRIPT_HASH).toBe(independentlyComputed);
  });
});

describe("sha256Base64", () => {
  it("matches Node's own sha256/base64 digest for arbitrary content", () => {
    expect(sha256Base64("hello")).toBe(
      "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
    );
  });
});

describe("buildCsp", () => {
  const csp = buildCsp({ apiOrigin: "http://localhost:3001", allowDevEval: false });
  const directives = Object.fromEntries(
    csp.split("; ").map((d) => {
      const [name, ...values] = d.split(" ");
      return [name, values];
    }),
  );

  it("locks script-src to self plus the theme-init script hash, no unsafe-inline", () => {
    expect(directives["script-src"]).toEqual([
      "'self'",
      `'sha256-${THEME_INIT_SCRIPT_HASH}'`,
    ]);
    expect(csp).not.toContain("unsafe-inline");
  });

  it("adds 'unsafe-eval' to script-src only when allowDevEval is set", () => {
    const devCsp = buildCsp({ apiOrigin: "http://localhost:3001", allowDevEval: true });
    expect(devCsp).toContain("script-src 'self' 'sha256-");
    expect(devCsp).toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("sets the remaining directives per spec", () => {
    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["style-src"]).toEqual(["'self'"]);
    expect(directives["img-src"]).toEqual(["'self'", "data:"]);
    expect(directives["font-src"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'self'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
  });

  it("includes the API origin in connect-src alongside 'self'", () => {
    expect(directives["connect-src"]).toEqual(["'self'", "http://localhost:3001"]);
  });
});

describe("next.config.ts headers()", () => {
  it("serves Content-Security-Policy-Report-Only on every path", async () => {
    // Mutation probe: removing (or renaming the key of) the CSP entry from
    // next.config.ts's headers() return value turns this test red.
    const entries = await nextConfig.headers?.();
    expect(entries).toBeDefined();
    const rootEntry = entries?.find((entry) => entry.source === "/:path*");
    expect(rootEntry).toBeDefined();

    const cspHeader = rootEntry?.headers.find(
      (h) => h.key === "Content-Security-Policy-Report-Only",
    );
    expect(cspHeader).toBeDefined();
    expect(cspHeader?.value).toContain("script-src 'self'");
    expect(cspHeader?.value).toContain(`'sha256-${THEME_INIT_SCRIPT_HASH}'`);
    expect(cspHeader?.value).toContain("frame-ancestors 'none'");

    // Not yet enforced in this PR -- the enforce flip is a follow-up.
    const enforcingHeader = rootEntry?.headers.find(
      (h) => h.key === "Content-Security-Policy",
    );
    expect(enforcingHeader).toBeUndefined();
  });
});
