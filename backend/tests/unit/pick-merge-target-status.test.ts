import { describe, expect, it } from "vitest";
import { pickMergeTargetStatus } from "../../src/services/github-webhook.js";
import { reachableReviewState, type WorkflowDefinitionShape } from "../../src/services/default-workflow.js";
import { CUSTOM_VOCABULARY_DEFINITION, TWO_REVIEW_DEFINITION } from "../helpers/custom-vocabulary-workflow.js";

// Direct unit tests for the webhook's post-merge target selection. The
// function is small and pure, so every governance-mode × current-status
// combination that matters in production fits in one table. Keeps the
// three-tier policy pinned as the semantic anchor for the webhook path.
//
// M3: custom workflows no longer change the target here. A confirmation-
// required project keeps its review gate on a webhook merge regardless of
// workflow, so `hasCustomWorkflow` is no longer an input.

const AUTONOMOUS = { governanceMode: "AUTONOMOUS" as const };
const AWAITS = { governanceMode: "AWAITS_CONFIRMATION" as const };
const DR = { governanceMode: "REQUIRES_DISTINCT_REVIEWER" as const };
const LEGACY_SOLO = { soloMode: true, requireDistinctReviewer: false };
const LEGACY_DR = { soloMode: false, requireDistinctReviewer: true };

describe("pickMergeTargetStatus", () => {
  it("current=done short-circuits regardless of mode", () => {
    expect(pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus: "done" })).toBeNull();
    expect(pickMergeTargetStatus({ project: AWAITS, currentStatus: "done" })).toBeNull();
    expect(pickMergeTargetStatus({ project: DR, currentStatus: "done" })).toBeNull();
  });

  // Backlog-escape fix: an unpromoted backlog task must never be moved by a
  // webhook-observed PR merge, in ANY governance mode — including AUTONOMOUS,
  // which would otherwise auto-`done` it. Backlog leaves only via an
  // operator's explicit PATCH promotion.
  it("current=backlog short-circuits regardless of mode, including AUTONOMOUS", () => {
    expect(pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus: "backlog" })).toBeNull();
    expect(pickMergeTargetStatus({ project: AWAITS, currentStatus: "backlog" })).toBeNull();
    expect(pickMergeTargetStatus({ project: DR, currentStatus: "backlog" })).toBeNull();
  });

  it("AUTONOMOUS → done regardless of currentStatus", () => {
    for (const currentStatus of ["open", "in_progress", "review"]) {
      expect(pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus })).toBe("done");
    }
  });

  it("confirmation-required modes hand off to review, NOT done", () => {
    // Regression: the old carve-out returned "done" for custom-workflow
    // projects here, bypassing the review gate that default-workflow non-solo
    // projects get. The webhook no longer special-cases custom workflows, so a
    // pre-review task in a confirmation-required mode is handed to review.
    expect(pickMergeTargetStatus({ project: AWAITS, currentStatus: "open" })).toBe("review");
    expect(pickMergeTargetStatus({ project: AWAITS, currentStatus: "in_progress" })).toBe("review");
    expect(pickMergeTargetStatus({ project: DR, currentStatus: "open" })).toBe("review");
    expect(pickMergeTargetStatus({ project: DR, currentStatus: "in_progress" })).toBe("review");
  });

  it("confirmation-required modes + current=review → no transition (explicit approval required)", () => {
    expect(pickMergeTargetStatus({ project: AWAITS, currentStatus: "review" })).toBeNull();
    expect(pickMergeTargetStatus({ project: DR, currentStatus: "review" })).toBeNull();
  });

  it("legacy flags are accepted and derive the same behavior", () => {
    expect(pickMergeTargetStatus({ project: LEGACY_SOLO, currentStatus: "in_progress" })).toBe("done");
    expect(pickMergeTargetStatus({ project: LEGACY_DR, currentStatus: "in_progress" })).toBe("review");
  });
});

// The merge hand-off picks like a work-claim task_finish: the first review-like
// state with a DIRECT edge from the task's current state; with no such edge the
// workflow-wide first review-like state (the unchanged fallback).
describe("pickMergeTargetStatus: review state reachable from the current state", () => {
  const pick = (project: Parameters<typeof pickMergeTargetStatus>[0]["project"], currentStatus: string, definition: WorkflowDefinitionShape) =>
    pickMergeTargetStatus({ project, currentStatus, definition });

  it.each(["AWAITS", "DR"] as const)("%s: a task in b is handed to r2, the review state b has an edge to", (mode) => {
    const project = mode === "AWAITS" ? AWAITS : DR;
    expect(pick(project, "b", TWO_REVIEW_DEFINITION)).toBe("r2");
  });

  it.each(["AWAITS", "DR"] as const)("%s: a task in a is handed to r1", (mode) => {
    const project = mode === "AWAITS" ? AWAITS : DR;
    expect(pick(project, "a", TWO_REVIEW_DEFINITION)).toBe("r1");
  });

  it("no edge from the current state into a review-like state: the workflow-wide first review state (fallback, unchanged)", () => {
    expect(TWO_REVIEW_DEFINITION.transitions.some((t) => t.from === "open" && (t.to === "r1" || t.to === "r2"))).toBe(false);
    expect(pick(AWAITS, "open", TWO_REVIEW_DEFINITION)).toBe("r1");
    expect(pick(AWAITS, "not_a_state", TWO_REVIEW_DEFINITION)).toBe("r1");
  });

  it("custom vocabulary: build reaches qa directly, plan falls back to the workflow-wide qa", () => {
    expect(pick(AWAITS, "build", CUSTOM_VOCABULARY_DEFINITION)).toBe("qa");
    expect(pick(AWAITS, "plan", CUSTOM_VOCABULARY_DEFINITION)).toBe("qa");
  });

  it("unchanged branches on a multi-review workflow: review-like and terminal stay put, AUTONOMOUS goes to the terminal state", () => {
    expect(pick(AWAITS, "r1", TWO_REVIEW_DEFINITION)).toBeNull();
    expect(pick(AWAITS, "r2", TWO_REVIEW_DEFINITION)).toBeNull();
    expect(pick(DR, "shipped", TWO_REVIEW_DEFINITION)).toBeNull();
    expect(pick(AWAITS, "backlog", TWO_REVIEW_DEFINITION)).toBeNull();
    expect(pick(AUTONOMOUS, "b", TWO_REVIEW_DEFINITION)).toBe("shipped");
    expect(pick(AUTONOMOUS, "open", TWO_REVIEW_DEFINITION)).toBe("shipped");
  });

  it("a workflow without a review-like state still answers null", () => {
    const noReview: WorkflowDefinitionShape = {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "work", label: "Work", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [{ from: "open", to: "work" }, { from: "work", to: "done" }],
    };
    expect(pick(AWAITS, "work", noReview)).toBeNull();
  });

  it("built-in workflow: in_progress -> review (edge), open -> review (fallback)", () => {
    expect(pickMergeTargetStatus({ project: AWAITS, currentStatus: "in_progress" })).toBe("review");
    expect(pickMergeTargetStatus({ project: AWAITS, currentStatus: "open" })).toBe("review");
  });
});

describe("reachableReviewState", () => {
  it("is the first review-like state, in state order, with a direct edge; undefined with none", () => {
    expect(reachableReviewState(TWO_REVIEW_DEFINITION, "a")).toBe("r1");
    expect(reachableReviewState(TWO_REVIEW_DEFINITION, "b")).toBe("r2");
    expect(reachableReviewState(TWO_REVIEW_DEFINITION, "open")).toBeUndefined();
    expect(reachableReviewState(TWO_REVIEW_DEFINITION, "shipped")).toBeUndefined();
  });
});
