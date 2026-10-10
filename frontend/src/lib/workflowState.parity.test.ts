import { describe, expect, it } from "vitest";
import {
  defaultWorkflowDefinition,
  isReviewState as backendIsReviewState,
} from "../../../backend/src/services/default-workflow";
import type { WorkflowDefinition } from "./api";
import { isReviewState as frontendIsReviewState } from "./workflowState";

/**
 * Cross-package parity guard: frontend/src/lib/workflowState.ts is a
 * hand-maintained mirror of the backend `isReviewState` that the release
 * route uses to answer 409 bad_state. Both run side by side over a table of
 * workflows times every state name (plus one unknown name), so a one-sided
 * edit fails here instead of drifting silently.
 */
function wf(
  initialState: string,
  states: Array<[string, boolean]>,
  transitions: Array<[string, string]>,
): WorkflowDefinition {
  return {
    initialState,
    states: states.map(([name, terminal]) => ({ name, label: name, terminal })),
    transitions: transitions.map(([from, to]) => ({ from, to })),
  };
}

const WORKFLOWS: Array<[string, WorkflowDefinition]> = [
  ["built-in default", defaultWorkflowDefinition() as unknown as WorkflowDefinition],
  [
    "custom workflow with a review-like qa state",
    wf(
      "todo",
      [["todo", false], ["doing", false], ["qa", false], ["shipped", true]],
      [["todo", "doing"], ["doing", "qa"], ["qa", "shipped"]],
    ),
  ],
  [
    "state named review that is a direct target of the initial state",
    wf(
      "todo",
      [["todo", false], ["doing", false], ["qa", false], ["review", false], ["shipped", true]],
      [["todo", "doing"], ["todo", "review"], ["doing", "qa"], ["qa", "shipped"], ["review", "shipped"]],
    ),
  ],
  [
    "initial state with a transition to a terminal state",
    wf(
      "todo",
      [["todo", false], ["doing", false], ["review", false], ["shipped", true]],
      [["todo", "doing"], ["todo", "shipped"], ["doing", "review"], ["review", "shipped"]],
    ),
  ],
  [
    "work state with no path to a terminal state",
    wf(
      "todo",
      [["todo", false], ["doing", false], ["parked", false], ["shipped", true]],
      [["todo", "doing"], ["doing", "parked"], ["doing", "shipped"]],
    ),
  ],
];

describe("isReviewState parity (backend vs frontend)", () => {
  for (const [label, def] of WORKFLOWS) {
    it(`agrees on every state of: ${label}`, () => {
      for (const name of [...def.states.map((s) => s.name), "no-such-state"]) {
        expect(frontendIsReviewState(def, name), name).toBe(
          backendIsReviewState(def as never, name),
        );
      }
    });
  }

  it("the table exercises both outcomes", () => {
    const outcomes = new Set<boolean>();
    for (const [, def] of WORKFLOWS) {
      for (const s of def.states) outcomes.add(backendIsReviewState(def as never, s.name));
    }
    expect(outcomes).toEqual(new Set([true, false]));
  });

  it("initial state with a terminal edge is not review-like (pinned)", () => {
    const def = WORKFLOWS[3][1];
    expect(backendIsReviewState(def as never, "todo")).toBe(false);
    expect(frontendIsReviewState(def, "todo")).toBe(false);
    expect(frontendIsReviewState(def, "review")).toBe(true);
  });
});
