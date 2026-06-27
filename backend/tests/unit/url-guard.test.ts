/**
 * Unit tests for backend/src/lib/url-guard.ts.
 * Verifies that isHttpScheme and httpUrl() accept http/https and reject
 * javascript:/data:/vbscript:/ftp:/empty strings.
 */
import { describe, it, expect } from "vitest";
import { isHttpScheme, httpUrl } from "../../src/lib/url-guard.js";

describe("isHttpScheme", () => {
  it.each(["http://example.com", "https://example.com", "HTTP://EXAMPLE.COM", "HTTPS://EXAMPLE.COM"])(
    "returns true for %s",
    (url) => {
      expect(isHttpScheme(url)).toBe(true);
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "ftp://example.com/x",
    "file:///etc/passwd",
    "",
    "example.com",
    "//example.com",
  ])("returns false for %s", (url) => {
    expect(isHttpScheme(url)).toBe(false);
  });
});

describe("httpUrl()", () => {
  const schema = httpUrl();

  it.each(["http://example.com", "https://example.com/path?q=1#anchor"])(
    "accepts %s",
    (url) => {
      const result = schema.safeParse(url);
      expect(result.success).toBe(true);
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "ftp://example.com/x",
    "",
    "not-a-url",
  ])("rejects %s", (url) => {
    const result = schema.safeParse(url);
    expect(result.success).toBe(false);
  });

  it("uses a descriptive error message for scheme violations", () => {
    const result = schema.safeParse("javascript:alert(1)");
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("http or https"))).toBe(true);
    }
  });

  it("accepts a max option to cap URL length", () => {
    const shortSchema = httpUrl({ max: 20 });
    expect(shortSchema.safeParse("http://ok.io").success).toBe(true);
    expect(shortSchema.safeParse("https://" + "x".repeat(30) + ".io").success).toBe(false);
  });
});
