import { describe, it, expect } from "vitest";
import {
  WORKFLOW_TEMPLATES,
  findWorkflowTemplate,
} from "../../src/services/workflow-templates.js";
import { workflowDefinitionSchema } from "../../src/routes/workflows.js";

describe("workflow-templates", () => {
  it("exports at least one template", () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(1);
  });

  it("findWorkflowTemplate returns the coding-agent template", () => {
    const tpl = findWorkflowTemplate("coding-agent");
    expect(tpl).toBeDefined();
    expect(tpl!.slug).toBe("coding-agent");
    expect(tpl!.name).toBe("AI Coding Agent Pipeline");
  });

  it("findWorkflowTemplate returns undefined for unknown slug", () => {
    expect(findWorkflowTemplate("nonexistent")).toBeUndefined();
  });

  describe("coding-agent template", () => {
    const tpl = findWorkflowTemplate("coding-agent")!;

    it("has 7 states", () => {
      expect(tpl.definition.states).toHaveLength(7);
    });

    it("starts at backlog", () => {
      expect(tpl.definition.initialState).toBe("backlog");
    });

    it("has exactly one terminal state (done)", () => {
      const terminal = tpl.definition.states.filter((s) => s.terminal);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]!.name).toBe("done");
    });

    it("has the expected stage order", () => {
      const names = tpl.definition.states.map((s) => s.name);
      expect(names).toEqual([
        "backlog", "spec", "plan", "implement", "test", "review", "done",
      ]);
    });

    it("every state has agentInstructions", () => {
      for (const state of tpl.definition.states) {
        expect(state.agentInstructions).toBeTruthy();
      }
    });

    it("passes the backend workflow definition schema validation", () => {
      const result = workflowDefinitionSchema.safeParse(tpl.definition);
      expect(result.success).toBe(true);
    });

    it("plan → implement requires branchPresent", () => {
      const t = tpl.definition.transitions.find(
        (t) => t.from === "plan" && t.to === "implement",
      );
      expect(t).toBeDefined();
      expect(t!.requires).toContain("branchPresent");
    });

    it("test → review requires branchPresent and prPresent", () => {
      const t = tpl.definition.transitions.find(
        (t) => t.from === "test" && t.to === "review",
      );
      expect(t).toBeDefined();
      expect(t!.requires).toContain("branchPresent");
      expect(t!.requires).toContain("prPresent");
    });

    it("has back-transitions for iterative development", () => {
      const backTransitions = tpl.definition.transitions.filter(
        (t) =>
          (t.from === "review" && t.to === "implement") ||
          (t.from === "test" && t.to === "implement") ||
          (t.from === "implement" && t.to === "plan") ||
          (t.from === "plan" && t.to === "spec") ||
          (t.from === "spec" && t.to === "backlog"),
      );
      expect(backTransitions.length).toBe(5);
    });
  });
});
