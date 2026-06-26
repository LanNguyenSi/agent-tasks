/**
 * Sorting logic for the /teams projects table: per-column comparators, the
 * header-click direction rule, and the nullable/async-count edge cases.
 */
import { describe, it, expect } from "vitest";

import type { Project } from "./api";
import { compareProjects, naturalDirection, nextSort, sortProjects } from "./projectSort";

// Minimal Project factory — only the fields the comparators read are
// meaningful; the rest are filled so the object satisfies the type.
// Defaults come first so the `...over` spread wins for whatever a test sets.
function project(over: Partial<Project> & { id: string }): Project {
  return {
    name: over.id,
    slug: over.id,
    githubRepo: null,
    githubSyncAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Project;
}

const ids = (rows: Project[]) => rows.map((r) => r.id);

describe("naturalDirection", () => {
  it("ascends first for alphabetical columns", () => {
    expect(naturalDirection("name")).toBe("asc");
    expect(naturalDirection("repo")).toBe("asc");
  });

  it("descends first for numeric and date columns", () => {
    expect(naturalDirection("activeTasks")).toBe("desc");
    expect(naturalDirection("createdAt")).toBe("desc");
    expect(naturalDirection("syncedAt")).toBe("desc");
  });
});

describe("nextSort", () => {
  it("flips direction when re-clicking the active column", () => {
    expect(nextSort({ column: "name", direction: "asc" }, "name")).toEqual({
      column: "name",
      direction: "desc",
    });
    expect(nextSort({ column: "createdAt", direction: "desc" }, "createdAt")).toEqual({
      column: "createdAt",
      direction: "asc",
    });
  });

  it("switches column and applies its natural direction", () => {
    expect(nextSort({ column: "name", direction: "desc" }, "createdAt")).toEqual({
      column: "createdAt",
      direction: "desc",
    });
    expect(nextSort({ column: "createdAt", direction: "asc" }, "name")).toEqual({
      column: "name",
      direction: "asc",
    });
  });
});

describe("compareProjects", () => {
  const noCounts: Record<string, number> = {};

  it("name and repo sort alphabetically", () => {
    const a = project({ id: "a", name: "alpha", githubRepo: "o/alpha" });
    const b = project({ id: "b", name: "beta", githubRepo: "o/beta" });
    expect(compareProjects(a, b, "name", noCounts)).toBeLessThan(0);
    expect(compareProjects(a, b, "repo", noCounts)).toBeLessThan(0);
  });

  it("treats a missing taskCounts entry as 0", () => {
    const withCount = project({ id: "x" });
    const missing = project({ id: "y" });
    // x has 3 active tasks, y is absent from the map -> 0, so x > y.
    expect(compareProjects(withCount, missing, "activeTasks", { x: 3 })).toBeGreaterThan(0);
    expect(compareProjects(missing, missing, "activeTasks", {})).toBe(0);
  });

  it("orders a null githubRepo before a named one (manual projects cluster)", () => {
    const manual = project({ id: "m", githubRepo: null });
    const github = project({ id: "g", githubRepo: "o/repo" });
    expect(compareProjects(manual, github, "repo", noCounts)).toBeLessThan(0);
  });

  it("treats a null githubSyncAt as epoch 0 without throwing", () => {
    const synced = project({ id: "s", githubSyncAt: "2026-06-01T00:00:00.000Z" });
    const neverSynced = project({ id: "n", githubSyncAt: null });
    expect(compareProjects(synced, neverSynced, "syncedAt", noCounts)).toBeGreaterThan(0);
  });
});

describe("sortProjects", () => {
  const counts = { a: 1, b: 9 };
  const a = project({ id: "a", name: "alpha", createdAt: "2026-01-01T00:00:00.000Z" });
  const b = project({ id: "b", name: "beta", createdAt: "2026-03-01T00:00:00.000Z" });
  const rows = [b, a];

  it("does not mutate the input array", () => {
    const input = [b, a];
    sortProjects(input, "name", "asc", counts);
    expect(ids(input)).toEqual(["b", "a"]);
  });

  it("sorts ascending and descending by name", () => {
    expect(ids(sortProjects(rows, "name", "asc", counts))).toEqual(["a", "b"]);
    expect(ids(sortProjects(rows, "name", "desc", counts))).toEqual(["b", "a"]);
  });

  it("sorts by active task count using the counts map", () => {
    expect(ids(sortProjects(rows, "activeTasks", "desc", counts))).toEqual(["b", "a"]);
  });

  it("sorts newest-first by createdAt when descending", () => {
    expect(ids(sortProjects(rows, "createdAt", "desc", counts))).toEqual(["b", "a"]);
  });
});
