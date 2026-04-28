/**
 * Tests for the workflow state semantic helpers.
 *
 * Two definitions are exercised:
 *   - the built-in default (open / in_progress / review / done), which
 *     after the 4-state lock is the only shape the engine actually
 *     receives in production.
 *   - a synthetic non-default shape to keep the helpers honest as
 *     general-purpose utilities. The phase-2 migration may want to
 *     reuse them against legacy Workflow rows so the helpers must
 *     stay name-agnostic.
 */
import { describe, it, expect } from "vitest";
import {
  defaultWorkflowDefinition,
  isInitialState,
  isTerminalState,
  isReviewState,
  isWorkState,
  firstTransitionTarget,
  terminalStates,
  reviewStates,
  approveTarget,
  requestChangesTarget,
  expectedFinishStateFromDefinition,
  type WorkflowDefinitionShape,
} from "../../src/services/default-workflow.js";

const defaultDef = defaultWorkflowDefinition();

// Synthetic non-default definition mirroring the retired AI Coding
// Agent template (backlog → spec → plan → implement → test → review →
// done). Kept inline so this file does not depend on
// workflow-templates.ts (the registry is intentionally empty after the
// 4-state lock).
const codingAgentDef: WorkflowDefinitionShape = {
  states: [
    { name: "backlog", label: "Backlog", terminal: false },
    { name: "spec", label: "Spec", terminal: false },
    { name: "plan", label: "Plan", terminal: false },
    { name: "implement", label: "Implement", terminal: false },
    { name: "test", label: "Test", terminal: false },
    { name: "review", label: "Review", terminal: false },
    { name: "done", label: "Done", terminal: true },
  ],
  transitions: [
    { from: "backlog", to: "spec", requiredRole: "any" },
    { from: "spec", to: "plan", requiredRole: "any" },
    { from: "spec", to: "backlog", requiredRole: "any" },
    { from: "plan", to: "implement", requiredRole: "any" },
    { from: "plan", to: "spec", requiredRole: "any" },
    { from: "implement", to: "test", requiredRole: "any" },
    { from: "implement", to: "plan", requiredRole: "any" },
    { from: "test", to: "review", requiredRole: "any" },
    { from: "test", to: "implement", requiredRole: "any" },
    { from: "review", to: "done", requiredRole: "any" },
    { from: "review", to: "implement", requiredRole: "any" },
  ],
  initialState: "backlog",
};

// ── isInitialState ──────────────────────────────────────────────────────────

describe("isInitialState", () => {
  it("returns true for 'open' in default workflow", () => {
    expect(isInitialState(defaultDef, "open")).toBe(true);
  });
  it("returns false for 'in_progress' in default workflow", () => {
    expect(isInitialState(defaultDef, "in_progress")).toBe(false);
  });
  it("returns true for 'backlog' in coding-agent workflow", () => {
    expect(isInitialState(codingAgentDef, "backlog")).toBe(true);
  });
  it("returns false for 'open' in coding-agent workflow", () => {
    expect(isInitialState(codingAgentDef, "open")).toBe(false);
  });
});

// ── isTerminalState ─────────────────────────────────────────────────────────

describe("isTerminalState", () => {
  it("returns true for 'done' in default workflow", () => {
    expect(isTerminalState(defaultDef, "done")).toBe(true);
  });
  it("returns false for 'review' in default workflow", () => {
    expect(isTerminalState(defaultDef, "review")).toBe(false);
  });
  it("returns true for 'done' in coding-agent workflow", () => {
    expect(isTerminalState(codingAgentDef, "done")).toBe(true);
  });
  it("returns false for unknown state", () => {
    expect(isTerminalState(defaultDef, "nonexistent")).toBe(false);
  });
});

// ── isReviewState ───────────────────────────────────────────────────────────

describe("isReviewState", () => {
  it("returns true for 'review' in default workflow", () => {
    expect(isReviewState(defaultDef, "review")).toBe(true);
  });
  it("returns false for 'in_progress' in default workflow (direct from initial)", () => {
    expect(isReviewState(defaultDef, "in_progress")).toBe(false);
  });
  it("returns false for 'open' in default workflow (is initial)", () => {
    expect(isReviewState(defaultDef, "open")).toBe(false);
  });
  it("returns false for 'done' in default workflow (is terminal)", () => {
    expect(isReviewState(defaultDef, "done")).toBe(false);
  });
  it("returns true for 'review' in coding-agent workflow", () => {
    expect(isReviewState(codingAgentDef, "review")).toBe(true);
  });
  it("returns false for 'spec' in coding-agent (direct from backlog)", () => {
    expect(isReviewState(codingAgentDef, "spec")).toBe(false);
  });
  it("returns false for 'implement' in coding-agent (no transition to terminal)", () => {
    expect(isReviewState(codingAgentDef, "implement")).toBe(false);
  });
  it("returns false for 'test' in coding-agent (no transition to terminal)", () => {
    expect(isReviewState(codingAgentDef, "test")).toBe(false);
  });
});

// ── isWorkState ─────────────────────────────────────────────────────────────

describe("isWorkState", () => {
  it("returns true for 'in_progress' in default workflow", () => {
    expect(isWorkState(defaultDef, "in_progress")).toBe(true);
  });
  it("returns true for 'review' in default workflow (review is also a work state)", () => {
    expect(isWorkState(defaultDef, "review")).toBe(true);
  });
  it("returns false for 'open' (initial)", () => {
    expect(isWorkState(defaultDef, "open")).toBe(false);
  });
  it("returns false for 'done' (terminal)", () => {
    expect(isWorkState(defaultDef, "done")).toBe(false);
  });
  it("returns true for coding-agent work states", () => {
    for (const state of ["spec", "plan", "implement", "test", "review"]) {
      expect(isWorkState(codingAgentDef, state)).toBe(true);
    }
  });
  it("returns false for 'backlog' in coding-agent (initial)", () => {
    expect(isWorkState(codingAgentDef, "backlog")).toBe(false);
  });
});

// ── firstTransitionTarget ───────────────────────────────────────────────────

describe("firstTransitionTarget", () => {
  it("returns 'in_progress' from 'open' in default workflow", () => {
    expect(firstTransitionTarget(defaultDef, "open")).toBe("in_progress");
  });
  it("returns 'spec' from 'backlog' in coding-agent workflow", () => {
    expect(firstTransitionTarget(codingAgentDef, "backlog")).toBe("spec");
  });
  it("returns undefined from terminal state", () => {
    expect(firstTransitionTarget(defaultDef, "done")).toBeUndefined();
  });
});

// ── terminalStates ──────────────────────────────────────────────────────────

describe("terminalStates", () => {
  it("returns ['done'] for default workflow", () => {
    expect(terminalStates(defaultDef)).toEqual(["done"]);
  });
  it("returns ['done'] for coding-agent workflow", () => {
    expect(terminalStates(codingAgentDef)).toEqual(["done"]);
  });
});

// ── reviewStates ────────────────────────────────────────────────────────────

describe("reviewStates", () => {
  it("returns ['review'] for default workflow", () => {
    expect(reviewStates(defaultDef)).toEqual(["review"]);
  });
  it("returns ['review'] for coding-agent workflow", () => {
    expect(reviewStates(codingAgentDef)).toEqual(["review"]);
  });
});

// ── approveTarget ───────────────────────────────────────────────────────────

describe("approveTarget", () => {
  it("returns 'done' from 'review' in default workflow", () => {
    expect(approveTarget(defaultDef, "review")).toBe("done");
  });
  it("returns 'done' from 'review' in coding-agent workflow", () => {
    expect(approveTarget(codingAgentDef, "review")).toBe("done");
  });
  it("returns undefined from a state with no terminal transition", () => {
    expect(approveTarget(codingAgentDef, "implement")).toBeUndefined();
  });
});

// ── requestChangesTarget ────────────────────────────────────────────────────

describe("requestChangesTarget", () => {
  it("returns 'in_progress' from 'review' in default workflow", () => {
    expect(requestChangesTarget(defaultDef, "review")).toBe("in_progress");
  });
  it("returns 'implement' from 'review' in coding-agent workflow", () => {
    expect(requestChangesTarget(codingAgentDef, "review")).toBe("implement");
  });
});

// ── expectedFinishStateFromDefinition ────────────────────────────────────────

describe("expectedFinishStateFromDefinition", () => {
  it("returns 'review' for default workflow", () => {
    expect(expectedFinishStateFromDefinition(defaultDef)).toBe("review");
  });
  it("returns 'review' for coding-agent workflow", () => {
    expect(expectedFinishStateFromDefinition(codingAgentDef)).toBe("review");
  });
  it("returns 'done' for a workflow with no review state", () => {
    const noReview: WorkflowDefinitionShape = {
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [{ from: "open", to: "done", label: "Finish" }],
      initialState: "open",
    };
    expect(expectedFinishStateFromDefinition(noReview)).toBe("done");
  });
  it("returns 'done' for null definition (falls back to built-in)", () => {
    // Built-in default has review → returns "review" actually
    expect(expectedFinishStateFromDefinition(null)).toBe("review");
  });
});
