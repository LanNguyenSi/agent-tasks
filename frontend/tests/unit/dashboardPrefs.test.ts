/** @vitest-environment jsdom */
/**
 * Unit tests for the dashboard view-preference helpers.
 *
 * Covers the pure done-visibility predicate (the core of V1's
 * age-based filter) and the localStorage round-trips for done
 * visibility, view mode, and sort, including the validation paths that
 * reject stale / tampered values.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DONE_VISIBILITY,
  DEFAULT_VIEW_MODE,
  DONE_RECENT_DAYS,
  isDoneTaskHidden,
  isDoneVisibility,
  isViewMode,
  readStoredDoneVisibility,
  readStoredSort,
  readStoredViewMode,
  storeDoneVisibility,
  storeSort,
  storeViewMode,
} from "../../src/lib/dashboardPrefs";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-03T00:00:00.000Z").getTime();

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY_MS).toISOString();
}

const VALID_SORT_COLUMNS = ["title", "status", "assignee", "due", "updated", "priority"];

describe("isDoneVisibility / isViewMode", () => {
  it("accepts only the known enum values", () => {
    expect(isDoneVisibility("recent")).toBe(true);
    expect(isDoneVisibility("all")).toBe(true);
    expect(isDoneVisibility("none")).toBe(true);
    expect(isDoneVisibility("banana")).toBe(false);
    expect(isDoneVisibility(null)).toBe(false);

    expect(isViewMode("board")).toBe(true);
    expect(isViewMode("list")).toBe(true);
    expect(isViewMode("kanban")).toBe(false);
  });
});

describe("isDoneTaskHidden", () => {
  it("never hides under 'all'", () => {
    expect(isDoneTaskHidden("all", daysAgo(365), NOW)).toBe(false);
    expect(isDoneTaskHidden("all", daysAgo(0), NOW)).toBe(false);
  });

  it("always hides under 'none'", () => {
    expect(isDoneTaskHidden("none", daysAgo(0), NOW)).toBe(true);
    expect(isDoneTaskHidden("none", daysAgo(365), NOW)).toBe(true);
  });

  it("under 'recent' shows tasks inside the window and hides older ones", () => {
    expect(isDoneTaskHidden("recent", daysAgo(1), NOW)).toBe(false);
    expect(isDoneTaskHidden("recent", daysAgo(DONE_RECENT_DAYS - 1), NOW)).toBe(false);
    expect(isDoneTaskHidden("recent", daysAgo(DONE_RECENT_DAYS + 1), NOW)).toBe(true);
  });

  it("treats exactly-at-the-window as still visible", () => {
    // now - updated === windowMs is NOT strictly greater, so visible.
    expect(isDoneTaskHidden("recent", daysAgo(DONE_RECENT_DAYS), NOW)).toBe(false);
  });

  it("respects a custom window", () => {
    const window7d = 7 * DAY_MS;
    expect(isDoneTaskHidden("recent", daysAgo(8), NOW, window7d)).toBe(true);
    expect(isDoneTaskHidden("recent", daysAgo(6), NOW, window7d)).toBe(false);
  });

  it("fails open (visible) on an unparseable timestamp", () => {
    expect(isDoneTaskHidden("recent", "not-a-date", NOW)).toBe(false);
  });
});

describe("done-visibility persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns the default when nothing is stored", () => {
    expect(readStoredDoneVisibility()).toBe(DEFAULT_DONE_VISIBILITY);
  });

  it("round-trips a stored value", () => {
    storeDoneVisibility("none");
    expect(readStoredDoneVisibility()).toBe("none");
  });

  it("falls back to the default for an invalid stored value", () => {
    window.localStorage.setItem("agent-tasks:dashboard:doneVisibility", "banana");
    expect(readStoredDoneVisibility()).toBe(DEFAULT_DONE_VISIBILITY);
  });
});

describe("view-mode persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns the default when nothing is stored", () => {
    expect(readStoredViewMode()).toBe(DEFAULT_VIEW_MODE);
  });

  it("round-trips a stored value", () => {
    storeViewMode("list");
    expect(readStoredViewMode()).toBe("list");
  });

  it("falls back to the default for an invalid stored value", () => {
    window.localStorage.setItem("agent-tasks:dashboard:viewMode", "kanban");
    expect(readStoredViewMode()).toBe(DEFAULT_VIEW_MODE);
  });
});

describe("sort persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns null when nothing is stored", () => {
    expect(readStoredSort(VALID_SORT_COLUMNS)).toBeNull();
  });

  it("round-trips a valid sort", () => {
    storeSort({ column: "priority", direction: "asc" });
    expect(readStoredSort(VALID_SORT_COLUMNS)).toEqual({ column: "priority", direction: "asc" });
  });

  it("rejects an unknown column", () => {
    window.localStorage.setItem(
      "agent-tasks:dashboard:sort",
      JSON.stringify({ column: "ssn", direction: "asc" }),
    );
    expect(readStoredSort(VALID_SORT_COLUMNS)).toBeNull();
  });

  it("rejects an invalid direction", () => {
    window.localStorage.setItem(
      "agent-tasks:dashboard:sort",
      JSON.stringify({ column: "updated", direction: "sideways" }),
    );
    expect(readStoredSort(VALID_SORT_COLUMNS)).toBeNull();
  });

  it("ignores malformed JSON", () => {
    window.localStorage.setItem("agent-tasks:dashboard:sort", "{not json");
    expect(readStoredSort(VALID_SORT_COLUMNS)).toBeNull();
  });
});
