import { describe, it, expect } from "vitest";
import { normalizeIssuer } from "../../src/services/issuer.js";

describe("normalizeIssuer", () => {
  it.each([
    ["no trailing slash", "https://idp.example.com", "https://idp.example.com"],
    ["one trailing slash", "https://idp.example.com/", "https://idp.example.com"],
    ["several trailing slashes", "https://idp.example.com///", "https://idp.example.com"],
    ["an internal double slash is kept", "https://idp.example.com//tenant/", "https://idp.example.com//tenant"],
    ["case is kept", "https://IdP.Example.com/Tenant/", "https://IdP.Example.com/Tenant"],
    ["empty string", "", ""],
    ["only slashes", "///", ""],
    ["a query is kept as is", "https://idp.example.com/?a=b", "https://idp.example.com/?a=b"],
    ["a fragment is kept as is", "https://idp.example.com/#x", "https://idp.example.com/#x"],
    ["slashes before a query are kept", "https://idp.example.com//?a=b", "https://idp.example.com//?a=b"],
  ])("%s", (_name, input, expected) => {
    expect(normalizeIssuer(input)).toBe(expected);
  });
});
