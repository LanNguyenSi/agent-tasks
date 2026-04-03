import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
  extractSessionCookie,
  buildSessionCookie,
  buildClearSessionCookie,
} from "../../src/services/session.js";

const SECRET = "test-session-secret-must-be-32chars!!";
const USER_ID = "user-abc-123";
const GITHUB_TOKEN = "gho_test_token";

describe("createSessionToken + verifySessionToken", () => {
  it("creates a token that can be verified", async () => {
    const token = await createSessionToken(USER_ID, GITHUB_TOKEN, SECRET);
    const session = await verifySessionToken(token, SECRET);
    expect(session).not.toBeNull();
    expect(session!.userId).toBe(USER_ID);
    expect(session!.githubAccessToken).toBe(GITHUB_TOKEN);
  });

  it("token has 3 parts (header.payload.signature)", async () => {
    const token = await createSessionToken(USER_ID, GITHUB_TOKEN, SECRET);
    expect(token.split(".")).toHaveLength(3);
  });

  it("returns null for tampered token", async () => {
    const token = await createSessionToken(USER_ID, GITHUB_TOKEN, SECRET);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.invalid-signature`;
    expect(await verifySessionToken(tampered, SECRET)).toBeNull();
  });

  it("returns null for token with wrong secret", async () => {
    const token = await createSessionToken(USER_ID, GITHUB_TOKEN, SECRET);
    expect(await verifySessionToken(token, "different-secret-32chars-long!!")).toBeNull();
  });

  it("returns null for malformed token", async () => {
    expect(await verifySessionToken("not-a-token", SECRET)).toBeNull();
    expect(await verifySessionToken("", SECRET)).toBeNull();
    expect(await verifySessionToken("a.b", SECRET)).toBeNull();
  });
});

describe("extractSessionCookie", () => {
  it("extracts session value from cookie header", () => {
    const session = extractSessionCookie("session=my-token; other=value");
    expect(session).toBe("my-token");
  });

  it("handles URL-encoded cookie values", () => {
    const encoded = encodeURIComponent("header.payload.sig");
    const session = extractSessionCookie(`session=${encoded}`);
    expect(session).toBe("header.payload.sig");
  });

  it("returns null when no session cookie", () => {
    expect(extractSessionCookie("other=value")).toBeNull();
    expect(extractSessionCookie(null)).toBeNull();
    expect(extractSessionCookie(undefined)).toBeNull();
    expect(extractSessionCookie("")).toBeNull();
  });
});

describe("buildSessionCookie", () => {
  it("builds a cookie string with HttpOnly and SameSite", () => {
    const cookie = buildSessionCookie("my-token", false);
    expect(cookie).toContain("session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("includes Secure flag when secure=true", () => {
    expect(buildSessionCookie("tok", true)).toContain("Secure");
  });

  it("omits Secure flag when secure=false", () => {
    expect(buildSessionCookie("tok", false)).not.toContain("Secure");
  });
});

describe("buildClearSessionCookie", () => {
  it("sets Max-Age=0 to expire the cookie", () => {
    const cookie = buildClearSessionCookie();
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("session=;");
  });
});
