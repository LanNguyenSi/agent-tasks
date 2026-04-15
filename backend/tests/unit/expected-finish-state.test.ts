import { describe, it, expect } from "vitest";
import {
  expectedFinishStateFromDefinition,
  defaultWorkflowDefinition,
  type WorkflowDefinitionShape,
} from "../../src/services/default-workflow.js";

describe("expectedFinishStateFromDefinition", () => {
  it("prefers review over done when both transitions exist from in_progress", () => {
    const def: WorkflowDefinitionShape = {
      initialState: "open",
      states: [],
      transitions: [
        { from: "in_progress", to: "review" },
        { from: "in_progress", to: "done" },
      ],
    };
    expect(expectedFinishStateFromDefinition(def)).toBe("review");
  });

  it("returns done when the workflow only has in_progress → done", () => {
    const def: WorkflowDefinitionShape = {
      initialState: "open",
      states: [],
      transitions: [{ from: "in_progress", to: "done" }],
    };
    expect(expectedFinishStateFromDefinition(def)).toBe("done");
  });

  it("falls back to done when workflow has no in_progress transitions at all", () => {
    const def: WorkflowDefinitionShape = {
      initialState: "open",
      states: [],
      transitions: [{ from: "open", to: "in_progress" }],
    };
    expect(expectedFinishStateFromDefinition(def)).toBe("done");
  });

  it("uses the built-in default when definition is null (shipped default has review)", () => {
    expect(expectedFinishStateFromDefinition(null)).toBe("review");
  });

  it("is stable against the shipped default workflow shape", () => {
    expect(expectedFinishStateFromDefinition(defaultWorkflowDefinition())).toBe("review");
  });
});
