import { afterEach, describe, it, expect, vi } from "vitest";
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
    expect(directives["img-src"]).toEqual(["'self'", "data:", "https://avatars.githubusercontent.com"]);
    expect(directives["font-src"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'self'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["form-action"]).toEqual(["'self'"]);
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

  it("accepts a well-formed absolute URL", () => {
    const original = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
    try {
      expect(resolveApiOrigin()).toBe("https://api.example.com");
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = original;
    }
  });

  it("throws when NEXT_PUBLIC_API_URL doesn't parse as a URL", () => {
    const original = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = "not-a-url";
    try {
      expect(() => resolveApiOrigin()).toThrow(/valid absolute URL/);
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = original;
    }
  });

  it("throws when NEXT_PUBLIC_API_URL contains a CSP delimiter (semicolon)", () => {
    const original = process.env.NEXT_PUBLIC_API_URL;
    // No space needed for this to be a valid URL and a CSP-directive-injection
    // vector: ";" alone is enough to start a new directive in the header string.
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.com;script-src-elem-evil.example.com";
    try {
      expect(() => resolveApiOrigin()).toThrow(/CSP directive delimiters/);
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = original;
    }
  });
});

describe("resolveApiOrigin re-export and config sharing (anti-drift)", () => {
  // A distinctive origin no fallback or hardcoded literal would ever carry:
  // any mutant that stops following NEXT_PUBLIC_API_URL fails to produce it.
  const DRIFT_PROBE_ORIGIN = "https://api.drift-probe.example";

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_API_URL;
    vi.resetModules();
  });

  it("csp.ts re-exports the exact same function as api-origin.mjs, not a local redefinition", async () => {
    // Mutation probe: re-defining resolveApiOrigin locally in src/lib/csp.ts
    // (instead of `export { resolveApiOrigin } from "../../api-origin.mjs"`)
    // turns this red, because the two references would then be distinct
    // function objects even if behaviorally identical. Both modules are
    // imported fresh from the same registry generation so the check stays
    // order-independent under vi.resetModules().
    vi.resetModules();
    const cspFresh = await import("@/lib/csp");
    const apiOriginFresh = await import("../../api-origin.mjs");
    expect(cspFresh.resolveApiOrigin).toBe(apiOriginFresh.resolveApiOrigin);
  });

  it("next.config.mjs resolves through the VALIDATING resolver: a delimiter-carrying env value rejects the import", async () => {
    // Mutation probe: re-implementing the resolution inline in next.config.mjs
    // (dropping the api-origin.mjs import) or hardcoding the value keeps the
    // config importable even with a CSP-directive-injection vector in the
    // env -- this import must reject instead, proving the config path still
    // runs resolveApiOrigin's validation.
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.com;script-src-evil.example.com";
    vi.resetModules();
    await expect(import("../../next.config.mjs")).rejects.toThrow(/CSP directive delimiters/);
  });

  it("next.config.mjs's env value follows NEXT_PUBLIC_API_URL, not a hardcoded literal (including the fallback literal)", async () => {
    // Mutation probe: hardcoding ANY literal in next.config.mjs -- including
    // the default http://localhost:3001 fallback, which the previous version
    // of this test could not distinguish -- turns this red, because the
    // distinctive probe origin must flow through.
    process.env.NEXT_PUBLIC_API_URL = DRIFT_PROBE_ORIGIN;
    vi.resetModules();
    const { default: nextConfig } = await import("../../next.config.mjs");
    expect(nextConfig.env?.NEXT_PUBLIC_API_URL).toBe(DRIFT_PROBE_ORIGIN);
  });

  it("middleware's connect-src carries resolveApiOrigin()'s value under the unset-env fallback", async () => {
    // Mutation probe: middleware resolving its origin inline with a drifted
    // fallback (instead of importing resolveApiOrigin) turns this red -- the
    // middleware half of the config/middleware pair is asserted by VALUE,
    // not just header shape.
    vi.resetModules();
    const { middleware: freshMiddleware } = await import("../../src/middleware");
    const { resolveApiOrigin: freshResolve } = await import("../../api-origin.mjs");
    const response = await freshMiddleware(new NextRequest("http://localhost:3100/dashboard"));
    const header = response.headers.get("Content-Security-Policy-Report-Only");
    const connectSrc = header
      ?.split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("connect-src"));
    expect(connectSrc).toBe(`connect-src 'self' ${freshResolve()}`);
  });

  it("middleware's connect-src and the config env value follow NEXT_PUBLIC_API_URL in lockstep", async () => {
    // Pins the explicit-env path on BOTH halves of the pair at once: config
    // env and middleware connect-src must carry the same distinctive origin.
    process.env.NEXT_PUBLIC_API_URL = DRIFT_PROBE_ORIGIN;
    vi.resetModules();
    const { middleware: freshMiddleware } = await import("../../src/middleware");
    const { default: nextConfig } = await import("../../next.config.mjs");
    const response = await freshMiddleware(new NextRequest("http://localhost:3100/dashboard"));
    const header = response.headers.get("Content-Security-Policy-Report-Only");
    const connectSrc = header
      ?.split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("connect-src"));
    expect(connectSrc).toBe(`connect-src 'self' ${DRIFT_PROBE_ORIGIN}`);
    expect(nextConfig.env?.NEXT_PUBLIC_API_URL).toBe(DRIFT_PROBE_ORIGIN);
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
