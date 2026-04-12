import { describe, expect, it } from "vitest";
import { classifyProbeResponse } from "../../src/services/github-health.js";

describe("classifyProbeResponse", () => {
  it("200 → healthy", () => {
    expect(classifyProbeResponse(200, false)).toBe("healthy");
  });

  it("401 → invalid (expired or revoked token)", () => {
    expect(classifyProbeResponse(401, false)).toBe("invalid");
  });

  it("403 → invalid (rate-limited or OAuth app revoked)", () => {
    // 403 can also be rate limiting, but in that case the user should
    // reconnect or wait — treating it as invalid is conservative but
    // doesn't cause harm (the UI shows a 'reconnect' prompt).
    expect(classifyProbeResponse(403, false)).toBe("invalid");
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
