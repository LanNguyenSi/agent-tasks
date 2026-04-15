/**
 * Unit test for the `workflow.customized` audit shape snapshot.
 *
 * Keeps the forensic payload contract stable: a future change to
 * DEFAULT_STATES must not silently weaken what auditors can see in
 * old `workflow.customized` rows.
 */
import { describe, expect, it } from "vitest";
import { buildForkedFromDefaultSnapshot } from "../../src/routes/workflows.js";
import { defaultWorkflowDefinition } from "../../src/services/default-workflow.js";

describe("buildForkedFromDefaultSnapshot", () => {
  it("captures state count, transition count, state names (ordered) and initial state", () => {
    const def = defaultWorkflowDefinition();
    const snapshot = buildForkedFromDefaultSnapshot(def);

    expect(snapshot.stateCount).toBe(def.states.length);
    expect(snapshot.transitionCount).toBe(def.transitions.length);
    expect(snapshot.stateNames).toEqual(def.states.map((s) => s.name));
    expect(snapshot.initialState).toBe(def.initialState);
  });

  it("preserves state order (snapshot must be positional, not set-like)", () => {
    const snapshot = buildForkedFromDefaultSnapshot({
      states: [
        { name: "alpha", label: "Alpha", terminal: false },
        { name: "beta", label: "Beta", terminal: false },
        { name: "gamma", label: "Gamma", terminal: true },
      ],
      transitions: [
        { from: "alpha", to: "beta" },
        { from: "beta", to: "gamma" },
      ],
      initialState: "alpha",
    });

    expect(snapshot.stateNames).toEqual(["alpha", "beta", "gamma"]);
    expect(snapshot.stateCount).toBe(3);
    expect(snapshot.transitionCount).toBe(2);
    expect(snapshot.initialState).toBe("alpha");
  });

  it("returns a fresh stateNames array (not a reference into the input)", () => {
    const def = defaultWorkflowDefinition();
    const snapshot = buildForkedFromDefaultSnapshot(def);
    // Mutating the snapshot must not affect the source definition.
    snapshot.stateNames.push("mutated");
    expect(def.states.map((s) => s.name)).not.toContain("mutated");
  });
});
