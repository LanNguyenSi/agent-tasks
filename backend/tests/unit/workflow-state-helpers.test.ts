/**
 * Tests for the workflow state semantic helpers.
 *
 * Two definitions are exercised:
 *   - the built-in default (open / in_progress / review / done), the
 *     only definition the engine sees in production now that the state
 *     vocabulary is locked.
 *   - a synthetic non-default shape with extra/foreign state names. The
 *     helpers themselves stay name-agnostic for forensic / migration
 *     use cases (e.g. evaluating a legacy Workflow row before
 *     normalization), so the test pins that behaviour.
 */
import { describe, it, expect } from "vitest";
import { CUSTOM_VOCABULARY_DEFINITION } from "../helpers/custom-vocabulary-workflow.js";
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
  finishTargetFrom,
  type WorkflowDefinitionShape,
} from "../../src/services/default-workflow.js";

const defaultDef = defaultWorkflowDefinition();

// Synthetic non-default definition: backlog → spec → plan → implement →
// test → review → done. Mirrors the retired AI Coding Agent template
// shape. Inline so this file does not depend on workflow-templates.ts
// (which holds an empty registry now that the state vocabulary is
// locked).
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

// ── finishTargetFrom ────────────────────────────────────────────────────────

/**
 * Two review-like states, each reachable from a different work state:
 * `spec_check` (first in state order) only from `plan`, `qa` only from
 * `build`. A finish from `build` must land in `qa`; the workflow-wide first
 * review-like state (`spec_check`) has no edge from there.
 */
const twoReviewDef: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "draft", label: "Draft", terminal: false },
    { name: "plan", label: "Plan", terminal: false },
    { name: "spec_check", label: "Spec check", terminal: false },
    { name: "build", label: "Build", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "open", to: "draft" },
    { from: "draft", to: "plan" },
    { from: "plan", to: "spec_check" },
    { from: "plan", to: "build" },
    { from: "spec_check", to: "shipped" },
    { from: "build", to: "qa" },
    { from: "qa", to: "shipped" },
  ],
};

describe("finishTargetFrom", () => {
  it("returns 'review' from every work state of the built-in four-state workflow", () => {
    expect(finishTargetFrom(defaultDef, "in_progress")).toBe("review");
    expect(finishTargetFrom(null, "in_progress")).toBe("review");
  });

  it("built-in workflow: a state with no edge into review (open, review, done) keeps the workflow-wide fallback", () => {
    for (const from of ["open", "review", "done"]) {
      expect(finishTargetFrom(defaultDef, from)).toBe(expectedFinishStateFromDefinition(defaultDef));
    }
  });

  it("custom vocabulary: build reaches qa directly", () => {
    expect(finishTargetFrom(CUSTOM_VOCABULARY_DEFINITION, "build")).toBe("qa");
  });

  it("custom vocabulary: plan has no direct review edge and falls back to the workflow-wide review state", () => {
    expect(finishTargetFrom(CUSTOM_VOCABULARY_DEFINITION, "plan")).toBe("qa");
  });

  it("two review states: each work state finishes into the review state it has an edge to", () => {
    // The pre-fix answer (reviewStates(def)[0]) is spec_check for both.
    expect(reviewStates(twoReviewDef)).toEqual(["spec_check", "qa"]);
    expect(finishTargetFrom(twoReviewDef, "plan")).toBe("spec_check");
    expect(finishTargetFrom(twoReviewDef, "build")).toBe("qa");
  });

  it("two review states: a work state with no review edge falls back to the first review state (finish stays unreachable)", () => {
    expect(finishTargetFrom(twoReviewDef, "draft")).toBe("spec_check");
    expect(twoReviewDef.transitions.some((t) => t.from === "draft" && t.to === "spec_check")).toBe(false);
  });

  it("several reachable review states: the first in state order wins, not the first edge and not the last", () => {
    const def: WorkflowDefinitionShape = {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "work", label: "Work", terminal: false },
        { name: "r1", label: "R1", terminal: false },
        { name: "r2", label: "R2", terminal: false },
        { name: "shipped", label: "Shipped", terminal: true },
      ],
      // The edge to r2 is declared first on purpose.
      transitions: [
        { from: "open", to: "work" },
        { from: "work", to: "r2" },
        { from: "work", to: "r1" },
        { from: "r1", to: "shipped" },
        { from: "r2", to: "shipped" },
      ],
    };
    expect(finishTargetFrom(def, "work")).toBe("r1");
  });

  it("a review edge wins over a terminal edge from the same state", () => {
    const def: WorkflowDefinitionShape = {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "work", label: "Work", terminal: false },
        { name: "review", label: "Review", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [
        { from: "open", to: "work" },
        { from: "work", to: "done" },
        { from: "work", to: "review" },
        { from: "review", to: "done" },
      ],
    };
    expect(finishTargetFrom(def, "work")).toBe("review");
  });

  it("no review-like state: finishes into the first terminal state from any state", () => {
    const noReview: WorkflowDefinitionShape = {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "work", label: "Work", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [
        { from: "open", to: "work" },
        { from: "work", to: "done" },
      ],
    };
    expect(finishTargetFrom(noReview, "work")).toBe("done");
    expect(finishTargetFrom(noReview, "open")).toBe("done");
  });

  it("a state that is not in the definition falls back to the workflow-wide answer", () => {
    expect(finishTargetFrom(twoReviewDef, "nope")).toBe(expectedFinishStateFromDefinition(twoReviewDef));
    expect(finishTargetFrom(defaultDef, "nope")).toBe("review");
  });
});
