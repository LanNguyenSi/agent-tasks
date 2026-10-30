import type { WorkflowDefinitionShape } from "../../src/services/default-workflow.js";

/**
 * A workflow whose state names are not the built-in four: open -> plan ->
 * build -> qa -> shipped, with `qa` the review-like state (it leads to the
 * terminal `shipped` and is not a direct target of the initial state) and
 * `qa -> build` the request-changes edge. Used as the stub definition for the
 * helper-driven merge gate and webhook tests.
 */
export const CUSTOM_VOCABULARY_DEFINITION: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "plan", label: "Plan", terminal: false },
    { name: "build", label: "Build", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "open", to: "plan" },
    { from: "plan", to: "build" },
    { from: "build", to: "qa" },
    { from: "qa", to: "shipped" },
    { from: "qa", to: "build" },
  ],
};

/**
 * A four-state workflow with the built-in names and a free `open -> review`
 * edge. The helpers read `review` as a plain work state here (it is a direct
 * target of the initial state), so it is not review-like and the workflow has
 * no review-like state at all. Pins the documented behaviour change for that
 * graph shape.
 */
export const OPEN_TO_REVIEW_DEFINITION: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "in_progress", label: "In progress", terminal: false },
    { name: "review", label: "Review", terminal: false },
    { name: "done", label: "Done", terminal: true },
  ],
  transitions: [
    { from: "open", to: "in_progress" },
    { from: "open", to: "review" },
    { from: "in_progress", to: "review" },
    { from: "review", to: "in_progress" },
    { from: "review", to: "done" },
  ],
};

/**
 * Two work states, each with its own review-like state: `a -> r1` and
 * `b -> r2`, both review states leading to the terminal `shipped`. `r1` is
 * the workflow-wide first review-like state, so the old webhook pick
 * (`reviewStates(def)[0]`) answered `r1` for a task in `b`, a state with no
 * edge to it. `open` has an edge to neither review state (the fallback case).
 */
export const TWO_REVIEW_DEFINITION: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "a", label: "A", terminal: false },
    { name: "b", label: "B", terminal: false },
    { name: "r1", label: "R1", terminal: false },
    { name: "r2", label: "R2", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "open", to: "a" },
    { from: "open", to: "b" },
    { from: "a", to: "r1" },
    { from: "b", to: "r2" },
    { from: "r1", to: "shipped" },
    { from: "r2", to: "shipped" },
  ],
};
