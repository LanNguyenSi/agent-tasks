/**
 * Backend zod validation for Workflow.definition structural integrity.
 *
 * The frontend editor performs the same checks, but clients cannot be
 * trusted — these tests lock the server-side defense in place so a
 * future schema edit can't accidentally downgrade to the pre-#109
 * "accept anything" behavior that allowed corrupted workflow graphs.
 */
import { describe, expect, it } from "vitest";
import { workflowDefinitionSchema } from "../../src/routes/workflows.js";

function validDef() {
  return {
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "in_progress", label: "In progress", terminal: false },
      { name: "done", label: "Done", terminal: true },
    ],
    transitions: [
      { from: "open", to: "in_progress" },
      { from: "in_progress", to: "done" },
    ],
    initialState: "open",
  };
}

describe("workflowDefinitionSchema", () => {
  it("accepts a well-formed definition", () => {
    const result = workflowDefinitionSchema.safeParse(validDef());
    expect(result.success).toBe(true);
  });

  it("rejects state names with uppercase letters", () => {
    const d = validDef();
    d.states[0]!.name = "Open";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
  });

  it("rejects state names with spaces", () => {
    const d = validDef();
    d.states[0]!.name = "in progress";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
  });

  it("rejects state names with dashes", () => {
    const d = validDef();
    d.states[0]!.name = "in-progress";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
  });

  it("rejects state names with shell metacharacters", () => {
    const d = validDef();
    d.states[0]!.name = "open; DROP TABLE";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate state names", () => {
    const d = validDef();
    d.states.push({ name: "open", label: "Open 2", terminal: false });
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /duplicate/i.test(i.message))).toBe(true);
    }
  });

  it("rejects initialState not in the states list", () => {
    const d = validDef();
    d.initialState = "ghost";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /initialState/i.test(i.message))).toBe(true);
    }
  });

  it("rejects a transition with a missing 'from' state", () => {
    const d = validDef();
    d.transitions.push({ from: "ghost", to: "done" });
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /missing "from"/i.test(i.message))).toBe(true);
    }
  });

  it("rejects a transition with a missing 'to' state", () => {
    const d = validDef();
    d.transitions.push({ from: "open", to: "phantom" });
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /missing "to"/i.test(i.message))).toBe(true);
    }
  });

  it("accepts a minimal single-state terminal workflow", () => {
    const result = workflowDefinitionSchema.safeParse({
      states: [{ name: "done", label: "Done", terminal: true }],
      transitions: [],
      initialState: "done",
    });
    expect(result.success).toBe(true);
  });

  it("requires at least one state", () => {
    const result = workflowDefinitionSchema.safeParse({
      states: [],
      transitions: [],
      initialState: "open",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty state name", () => {
    const d = validDef();
    d.states[0]!.name = "";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
  });

  it("accepts transitions with requires arrays (gates)", () => {
    const d = validDef();
    d.transitions[0] = { from: "open", to: "in_progress", requires: ["branchPresent"] } as any;
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(true);
  });
});
