/**
 * The in-memory history of tests/setup/fakeNavigation.ts behaves like the
 * browser's for the operations the page tests rely on: push drops the
 * forward entries, replace swaps the current entry and keeps them.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { nav } from "../setup/fakeNavigation";

beforeEach(() => nav.reset("/a"));

describe("fakeNavigation history", () => {
  it("push adds an entry and drops the forward entries", () => {
    nav.push("/b");
    nav.push("/c");
    nav.back();
    nav.push("/d");
    expect(nav.entries).toEqual(["/a", "/b", "/d"]);
    expect(nav.index).toBe(2);
  });

  it("replace swaps the current entry and keeps the forward entries", () => {
    nav.push("/b");
    nav.push("/c");
    nav.back();
    nav.replace("/b2");
    expect(nav.entries).toEqual(["/a", "/b2", "/c"]);
    expect(nav.index).toBe(1);
    nav.forward();
    expect(nav.url).toBe("/c");
  });
});
