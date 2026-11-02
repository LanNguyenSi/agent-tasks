/**
 * The pure helpers behind `task_advance` (services/default-workflow.ts): the
 * state-order definition of "forward", the advance targets of a state, the
 * finish target a preview may name, and the resolution of an optional `to`.
 * One case per input combination of resolveAdvanceTarget: `to` given (an
 * advance target, a review-like or terminal state, anything else) or absent
 * (one, several or no advance target; without one, a forward edge into a
 * finish-only state, a possible finish, or neither).
 */
import { describe, expect, it } from "vitest";
import {
  advanceTargetsFrom,
  defaultWorkflowDefinition,
  isFinishOnlyState,
  isForwardMove,
  reachableFinishTarget,
  resolveAdvanceTarget,
  stateOrderIndex,
  type WorkflowDefinitionShape,
} from "../../src/services/default-workflow.js";

const state = (name: string, terminal = false) => ({ name, label: name, terminal });

const PIPELINE: WorkflowDefinitionShape = {
  initialState: "open",
  states: [state("open"), state("spec"), state("plan"), state("build"), state("review"), state("done", true)],
  transitions: [
    { from: "open", to: "spec" },
    { from: "spec", to: "plan" },
    { from: "spec", to: "open" },
    { from: "plan", to: "build" },
    { from: "plan", to: "spec" },
    { from: "build", to: "review" },
    { from: "review", to: "done" },
    { from: "review", to: "build" },
  ],
};

const FORK: WorkflowDefinitionShape = {
  initialState: "open",
  states: [state("open"), state("spec"), state("lint"), state("docs"), state("review"), state("done", true)],
  transitions: [
    { from: "open", to: "spec" },
    { from: "spec", to: "lint" },
    { from: "spec", to: "docs" },
    { from: "spec", to: "lint" },
    { from: "lint", to: "review" },
    { from: "docs", to: "review" },
    { from: "review", to: "done" },
  ],
};

const STUCK: WorkflowDefinitionShape = {
  initialState: "open",
  states: [state("open"), state("a"), state("b"), state("done", true)],
  transitions: [
    { from: "open", to: "b" },
    { from: "b", to: "open" },
    { from: "a", to: "done" },
  ],
};

const REVIEW_FIRST: WorkflowDefinitionShape = {
  initialState: "open",
  states: [state("open"), state("review"), state("in_progress"), state("done", true)],
  transitions: [
    { from: "open", to: "in_progress" },
    { from: "in_progress", to: "review" },
    { from: "review", to: "done" },
  ],
};

describe("state order and forward moves", () => {
  it("indexes states by their position in the definition, -1 for an unknown name", () => {
    expect(stateOrderIndex(PIPELINE, "open")).toBe(0);
    expect(stateOrderIndex(PIPELINE, "build")).toBe(3);
    expect(stateOrderIndex(PIPELINE, "nope")).toBe(-1);
  });

  it("a move is forward only when the target is listed later and both are states", () => {
    expect(isForwardMove(PIPELINE, "spec", "plan")).toBe(true);
    expect(isForwardMove(PIPELINE, "spec", "build")).toBe(true); // forward by order, whether or not an edge exists
    expect(isForwardMove(PIPELINE, "plan", "spec")).toBe(false);
    expect(isForwardMove(PIPELINE, "spec", "spec")).toBe(false);
    expect(isForwardMove(PIPELINE, "spec", "nope")).toBe(false);
    expect(isForwardMove(PIPELINE, "nope", "plan")).toBe(false);
  });

  it("review-like and terminal states are finish-only, work stages are not", () => {
    expect(isFinishOnlyState(PIPELINE, "review")).toBe(true);
    expect(isFinishOnlyState(PIPELINE, "done")).toBe(true);
    expect(isFinishOnlyState(PIPELINE, "plan")).toBe(false);
  });
});

describe("advanceTargetsFrom", () => {
  it("lists forward edges to work stages in edge order, without duplicates", () => {
    expect(advanceTargetsFrom(PIPELINE, "spec")).toEqual(["plan"]);
    expect(advanceTargetsFrom(FORK, "spec")).toEqual(["lint", "docs"]);
  });

  it("leaves out backward edges and edges into review or terminal states", () => {
    expect(advanceTargetsFrom(PIPELINE, "build")).toEqual([]);
    expect(advanceTargetsFrom(PIPELINE, "review")).toEqual([]);
    expect(advanceTargetsFrom(STUCK, "b")).toEqual([]);
  });

  it("is empty for every state past the initial one on the built-in four-state workflow", () => {
    // open -> in_progress is a forward edge, but the advance route never moves
    // an initial-state task (task_start does); every later state has nothing.
    const def = defaultWorkflowDefinition();
    expect(advanceTargetsFrom(def, "open")).toEqual(["in_progress"]);
    for (const s of def.states.filter((x) => x.name !== def.initialState)) {
      expect(advanceTargetsFrom(def, s.name), s.name).toEqual([]);
    }
  });
});

describe("reachableFinishTarget", () => {
  it("names the finish target when the edge exists, null when the finish would be refused", () => {
    expect(reachableFinishTarget(PIPELINE, "build")).toBe("review");
    expect(reachableFinishTarget(PIPELINE, "spec")).toBeNull();
    expect(reachableFinishTarget(REVIEW_FIRST, "in_progress")).toBe("review");
    expect(reachableFinishTarget(STUCK, "b")).toBeNull();
    expect(reachableFinishTarget(defaultWorkflowDefinition(), "in_progress")).toBe("review");
  });
});

describe("resolveAdvanceTarget: `to` given", () => {
  it("an advance target: taken (the requested edge wins over the others)", () => {
    expect(resolveAdvanceTarget(FORK, "spec", "docs")).toEqual({ ok: true, to: "docs", choices: ["lint", "docs"] });
    expect(resolveAdvanceTarget(PIPELINE, "spec", "plan")).toEqual({ ok: true, to: "plan", choices: ["plan"] });
  });

  it("a review-like state: finish_state, even with an edge into it", () => {
    expect(resolveAdvanceTarget(PIPELINE, "build", "review")).toEqual({
      ok: false, reason: "finish_state", requested: "review", finishTarget: "review", choices: [],
    });
  });

  it("a terminal state without an edge: finish_state, with the finish target of the current state", () => {
    expect(resolveAdvanceTarget(PIPELINE, "spec", "done")).toEqual({
      ok: false, reason: "finish_state", requested: "done", finishTarget: null, choices: ["plan"],
    });
  });

  it.each(["open", "build", "spec", "nope"])("anything else (%s): not_forward with the real choices", (to) => {
    expect(resolveAdvanceTarget(PIPELINE, "spec", to)).toEqual({ ok: false, reason: "not_forward", requested: to, choices: ["plan"] });
  });
});

describe("resolveAdvanceTarget: `to` absent", () => {
  it("one advance target: taken", () => {
    expect(resolveAdvanceTarget(PIPELINE, "plan")).toEqual({ ok: true, to: "build", choices: ["build"] });
  });

  it("several advance targets: ambiguous", () => {
    expect(resolveAdvanceTarget(FORK, "spec")).toEqual({ ok: false, reason: "ambiguous", choices: ["lint", "docs"] });
  });

  it("none, with a forward edge into a review state: finish_state naming the finish target", () => {
    expect(resolveAdvanceTarget(PIPELINE, "build")).toEqual({
      ok: false, reason: "finish_state", requested: null, finishTarget: "review", choices: [],
    });
    expect(resolveAdvanceTarget(defaultWorkflowDefinition(), "in_progress")).toMatchObject({
      ok: false, reason: "finish_state", finishTarget: "review",
    });
  });

  it("none, no forward edge, but a finish is possible (review listed earlier): finish_state", () => {
    expect(resolveAdvanceTarget(REVIEW_FIRST, "in_progress")).toEqual({
      ok: false, reason: "finish_state", requested: null, finishTarget: "review", choices: [],
    });
  });

  it("none, and no finish either: no_forward_edge", () => {
    expect(resolveAdvanceTarget(STUCK, "b")).toEqual({ ok: false, reason: "no_forward_edge", choices: [] });
  });
});
