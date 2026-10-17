/**
 * The merge status gate and the webhook's merge-target choice read review and
 * terminal semantics from a workflow definition. Pins (a) that every shippable
 * four-state workflow keeps accepting exactly {review, done}, and (b) that a
 * workflow with its own state names is judged on its own states.
 */
import { describe, expect, it } from "vitest";
import { checkTaskStatusForMerge } from "../../src/services/gates/task-status-for-merge.js";
import { pickMergeTargetStatus } from "../../src/services/github-webhook.js";
import {
  defaultWorkflowDefinition,
  isReviewState,
  isTerminalState,
} from "../../src/services/default-workflow.js";
import { WORKFLOW_TEMPLATES } from "../../src/services/workflow-templates.js";
import { CUSTOM_VOCABULARY_DEFINITION, OPEN_TO_REVIEW_DEFINITION } from "../helpers/custom-vocabulary-workflow.js";

const AUTONOMOUS = { governanceMode: "AUTONOMOUS" as const };
const AWAITS = { governanceMode: "AWAITS_CONFIRMATION" as const };
const DR = { governanceMode: "REQUIRES_DISTINCT_REVIEWER" as const };

const SHIPPABLE_DEFINITIONS = [
  { name: "built-in default", definition: defaultWorkflowDefinition() },
  ...WORKFLOW_TEMPLATES.map((t) => ({ name: `template ${t.slug}`, definition: t.definition })),
];

describe("template safety: every shippable four-state workflow accepts exactly {review, done}", () => {
  it("covers the built-in default and at least one template", () => {
    expect(SHIPPABLE_DEFINITIONS.length).toBeGreaterThan(1);
  });

  it.each(SHIPPABLE_DEFINITIONS)("$name", ({ definition }) => {
    expect(isReviewState(definition, "review")).toBe(true);
    expect(isTerminalState(definition, "done")).toBe(true);
    expect(isReviewState(definition, "in_progress")).toBe(false);
    expect(isReviewState(definition, "open")).toBe(false);
    for (const status of ["review", "done"]) {
      expect(checkTaskStatusForMerge({ status }, definition)).toEqual({ ok: true });
    }
    for (const status of ["open", "in_progress", "backlog", "archived"]) {
      expect(checkTaskStatusForMerge({ status }, definition).ok).toBe(false);
    }
  });
});

describe("checkTaskStatusForMerge with a custom state vocabulary", () => {
  it.each(["qa", "shipped"])("accepts %s", (status) => {
    expect(checkTaskStatusForMerge({ status }, CUSTOM_VOCABULARY_DEFINITION)).toEqual({ ok: true });
  });

  it.each(["open", "plan", "build"])("rejects %s and echoes it back", (status) => {
    expect(checkTaskStatusForMerge({ status }, CUSTOM_VOCABULARY_DEFINITION)).toEqual({
      ok: false,
      reason: "bad_status",
      currentStatus: status,
    });
  });

  it("does not take the built-in names for granted: review and done are unknown states there", () => {
    expect(checkTaskStatusForMerge({ status: "review" }, CUSTOM_VOCABULARY_DEFINITION).ok).toBe(false);
    expect(checkTaskStatusForMerge({ status: "done" }, CUSTOM_VOCABULARY_DEFINITION).ok).toBe(false);
  });
});

describe("pickMergeTargetStatus with a custom state vocabulary", () => {
  const definition = CUSTOM_VOCABULARY_DEFINITION;

  it("hands a pre-review task to the workflow's review-like state", () => {
    for (const currentStatus of ["open", "plan", "build"]) {
      expect(pickMergeTargetStatus({ project: AWAITS, currentStatus, definition })).toBe("qa");
      expect(pickMergeTargetStatus({ project: DR, currentStatus, definition })).toBe("qa");
    }
  });

  it("leaves a review-like or terminal task alone when confirmation is required", () => {
    expect(pickMergeTargetStatus({ project: AWAITS, currentStatus: "qa", definition })).toBeNull();
    expect(pickMergeTargetStatus({ project: DR, currentStatus: "shipped", definition })).toBeNull();
  });

  it("AUTONOMOUS targets the workflow's terminal state, and leaves a terminal task alone", () => {
    expect(pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus: "build", definition })).toBe("shipped");
    expect(pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus: "qa", definition })).toBe("shipped");
    expect(pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus: "shipped", definition })).toBeNull();
  });

  it("keeps the backlog guard", () => {
    expect(pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus: "backlog", definition })).toBeNull();
    expect(pickMergeTargetStatus({ project: AWAITS, currentStatus: "backlog", definition })).toBeNull();
  });

  it("makes no confirmation-required move when the workflow has no review-like state", () => {
    const noReview = {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "closed", label: "Closed", terminal: true },
      ],
      transitions: [{ from: "open", to: "closed" }],
    };
    expect(pickMergeTargetStatus({ project: AWAITS, currentStatus: "open", definition: noReview })).toBeNull();
    expect(pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus: "open", definition: noReview })).toBe("closed");
  });
});

describe("a four-state workflow with a free open -> review edge", () => {
  const definition = OPEN_TO_REVIEW_DEFINITION;

  it("does not read review as review-like, because the initial state leads straight to it", () => {
    expect(isReviewState(definition, "review")).toBe(false);
    expect(isTerminalState(definition, "done")).toBe(true);
  });

  it("the merge gate refuses a review task and still accepts done", () => {
    expect(checkTaskStatusForMerge({ status: "review" }, definition)).toEqual({
      ok: false,
      reason: "bad_status",
      currentStatus: "review",
    });
    expect(checkTaskStatusForMerge({ status: "done" }, definition)).toEqual({ ok: true });
  });

  it("pickMergeTargetStatus has no review-like state to hand a task to", () => {
    for (const currentStatus of ["open", "in_progress", "review"]) {
      expect(pickMergeTargetStatus({ project: AWAITS, currentStatus, definition })).toBeNull();
      expect(pickMergeTargetStatus({ project: DR, currentStatus, definition })).toBeNull();
    }
  });

  it("AUTONOMOUS still targets the terminal state, and leaves done alone", () => {
    expect(pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus: "review", definition })).toBe("done");
    expect(pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus: "done", definition })).toBeNull();
  });
});
