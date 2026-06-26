/** @vitest-environment jsdom */
/**
 * DOM-backed tests for the localStorage round-trip. The null-on-miss contract
 * of readStoredView is load-bearing: it is what distinguishes a sticky
 * preference from a missing one (absence is what triggers the count-based
 * auto-default in the page).
 */
import { describe, it, expect, beforeEach } from "vitest";

import { readStoredView, storeView } from "./teamsPrefs";

const KEY = "agent-tasks:teams:viewMode";

describe("teamsPrefs localStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when nothing is stored (so the auto-default runs)", () => {
    expect(readStoredView()).toBeNull();
  });

  it("round-trips a stored view both ways", () => {
    storeView("cards");
    expect(readStoredView()).toBe("cards");
    storeView("table");
    expect(readStoredView()).toBe("table");
  });

  it("ignores an invalid stored value", () => {
    window.localStorage.setItem(KEY, "kanban");
    expect(readStoredView()).toBeNull();
  });
});
