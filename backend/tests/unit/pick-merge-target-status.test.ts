import { describe, expect, it } from "vitest";
import { pickMergeTargetStatus } from "../../src/services/github-webhook.js";

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

  it("AUTONOMOUS → done regardless of currentStatus", () => {
    for (const currentStatus of ["open", "in_progress", "review"]) {
      expect(pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus })).toBe("done");
    }
  });

  it("M3: confirmation-required modes hand off to review, NOT done", () => {
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
