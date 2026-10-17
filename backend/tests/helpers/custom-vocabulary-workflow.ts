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
