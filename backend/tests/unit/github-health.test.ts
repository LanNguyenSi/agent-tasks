import { describe, expect, it } from "vitest";
import { classifyProbeResponse } from "../../src/services/github-health.js";

describe("classifyProbeResponse", () => {
  it("200 → healthy", () => {
    expect(classifyProbeResponse(200, false)).toBe("healthy");
  });

  it("401 → invalid (expired or revoked token)", () => {
    expect(classifyProbeResponse(401, false)).toBe("invalid");
  });

  it("403 without rate-limit markers → invalid (OAuth app revoked / scope downgrade)", () => {
    expect(classifyProbeResponse(403, false)).toBe("invalid");
  });

  it("403 with x-ratelimit-remaining=0 → unknown (transient, don't flap)", () => {
    expect(
      classifyProbeResponse(403, false, { "x-ratelimit-remaining": "0" }),
    ).toBe("unknown");
  });

  it("403 with retry-after header → unknown", () => {
    expect(classifyProbeResponse(403, false, { "retry-after": "60" })).toBe("unknown");
  });

  it("403 with rate-limit wording in body message → unknown", () => {
    expect(
      classifyProbeResponse(403, false, null, {
        message: "API rate limit exceeded for user",
      }),
    ).toBe("unknown");
  });

  it("403 with Headers instance (not plain record) is still classified", () => {
    const h = new Headers({ "x-ratelimit-remaining": "0" });
    expect(classifyProbeResponse(403, false, h)).toBe("unknown");
  });

  it("500 → unknown (transient server error, don't flap)", () => {
    expect(classifyProbeResponse(500, false)).toBe("unknown");
  });

  it("502 → unknown", () => {
    expect(classifyProbeResponse(502, false)).toBe("unknown");
  });

  it("fetch error → unknown", () => {
    expect(classifyProbeResponse(null, true)).toBe("unknown");
  });

  it("unexpected 404 → unknown (conservative, don't flip stored state)", () => {
    // GET /user shouldn't return 404, but if GitHub does something weird
    // we'd rather preserve the last known good state than flap the UI.
    expect(classifyProbeResponse(404, false)).toBe("unknown");
  });

  it("418 (teapot, hypothetical) → unknown", () => {
    expect(classifyProbeResponse(418, false)).toBe("unknown");
  });
});
