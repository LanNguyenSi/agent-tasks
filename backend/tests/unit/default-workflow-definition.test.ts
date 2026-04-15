import { describe, expect, it } from "vitest";
import {
  DEFAULT_INITIAL_STATE,
  DEFAULT_STATES,
  defaultWorkflowDefinition,
} from "../../src/services/default-workflow.js";

describe("defaultWorkflowDefinition()", () => {
  const def = defaultWorkflowDefinition();

  it("exports every DEFAULT_STATES entry with its instructions", () => {
    expect(def.states).toHaveLength(DEFAULT_STATES.length);
    for (const s of DEFAULT_STATES) {
      expect(def.states).toContainEqual({
        name: s.name,
        label: s.label,
        terminal: s.terminal,
        agentInstructions: s.agentInstructions,
      });
    }
  });

  it("every default state has non-empty agentInstructions", () => {
    for (const s of def.states) {
      expect(s.agentInstructions).toBeTruthy();
      expect(s.agentInstructions!.length).toBeGreaterThan(10);
    }
  });

  it("has the same initial state as the constant", () => {
    expect(def.initialState).toBe(DEFAULT_INITIAL_STATE);
  });

  it("flattens DEFAULT_TRANSITIONS into the transitions array", () => {
    // open → in_progress, in_progress → {review, done, open}, review → {done, in_progress}
    expect(def.transitions).toHaveLength(6);
  });

  it("sets requiredRole='any' on every transition", () => {
    for (const t of def.transitions) {
      expect(t.requiredRole).toBe("any");
    }
  });

  it("open→in_progress has no gate in the serialized definition (relaxed from branchPresent)", () => {
    // See default-workflow.test.ts for the rationale: keeping the gate
    // on this edge self-checkmated task_start. It lives on the later
    // edges (in_progress → review / → done) where it is actually
    // load-bearing.
    const t = def.transitions.find((x) => x.from === "open" && x.to === "in_progress");
    expect(t?.requires).toBeUndefined();
  });

  it("preserves the branchPresent+prPresent gate on in_progress→review", () => {
    const t = def.transitions.find((x) => x.from === "in_progress" && x.to === "review");
    expect(t?.requires).toEqual(expect.arrayContaining(["branchPresent", "prPresent"]));
  });

  it("omits the requires field on ungated transitions (release, approve, request changes)", () => {
    const release = def.transitions.find((x) => x.from === "in_progress" && x.to === "open");
    const approve = def.transitions.find((x) => x.from === "review" && x.to === "done");
    const requestChanges = def.transitions.find((x) => x.from === "review" && x.to === "in_progress");
    expect(release?.requires).toBeUndefined();
    expect(approve?.requires).toBeUndefined();
    expect(requestChanges?.requires).toBeUndefined();
  });

  it("marks the done state as terminal and no others", () => {
    const terminal = def.states.filter((s) => s.terminal);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.name).toBe("done");
  });

  it("returns a fresh object each call (no shared reference)", () => {
    const a = defaultWorkflowDefinition();
    const b = defaultWorkflowDefinition();
    expect(a).not.toBe(b);
    expect(a.states).not.toBe(b.states);
    expect(a.transitions).not.toBe(b.transitions);
  });
});
