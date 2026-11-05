/**
 * GET /api/auth/github (Next route handler): redirects to the backend OAuth
 * start and forwards a `?redirect=` deep-link target only when it passes the
 * /auth page allowlist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const nav = vi.hoisted(() => ({ target: undefined as string | undefined }));
// The real redirect() throws; here it only records where it would go.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    nav.target = url;
  },
}));

import { GET } from "../../src/app/api/auth/github/route";

const ORIGINAL_API_URL = process.env.API_URL;

beforeEach(() => {
  nav.target = undefined;
  process.env.API_URL = "http://api.test";
});
afterEach(() => {
  if (ORIGINAL_API_URL === undefined) delete process.env.API_URL;
  else process.env.API_URL = ORIGINAL_API_URL;
});

function call(search: string) {
  GET(new Request(`http://localhost:3000/api/auth/github${search}`));
  return nav.target;
}

describe("GET /api/auth/github", () => {
  it("no redirect parameter: plain backend URL", () => {
    expect(call("")).toBe("http://api.test/api/auth/github");
  });

  it("a safe target is forwarded, query-encoded", () => {
    expect(call(`?redirect=${encodeURIComponent("/projects/p1/board?view=list")}`)).toBe(
      `http://api.test/api/auth/github?redirect=${encodeURIComponent("/projects/p1/board?view=list")}`,
    );
  });

  it.each([["//evil.com"], ["https://evil.com"], ["/etc/passwd"], ["/projects/p1/../x"]])(
    "an unsafe target is dropped (%s)",
    (value) => {
      expect(call(`?redirect=${encodeURIComponent(value)}`)).toBe("http://api.test/api/auth/github");
    },
  );

  it("other query parameters are not forwarded", () => {
    expect(call("?foo=bar&redirect=%2Finvite%2Fabc")).toBe(
      "http://api.test/api/auth/github?redirect=%2Finvite%2Fabc",
    );
  });
});
