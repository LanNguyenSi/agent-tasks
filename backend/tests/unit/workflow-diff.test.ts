import { describe, expect, it } from "vitest";
import { summarizeWorkflowDiff } from "../../src/services/workflow-diff.js";
import type { WorkflowDefinitionShape } from "../../src/services/default-workflow.js";

function def(overrides: Partial<WorkflowDefinitionShape> = {}): WorkflowDefinitionShape {
  return {
    initialState: "open",
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "in_progress", label: "In progress", terminal: false },
      { name: "done", label: "Done", terminal: true },
    ],
    transitions: [
      { from: "open", to: "in_progress" },
      { from: "in_progress", to: "done" },
    ],
    ...overrides,
  };
}

describe("summarizeWorkflowDiff", () => {
  it("reports no changes when definitions are identical", () => {
    const diff = summarizeWorkflowDiff(def(), def());
    expect(diff.stateCountBefore).toBe(3);
    expect(diff.stateCountAfter).toBe(3);
    expect(diff.transitionCountBefore).toBe(2);
    expect(diff.transitionCountAfter).toBe(2);
    expect(diff.addedStateNames).toEqual([]);
    expect(diff.removedStateNames).toEqual([]);
    expect(diff.initialStateChanged).toBe(false);
  });

  it("reports a state rename as remove + add", () => {
    // We intentionally do NOT try to correlate renames — the backend
    // can't distinguish a rename from a remove+add without richer
    // metadata. Report honestly; a human reading the audit log can
    // interpret the pair.
    const after = def({
      states: [
        { name: "backlog", label: "Backlog", terminal: false },
        { name: "in_progress", label: "In progress", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
    });
    const diff = summarizeWorkflowDiff(def(), after);
    expect(diff.removedStateNames).toEqual(["open"]);
    expect(diff.addedStateNames).toEqual(["backlog"]);
  });

  it("reports multiple renames", () => {
    const after = def({
      states: [
        { name: "new_open", label: "Open", terminal: false },
        { name: "new_ip", label: "In progress", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
    });
    const diff = summarizeWorkflowDiff(def(), after);
    expect(diff.removedStateNames.sort()).toEqual(["in_progress", "open"]);
    expect(diff.addedStateNames.sort()).toEqual(["new_ip", "new_open"]);
  });

  it("reports a state added at the end", () => {
    const after = def({
      states: [
        ...def().states,
        { name: "blocked", label: "Blocked", terminal: false },
      ],
    });
    const diff = summarizeWorkflowDiff(def(), after);
    expect(diff.stateCountBefore).toBe(3);
    expect(diff.stateCountAfter).toBe(4);
    expect(diff.addedStateNames).toEqual(["blocked"]);
    expect(diff.removedStateNames).toEqual([]);
  });

  it("reports a state added in the middle (no false positives)", () => {
    // Positional diff would have reported two spurious renames here.
    const after = def({
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "blocked", label: "Blocked", terminal: false },
        { name: "in_progress", label: "In progress", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
    });
    const diff = summarizeWorkflowDiff(def(), after);
    expect(diff.addedStateNames).toEqual(["blocked"]);
    expect(diff.removedStateNames).toEqual([]);
  });

  it("reports a state removed from the middle (no false positives)", () => {
    // Positional diff would have reported a spurious rename here.
    const after = def({
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [{ from: "open", to: "done" }],
    });
    const diff = summarizeWorkflowDiff(def(), after);
    expect(diff.removedStateNames).toEqual(["in_progress"]);
    expect(diff.addedStateNames).toEqual([]);
  });

  it("reports a pure reorder as a no-op (no false positives)", () => {
    // Positional diff would have reported every state as renamed.
    const after = def({
      states: [
        { name: "done", label: "Done", terminal: true },
        { name: "open", label: "Open", terminal: false },
        { name: "in_progress", label: "In progress", terminal: false },
      ],
    });
    const diff = summarizeWorkflowDiff(def(), after);
    expect(diff.removedStateNames).toEqual([]);
    expect(diff.addedStateNames).toEqual([]);
  });

  it("reports initialState change", () => {
    const diff = summarizeWorkflowDiff(def(), def({ initialState: "in_progress" }));
    expect(diff.initialStateChanged).toBe(true);
  });

  it("reports transition count change", () => {
    const after = def({
      transitions: [...def().transitions, { from: "in_progress", to: "open" }],
    });
    const diff = summarizeWorkflowDiff(def(), after);
    expect(diff.transitionCountBefore).toBe(2);
    expect(diff.transitionCountAfter).toBe(3);
  });
});
