/** @vitest-environment jsdom */
/**
 * loadMissingProjectWorkflows (home/projectWorkflows.ts) and the /tasks hook
 * on top of it (tasks/_components/useProjectWorkflows.ts): each project's
 * workflow list is read once; a 403 is remembered and not asked again, any
 * other failure is asked again on the next call; a team switch forgets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import type { TeamTasksProject, Workflow } from "../../src/lib/api";

vi.mock("../../src/lib/api", () => ({
  getWorkflows: vi.fn(),
}));

import { getWorkflows } from "../../src/lib/api";
import { loadMissingProjectWorkflows } from "../../src/app/home/projectWorkflows";
import { useProjectWorkflows } from "../../src/app/tasks/_components/useProjectWorkflows";

const mockGetWorkflows = vi.mocked(getWorkflows);

const WF = (projectId: string): Workflow =>
  ({
    id: `wf-${projectId}`,
    projectId,
    name: "wf",
    isDefault: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    definition: { states: [{ name: "open", label: "Open", terminal: false }], transitions: [], initialState: "open" },
  }) as Workflow;

const forbidden = () => Object.assign(new Error("Forbidden"), { status: 403 });
const calls = (id: string) => mockGetWorkflows.mock.calls.filter((c) => c[0] === id).length;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("loadMissingProjectWorkflows", () => {
  it("reads each project once and reports a gain", async () => {
    mockGetWorkflows.mockImplementation(async (id) => [WF(id)]);
    const cache = new Map<string, Workflow[]>();
    expect(await loadMissingProjectWorkflows(["a", "b"], cache)).toBe(true);
    expect([...cache.keys()]).toEqual(["a", "b"]);
    expect(await loadMissingProjectWorkflows(["a", "b"], cache)).toBe(false);
    expect(mockGetWorkflows).toHaveBeenCalledTimes(2);
  });

  it("does not ask a 403 project again when given the remembered set", async () => {
    mockGetWorkflows.mockRejectedValue(forbidden());
    const cache = new Map<string, Workflow[]>();
    const memo = new Set<string>();
    expect(await loadMissingProjectWorkflows(["a"], cache, memo)).toBe(false);
    expect(await loadMissingProjectWorkflows(["a"], cache, memo)).toBe(false);
    expect(calls("a")).toBe(1);
    expect([...memo]).toEqual(["a"]);
  });

  it("asks a project again after a 5xx, a network error, or any failure without a 403", async () => {
    const cache = new Map<string, Workflow[]>();
    const memo = new Set<string>();
    mockGetWorkflows.mockRejectedValueOnce(Object.assign(new Error("Bad gateway"), { status: 502 }));
    await loadMissingProjectWorkflows(["a"], cache, memo);
    mockGetWorkflows.mockRejectedValueOnce(new Error("network down"));
    await loadMissingProjectWorkflows(["a"], cache, memo);
    mockGetWorkflows.mockResolvedValueOnce([WF("a")]);
    expect(await loadMissingProjectWorkflows(["a"], cache, memo)).toBe(true);
    expect(calls("a")).toBe(3);
    expect(memo.size).toBe(0);
  });

  it("asks a 403 project again when no remembered set is given (the old behaviour)", async () => {
    mockGetWorkflows.mockRejectedValue(forbidden());
    const cache = new Map<string, Workflow[]>();
    await loadMissingProjectWorkflows(["a"], cache);
    await loadMissingProjectWorkflows(["a"], cache);
    expect(calls("a")).toBe(2);
  });

  it("still reads the other projects of the call when one answers 403", async () => {
    mockGetWorkflows.mockImplementation(async (id) => {
      if (id === "a") throw forbidden();
      return [WF(id)];
    });
    const cache = new Map<string, Workflow[]>();
    expect(await loadMissingProjectWorkflows(["a", "b"], cache, new Set())).toBe(true);
    expect([...cache.keys()]).toEqual(["b"]);
  });
});

describe("useProjectWorkflows", () => {
  const P = (...ids: string[]): TeamTasksProject[] =>
    ids.map((id) => ({ id, name: id, slug: id, accessSource: "team" }) as TeamTasksProject);

  it("loads the workflows of the projects", async () => {
    mockGetWorkflows.mockImplementation(async (id) => [WF(id)]);
    const { result } = renderHook(() => useProjectWorkflows("t1", P("a", "b")));
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get("a")![0]!.id).toBe("wf-a");
  });

  it("asks a 403 project once across list refreshes, which hand over a new array each time", async () => {
    mockGetWorkflows.mockImplementation(async (id) => {
      if (id === "a") throw forbidden();
      return [WF(id)];
    });
    const { result, rerender } = renderHook(({ projects }) => useProjectWorkflows("t1", projects), {
      initialProps: { projects: P("a", "b") },
    });
    await waitFor(() => expect(result.current.size).toBe(1));
    rerender({ projects: P("a", "b") });
    rerender({ projects: P("a", "b") });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls("a")).toBe(1);
    expect(calls("b")).toBe(1);
  });

  it("asks a project that failed with a 502 again on the next refresh", async () => {
    mockGetWorkflows.mockImplementation(async (id) => {
      if (id === "a") throw Object.assign(new Error("Bad gateway"), { status: 502 });
      return [WF(id)];
    });
    const { rerender } = renderHook(({ projects }) => useProjectWorkflows("t1", projects), {
      initialProps: { projects: P("a") },
    });
    await waitFor(() => expect(calls("a")).toBe(1));
    rerender({ projects: P("a") });
    await waitFor(() => expect(calls("a")).toBe(2));
  });

  it("does not ask for a project whose request is still on the way", async () => {
    let release!: (w: Workflow[]) => void;
    mockGetWorkflows.mockImplementation(() => new Promise<Workflow[]>((res) => { release = res; }));
    const { result, rerender } = renderHook(({ projects }) => useProjectWorkflows("t1", projects), {
      initialProps: { projects: P("a") },
    });
    await waitFor(() => expect(calls("a")).toBe(1));
    rerender({ projects: P("a") });
    expect(calls("a")).toBe(1);
    release([WF("a")]);
    await waitFor(() => expect(result.current.size).toBe(1));
  });

  it("forgets what it learned when the team changes", async () => {
    mockGetWorkflows.mockRejectedValue(forbidden());
    const { result, rerender } = renderHook(({ team }) => useProjectWorkflows(team, P("a")), {
      initialProps: { team: "t1" },
    });
    await waitFor(() => expect(calls("a")).toBe(1));
    mockGetWorkflows.mockResolvedValue([WF("a")]);
    rerender({ team: "t2" });
    await waitFor(() => expect(calls("a")).toBe(2));
    await waitFor(() => expect(result.current.size).toBe(1));
  });

  it("drops the workflows of the team that was left", async () => {
    mockGetWorkflows.mockImplementation(async (id) => [WF(id)]);
    const { result, rerender } = renderHook(
      ({ team, projects }) => useProjectWorkflows(team, projects),
      { initialProps: { team: "t1" as string | null, projects: P("a") } },
    );
    await waitFor(() => expect(result.current.size).toBe(1));
    rerender({ team: "t2", projects: [] });
    await waitFor(() => expect(result.current.size).toBe(0));
  });

  it("asks nothing without a team", async () => {
    const { result } = renderHook(() => useProjectWorkflows(null, P("a")));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockGetWorkflows).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });
});
