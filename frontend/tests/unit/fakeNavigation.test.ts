/**
 * The in-memory history of tests/setup/fakeNavigation.ts behaves like the
 * browser's for the operations the page tests rely on: push drops the
 * forward entries, replace swaps the current entry and keeps them.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { nav, router } from "../setup/fakeNavigation";

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

describe("fakeNavigation deferred navigations (the app router's pending navigation)", () => {
  beforeEach(() => {
    nav.reset("/a");
    nav.deferNavigations();
  });

  it("a push stays pending until settle, then adds its entry", () => {
    router.push("/b");
    expect(nav.url).toBe("/a");
    expect(nav.pending).toBe("/b");
    nav.settle();
    expect(nav.entries).toEqual(["/a", "/b"]);
    expect(nav.pending).toBeNull();
  });

  it("a replace dispatched while a push is pending discards the push", () => {
    router.push("/b");
    router.replace("/a?x=1");
    nav.settle();
    expect(nav.entries).toEqual(["/a?x=1"]);
    expect(nav.url).toBe("/a?x=1");
  });

  it("a newer push discards the pending one", () => {
    router.push("/b");
    router.push("/c");
    nav.settle();
    expect(nav.entries).toEqual(["/a", "/c"]);
  });

  it("a push that settled before a replace is kept, and the replace swaps its entry", () => {
    router.push("/b");
    nav.settle();
    router.replace("/b?x=1");
    nav.settle();
    expect(nav.entries).toEqual(["/a", "/b?x=1"]);
  });

  it("reset switches the mode off again: navigations apply at once", () => {
    nav.reset("/a");
    router.push("/b");
    expect(nav.url).toBe("/b");
    expect(nav.pending).toBeNull();
  });
});
