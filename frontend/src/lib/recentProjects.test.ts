/** @vitest-environment jsdom */
/**
 * localStorage round-trip for the Home "Your projects" strip recents
 * (T05): most-recent-first order, dedupe on re-visit, the 8-id cap, the
 * corrupt/absent/blocked-storage fallbacks, and per-team key isolation
 * (one team's list must never leak into another's).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  readRecentProjects,
  recordRecentProject,
  RECENT_PROJECTS_LIMIT,
} from "./recentProjects";

const KEY = "agent-tasks:recentProjects:team-1";

function stored(teamId = "team-1"): string[] | null {
  const raw = window.localStorage.getItem(`agent-tasks:recentProjects:${teamId}`);
  return raw === null ? null : (JSON.parse(raw) as string[]);
}

describe("recentProjects localStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads an empty list when nothing is stored", () => {
    expect(readRecentProjects("team-1")).toEqual([]);
  });

  it("records ids most-recent-first", () => {
    recordRecentProject("team-1", "p1");
    recordRecentProject("team-1", "p2");
    expect(readRecentProjects("team-1")).toEqual(["p2", "p1"]);
    expect(stored()).toEqual(["p2", "p1"]);
  });

  it("dedupes: re-visiting moves the id to the front instead of duplicating", () => {
    recordRecentProject("team-1", "p1");
    recordRecentProject("team-1", "p2");
    recordRecentProject("team-1", "p3");
    recordRecentProject("team-1", "p1");
    expect(readRecentProjects("team-1")).toEqual(["p1", "p3", "p2"]);
    expect(stored()).toEqual(["p1", "p3", "p2"]);
  });

  it("caps the list at 8 ids, dropping the least recent", () => {
    for (let i = 1; i <= 10; i++) recordRecentProject("team-1", `p${i}`);
    const ids = readRecentProjects("team-1");
    expect(ids).toHaveLength(RECENT_PROJECTS_LIMIT);
    expect(ids).toEqual(["p10", "p9", "p8", "p7", "p6", "p5", "p4", "p3"]);
    expect(stored()?.length).toBe(8);
  });

  it("ignores blank ids", () => {
    recordRecentProject("team-1", "");
    recordRecentProject("", "p1");
    expect(readRecentProjects("team-1")).toEqual([]);
    expect(stored()).toBeNull();
  });

  it("keeps one list per team", () => {
    recordRecentProject("team-1", "p1");
    recordRecentProject("team-2", "p2");
    expect(readRecentProjects("team-1")).toEqual(["p1"]);
    expect(readRecentProjects("team-2")).toEqual(["p2"]);
    expect(window.localStorage.getItem("agent-tasks:recentProjects:team-2")).toBe(
      JSON.stringify(["p2"]),
    );
  });

  it("treats corrupt or non-array stored data as no recents", () => {
    window.localStorage.setItem(KEY, "not json");
    expect(readRecentProjects("team-1")).toEqual([]);
    window.localStorage.setItem(KEY, JSON.stringify({ a: 1 }));
    expect(readRecentProjects("team-1")).toEqual([]);
    window.localStorage.setItem(KEY, JSON.stringify(["p1", 7, "", null, "p2", "p1"]));
    expect(readRecentProjects("team-1")).toEqual(["p1", "p2"]);
  });

  it("drops duplicate ids from stored data, first occurrence wins", () => {
    window.localStorage.setItem(KEY, JSON.stringify(["p2", "p1", "p2", "p3"]));
    expect(readRecentProjects("team-1")).toEqual(["p2", "p1", "p3"]);
  });

  it("caps a hand-stored longer array on read", () => {
    const many = Array.from({ length: 12 }, (_, i) => `p${i}`);
    window.localStorage.setItem(KEY, JSON.stringify(many));
    expect(readRecentProjects("team-1")).toEqual(many.slice(0, RECENT_PROJECTS_LIMIT));
  });

  it("survives storage that throws (private mode)", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readRecentProjects("team-1")).toEqual([]);
    expect(() => recordRecentProject("team-1", "p1")).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});
