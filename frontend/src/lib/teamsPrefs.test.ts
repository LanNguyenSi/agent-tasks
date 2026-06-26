/**
 * Unit tests for the /teams view-mode preference helpers.
 *
 * Pure logic only — no DOM, no localStorage. The read/store functions
 * are not tested directly here (they require a DOM); correctness of the
 * auto-default logic is fully covered by passing explicit `storedView`
 * args to `resolveInitialView`.
 */
import { describe, it, expect } from "vitest";
import {
  isTeamsViewMode,
  resolveInitialView,
  TEAMS_VIEW_THRESHOLD,
} from "./teamsPrefs";

describe("isTeamsViewMode", () => {
  it("accepts valid values", () => {
    expect(isTeamsViewMode("table")).toBe(true);
    expect(isTeamsViewMode("cards")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isTeamsViewMode("board")).toBe(false);
    expect(isTeamsViewMode("")).toBe(false);
    expect(isTeamsViewMode(null)).toBe(false);
    expect(isTeamsViewMode(undefined)).toBe(false);
    expect(isTeamsViewMode(42)).toBe(false);
  });
});

describe("resolveInitialView", () => {
  it("defaults to cards when count is below threshold and no stored pref", () => {
    expect(resolveInitialView({ storedView: null, projectCount: 5 })).toBe("cards");
  });

  it("defaults to table when count is above threshold and no stored pref", () => {
    expect(
      resolveInitialView({ storedView: null, projectCount: TEAMS_VIEW_THRESHOLD + 1 }),
    ).toBe("table");
  });

  it("defaults to cards at exactly the threshold (boundary is inclusive)", () => {
    expect(
      resolveInitialView({ storedView: null, projectCount: TEAMS_VIEW_THRESHOLD }),
    ).toBe("cards");
  });

  it("stored 'table' overrides a low count — sticky preference wins", () => {
    expect(resolveInitialView({ storedView: "table", projectCount: 3 })).toBe("table");
  });

  it("stored 'cards' overrides a high count — sticky preference wins", () => {
    expect(resolveInitialView({ storedView: "cards", projectCount: 50 })).toBe("cards");
  });

  it("respects a custom threshold", () => {
    expect(
      resolveInitialView({ storedView: null, projectCount: 5, threshold: 3 }),
    ).toBe("table");
    expect(
      resolveInitialView({ storedView: null, projectCount: 3, threshold: 3 }),
    ).toBe("cards");
  });
});
