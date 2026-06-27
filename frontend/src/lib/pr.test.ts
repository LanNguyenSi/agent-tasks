/**
 * parsePrNumberFromUrl -- derives the prNumber the prPresent gate needs
 * from the PR URL a human types into the edit form.
 */
import { describe, it, expect } from "vitest";

import { isHttpUrl, parsePrNumberFromUrl } from "./pr";

describe("parsePrNumberFromUrl", () => {
  it("parses the canonical GitHub PR URL", () => {
    expect(parsePrNumberFromUrl("https://github.com/owner/repo/pull/336")).toBe(336);
  });

  it("tolerates trailing slash, query, and fragment", () => {
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/12/")).toBe(12);
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/12?w=1")).toBe(12);
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/12#discussion_r1")).toBe(12);
  });

  it("parses PR-file subpaths", () => {
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/77/files")).toBe(77);
  });

  it("returns null for URLs without a pull segment", () => {
    expect(parsePrNumberFromUrl("https://github.com/o/r")).toBeNull();
    expect(parsePrNumberFromUrl("https://gitlab.com/o/r/-/merge_requests/5")).toBeNull();
    expect(parsePrNumberFromUrl("")).toBeNull();
  });

  it("rejects malformed numbers", () => {
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/123abc")).toBeNull();
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/0")).toBeNull();
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isHttpUrl("https://github.com/o/r/pull/1")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it("rejects javascript:, data:, and other non-http schemes (the XSS guard)", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("JavaScript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isHttpUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
  });

  it("rejects null, undefined, and empty", () => {
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});
