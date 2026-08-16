import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { buildCsp, getThemeInitScriptHash, resolveApiOrigin, sha256Base64 } from "@/lib/csp";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { middleware } from "../../src/middleware";

// Pinned sha256 (base64) of the current THEME_INIT_SCRIPT, computed the same
// way CSP hash-sources are: over the exact inline-script bytes, utf-8,
// base64-encoded (no <script> tags, no trailing newline). Recomputed here
// with a locally-declared implementation of the CSP hashing rule (not by
// importing sha256Base64) so this assertion doesn't just check the module
// against itself.
//
// Mutation probe: edit THEME_INIT_SCRIPT in src/lib/theme.ts and this test
// goes red, because the header would now serve a different hash than this
// pinned value. The header itself never drifts out of sync
// (getThemeInitScriptHash() is derived from THEME_INIT_SCRIPT), but a
// change to a security-sensitive inline script should be a conscious,
// reviewed action -- this pinned value forces exactly that: update it
// deliberately once you've confirmed the new script is intended.
const PINNED_THEME_INIT_SCRIPT_HASH = "34dvh5zd63a947o/A3NSvvdq/R1O/d5yRMSK+PeQE7U=";

describe("getThemeInitScriptHash", () => {
  it("matches the pinned hash of the current theme-init script", async () => {
    expect(await getThemeInitScriptHash()).toBe(PINNED_THEME_INIT_SCRIPT_HASH);
  });

  it("is derived from the live THEME_INIT_SCRIPT constant, not a hardcoded literal", async () => {
    const { createHash } = await import("node:crypto");
    const independentlyComputed = createHash("sha256")
      .update(THEME_INIT_SCRIPT, "utf8")
      .digest("base64");
    expect(await getThemeInitScriptHash()).toBe(independentlyComputed);
  });
});

describe("sha256Base64", () => {
  it("matches Node's own sha256/base64 digest for arbitrary content", async () => {
    expect(await sha256Base64("hello")).toBe("LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=");
  });
});

describe("buildCsp", () => {
  it("locks script-src to self + the per-request nonce + the theme-init hash, no unsafe-inline", async () => {
    const themeInitScriptHash = await getThemeInitScriptHash();
    const csp = await buildCsp({ apiOrigin: "http://localhost:3001", nonce: "test-nonce", allowDevEval: false });
    const directives = Object.fromEntries(
      csp.split("; ").map((d) => {
        const [name, ...values] = d.split(" ");
        return [name, values];
      }),
    );

    expect(directives["script-src"]).toEqual([
      "'self'",
      "'nonce-test-nonce'",
      `'sha256-${themeInitScriptHash}'`,
    ]);
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("adds 'unsafe-eval' to script-src only when allowDevEval is set", async () => {
    const prodCsp = await buildCsp({
      apiOrigin: "http://localhost:3001",
      nonce: "test-nonce",
      allowDevEval: false,
    });
    const devCsp = await buildCsp({
      apiOrigin: "http://localhost:3001",
      nonce: "test-nonce",
      allowDevEval: true,
    });
    expect(devCsp).toContain("script-src 'self' 'nonce-test-nonce' 'sha256-");
    expect(devCsp).toContain("'unsafe-eval'");
    expect(prodCsp).not.toContain("'unsafe-eval'");
  });

  it("allows 'unsafe-inline' for style-src only (React style-attribute props need it; scripts stay strict)", async () => {
    const csp = await buildCsp({ apiOrigin: "http://localhost:3001", nonce: "test-nonce", allowDevEval: false });
    const directives = Object.fromEntries(
      csp.split("; ").map((d) => {
        const [name, ...values] = d.split(" ");
        return [name, values];
      }),
    );

    expect(directives["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("sets the remaining directives per spec", async () => {
    const csp = await buildCsp({ apiOrigin: "http://localhost:3001", nonce: "test-nonce", allowDevEval: false });
    const directives = Object.fromEntries(
      csp.split("; ").map((d) => {
        const [name, ...values] = d.split(" ");
        return [name, values];
      }),
    );

    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["img-src"]).toEqual(["'self'", "data:"]);
    expect(directives["font-src"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'self'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
  });

  it("includes the API origin in connect-src alongside 'self'", async () => {
    const csp = await buildCsp({ apiOrigin: "http://localhost:3001", nonce: "test-nonce", allowDevEval: false });
    const directives = Object.fromEntries(
      csp.split("; ").map((d) => {
        const [name, ...values] = d.split(" ");
        return [name, values];
      }),
    );

    expect(directives["connect-src"]).toEqual(["'self'", "http://localhost:3001"]);
  });
});

describe("resolveApiOrigin", () => {
  it("falls back to localhost:3001 when NEXT_PUBLIC_API_URL is unset", () => {
    const original = process.env.NEXT_PUBLIC_API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    try {
      expect(resolveApiOrigin()).toBe("http://localhost:3001");
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = original;
    }
  });
});

describe("middleware", () => {
  it("sets Content-Security-Policy-Report-Only on the response, not the enforcing header", async () => {
    // Mutation probe: removing the header-setting line in src/middleware.ts
    // (or the CSP entry it depends on) turns this test red.
    const themeInitScriptHash = await getThemeInitScriptHash();
    const request = new NextRequest("http://localhost:3100/dashboard");
    const response = await middleware(request);

    const reportOnly = response.headers.get("Content-Security-Policy-Report-Only");
    expect(reportOnly).toBeDefined();
    expect(reportOnly).toContain("script-src 'self' 'nonce-");
    expect(reportOnly).toContain(`'sha256-${themeInitScriptHash}'`);
    expect(reportOnly).toContain("frame-ancestors 'none'");

    // Not yet enforced in this PR -- the enforce flip is a follow-up.
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("uses a fresh nonce per request", async () => {
    const first = await middleware(new NextRequest("http://localhost:3100/dashboard"));
    const second = await middleware(new NextRequest("http://localhost:3100/dashboard"));

    const extractNonce = (value: string | null) => value?.match(/'nonce-([^']+)'/)?.[1];
    const firstNonce = extractNonce(first.headers.get("Content-Security-Policy-Report-Only"));
    const secondNonce = extractNonce(second.headers.get("Content-Security-Policy-Report-Only"));

    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
  });
});
