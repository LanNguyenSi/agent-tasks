import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRANSITIONS,
  findDefaultTransition,
  resolveEffectiveDefinition,
} from "../../src/services/default-workflow.js";

describe("default workflow", () => {
  it("covers all four built-in states", () => {
    expect(Object.keys(DEFAULT_TRANSITIONS).sort()).toEqual([
      "done",
      "in_progress",
      "open",
      "review",
    ]);
  });

  it("done is terminal (no outgoing transitions)", () => {
    expect(DEFAULT_TRANSITIONS.done).toEqual([]);
  });

  it("open → in_progress has no gate (branchPresent lives on the later edges)", () => {
    // Historically this edge required `branchPresent`, but that self-
    // checkmated `task_start` once v2 started enforcing gates: the only
    // v2-native path to write `branchName` is `task_submit_pr`, which
    // requires the task to already be `in_progress`. The gate was
    // relaxed on this edge and kept on `in_progress → review` / `→ done`
    // where it is load-bearing. See the fix/v2-task-start-gate-enforcement
    // ticket for the full rationale.
    const t = findDefaultTransition("open", "in_progress");
    expect(t).toBeDefined();
    expect(t?.requires).toBeUndefined();
  });

  it("in_progress → review requires branch AND PR", () => {
    const t = findDefaultTransition("in_progress", "review");
    expect(t).toBeDefined();
    expect(t?.requires).toEqual(expect.arrayContaining(["branchPresent", "prPresent"]));
  });

  it("in_progress → done (direct) also requires branch AND PR", () => {
    const t = findDefaultTransition("in_progress", "done");
    expect(t?.requires).toEqual(expect.arrayContaining(["branchPresent", "prPresent"]));
  });

  it("in_progress → open (release) has no gate", () => {
    const t = findDefaultTransition("in_progress", "open");
    expect(t).toBeDefined();
    expect(t?.requires).toBeUndefined();
  });

  it("review → done (approve) has no gate", () => {
    const t = findDefaultTransition("review", "done");
    expect(t).toBeDefined();
    expect(t?.requires).toBeUndefined();
  });

  it("review → in_progress (request changes) has no gate", () => {
    const t = findDefaultTransition("review", "in_progress");
    expect(t).toBeDefined();
    expect(t?.requires).toBeUndefined();
  });

  it("returns undefined for unknown transitions", () => {
    expect(findDefaultTransition("open", "review")).toBeUndefined();
    expect(findDefaultTransition("done", "open")).toBeUndefined();
    expect(findDefaultTransition("bogus", "open")).toBeUndefined();
  });
});

describe("resolveEffectiveDefinition: which workflow a task resolves to", () => {
  const def = (initialState: string) => ({
    initialState,
    states: [
      { name: initialState, label: initialState, terminal: false },
      { name: "end", label: "End", terminal: true },
    ],
    transitions: [{ from: initialState, to: "end" }],
  });
  const PINNED = def("pinned-start");
  const PROJECT_DEFAULT = def("project-start");

  function makePrisma(opts: { pinnedRow: { definition: unknown } | null }) {
    return {
      workflow: {
        findUnique: vi.fn().mockResolvedValue(opts.pinnedRow),
        findFirst: vi.fn().mockResolvedValue({ definition: PROJECT_DEFAULT }),
      },
    };
  }
  const base = { projectId: "p1" };

  it("pinned, relation not loaded: loads the pinned row by id", async () => {
    const prisma = makePrisma({ pinnedRow: { definition: PINNED } });
    const out = await resolveEffectiveDefinition({ ...base, workflowId: "w1" }, prisma);
    expect(out.initialState).toBe("pinned-start");
    expect(prisma.workflow.findUnique).toHaveBeenCalledWith({ where: { id: "w1" } });
    expect(prisma.workflow.findFirst).not.toHaveBeenCalled();
  });

  it("pinned, relation loaded: uses it without another query", async () => {
    const prisma = makePrisma({ pinnedRow: null });
    const out = await resolveEffectiveDefinition(
      { ...base, workflowId: "w1", workflow: { definition: PINNED } },
      prisma,
    );
    expect(out.initialState).toBe("pinned-start");
    expect(prisma.workflow.findUnique).not.toHaveBeenCalled();
    expect(prisma.workflow.findFirst).not.toHaveBeenCalled();
  });

  it("pinned, relation loaded but the row is gone (null): falls to the project default", async () => {
    const prisma = makePrisma({ pinnedRow: { definition: PINNED } });
    const out = await resolveEffectiveDefinition({ ...base, workflowId: "w1", workflow: null }, prisma);
    expect(out.initialState).toBe("project-start");
    expect(prisma.workflow.findUnique).not.toHaveBeenCalled();
  });

  it("pinned, relation not loaded and the row is deleted: falls to the project default", async () => {
    const prisma = makePrisma({ pinnedRow: null });
    const out = await resolveEffectiveDefinition({ ...base, workflowId: "w1" }, prisma);
    expect(out.initialState).toBe("project-start");
  });

  it("unpinned: project default, no pinned lookup", async () => {
    const prisma = makePrisma({ pinnedRow: { definition: PINNED } });
    const out = await resolveEffectiveDefinition({ ...base, workflowId: null }, prisma);
    expect(out.initialState).toBe("project-start");
    expect(prisma.workflow.findUnique).not.toHaveBeenCalled();
  });

  it("unpinned and no project default: the built-in definition", async () => {
    const prisma = makePrisma({ pinnedRow: null });
    prisma.workflow.findFirst.mockResolvedValue(null as never);
    const out = await resolveEffectiveDefinition({ ...base, workflowId: null }, prisma);
    expect(out.initialState).toBe("open");
  });
});
