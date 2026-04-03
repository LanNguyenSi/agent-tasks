import { describe, expect, it } from "vitest";
import { buildAuthorizationUrl, generateState } from "../../src/services/github-oauth.js";

describe("buildAuthorizationUrl", () => {
  it("includes client_id and state in the URL", () => {
    const url = buildAuthorizationUrl({ clientId: "test-client", clientSecret: "secret" }, "state123");
    expect(url).toContain("client_id=test-client");
    expect(url).toContain("state=state123");
    expect(url).toContain("github.com/login/oauth/authorize");
  });

  it("includes correct scopes", () => {
    const url = buildAuthorizationUrl({ clientId: "c", clientSecret: "s" }, "st");
    expect(url).toContain("read%3Auser");
  });

  it("includes redirect_uri when provided", () => {
    const url = buildAuthorizationUrl(
      { clientId: "c", clientSecret: "s", redirectUri: "http://localhost:3001/api/auth/github/callback" },
      "st",
    );
    expect(url).toContain("redirect_uri=");
  });

  it("omits redirect_uri when not provided", () => {
    const url = buildAuthorizationUrl({ clientId: "c", clientSecret: "s" }, "st");
    expect(url).not.toContain("redirect_uri");
  });
});

describe("generateState", () => {
  it("generates a non-empty string", () => {
    const state = generateState();
    expect(state.length).toBeGreaterThan(0);
  });

  it("generates unique states on each call", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });

  it("generates a 32-char hex string (16 bytes)", () => {
    const state = generateState();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
  });
});
