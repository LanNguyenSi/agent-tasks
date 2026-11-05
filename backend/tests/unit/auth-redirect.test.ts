/**
 * safeAuthRedirect (backend/src/lib/auth-redirect.ts): the validator for the
 * post-login redirect target carried through GitHub OAuth and SSO. One case
 * per rule, each input built so that only the rule under test refuses it.
 */
import { describe, expect, it } from "vitest";
import { MAX_REDIRECT_LENGTH, safeAuthRedirect } from "../../src/lib/auth-redirect.js";

describe("safeAuthRedirect accepted (returned unchanged)", () => {
  it.each([
    ["/invite/abc123"],
    ["/projects/p1"],
    ["/projects/p1/board"],
    ["/projects/p1/board?taskId=t1&view=list"],
    ["/projects/p1?x=http://example.com"],
    ["/invite/a%2Db"],
  ])("%s", (value) => {
    expect(safeAuthRedirect(value)).toBe(value);
  });

  it("a value of exactly the length cap is accepted", () => {
    const value = "/invite/" + "a".repeat(MAX_REDIRECT_LENGTH - "/invite/".length);
    expect(value.length).toBe(MAX_REDIRECT_LENGTH);
    expect(safeAuthRedirect(value)).toBe(value);
  });
});

describe("safeAuthRedirect refused, one rule per case", () => {
  it.each([[null], [undefined]])("rule 1: not a string (%s)", (value) => {
    expect(safeAuthRedirect(value as string | null | undefined)).toBeNull();
  });

  it("an empty string is refused (no later rule lets it through)", () => {
    expect(safeAuthRedirect("")).toBeNull();
  });

  it("rule 2: longer than the cap by one character", () => {
    const value = "/invite/" + "a".repeat(MAX_REDIRECT_LENGTH - "/invite/".length + 1);
    expect(value.length).toBe(MAX_REDIRECT_LENGTH + 1);
    expect(safeAuthRedirect(value)).toBeNull();
  });

  it("rule 3: a malformed percent escape does not decode", () => {
    expect(safeAuthRedirect("/invite/%E0%A4%A")).toBeNull();
  });

  it.each([
    ["control character", "/invite/a\u0001b"],
    ["newline", "/invite/a\nb"],
    ["DEL", "/invite/a\u007fb"],
    ["space", "/invite/a b"],
    ["backslash", "/invite/a\\b"],
    ["encoded backslash", "/invite/a%5Cb"],
    ["encoded newline", "/invite/a%0Ab"],
    ["encoded control character (survives URL resolution)", "/invite/a%01b"],
    ["encoded DEL (survives URL resolution)", "/invite/a%7Fb"],
    ["encoded space", "/invite/a%20b"],
  ])("rule 4: %s", (_label, value) => {
    expect(safeAuthRedirect(value)).toBeNull();
  });

  it.each([
    ["an encoded slash next to a slash", "/invite/a%2F%2Fb"],
    ["a literal // in the path", "/projects/p1//board"],
  ])("rule 5: // in the decoded path (%s)", (_label, value) => {
    expect(safeAuthRedirect(value)).toBeNull();
  });

  it.each([
    ["dot segment hidden in one encoded path segment", "/invite/a%2F.%2Fb"],
    ["dot-dot segment hidden in one encoded path segment", "/projects/p1/a%2F..%2Fb"],
    ["literal dot-dot segment", "/projects/p1/../x"],
  ])("rule 6: %s", (_label, value) => {
    expect(safeAuthRedirect(value)).toBeNull();
  });

  it("rule 7: an encoded ? hides a dot segment from rules 5 and 6 but not from the URL resolution", () => {
    expect(safeAuthRedirect("/invite/a%3F/../b")).toBeNull();
  });

  it("rule 7: a fragment does not resolve to itself", () => {
    expect(safeAuthRedirect("/invite/x#y")).toBeNull();
  });

  it.each([
    ["protocol-relative host", "//evil.com/invite/x"],
    ["absolute URL", "https://evil.com/invite/x"],
    ["javascript scheme", "javascript:alert(1)"],
    ["no leading slash", "invite/x"],
    ["a path outside the allowlist", "/etc/passwd"],
    ["the auth page itself", "/auth"],
    ["/invite without its trailing slash", "/invite"],
    ["/projects without an id", "/projects/"],
    ["/projects/<id> with a fragment", "/projects/p1#x"],
    ["a lookalike prefix", "/invitex/abc"],
    ["the allowlist prefix only inside the value", "/x/invite/abc"],
  ])("rule 8: %s", (_label, value) => {
    expect(safeAuthRedirect(value)).toBeNull();
  });
});
