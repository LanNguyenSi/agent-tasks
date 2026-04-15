import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSITIONS,
  findDefaultTransition,
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
