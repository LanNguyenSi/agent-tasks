import { describe, expect, it } from "vitest";
import { pickMergeTargetStatus } from "../../src/services/github-webhook.js";

// Direct unit tests for the webhook's post-merge target selection. The
// function is small and pure, so every governance-mode × workflow ×
// current-status combination that actually matters in production fits in
// one table. Keeps the three-tier policy pinned as the semantic anchor for
// the webhook path.

const AUTONOMOUS = { governanceMode: "AUTONOMOUS" as const };
const AWAITS = { governanceMode: "AWAITS_CONFIRMATION" as const };
const DR = { governanceMode: "REQUIRES_DISTINCT_REVIEWER" as const };
const LEGACY_SOLO = { soloMode: true, requireDistinctReviewer: false };
const LEGACY_DR = { soloMode: false, requireDistinctReviewer: true };

describe("pickMergeTargetStatus", () => {
  it("current=done short-circuits regardless of mode / workflow", () => {
    expect(
      pickMergeTargetStatus({ project: AUTONOMOUS, hasCustomWorkflow: false, currentStatus: "done" }),
    ).toBeNull();
    expect(
      pickMergeTargetStatus({ project: AWAITS, hasCustomWorkflow: true, currentStatus: "done" }),
    ).toBeNull();
    expect(
      pickMergeTargetStatus({ project: DR, hasCustomWorkflow: false, currentStatus: "done" }),
    ).toBeNull();
  });

  it("AUTONOMOUS → done regardless of currentStatus or custom workflow", () => {
    for (const currentStatus of ["open", "in_progress", "review"]) {
      expect(
        pickMergeTargetStatus({ project: AUTONOMOUS, hasCustomWorkflow: false, currentStatus }),
      ).toBe("done");
    }
  });

  it("custom workflow outside AUTONOMOUS → done (legacy carve-out)", () => {
    expect(
      pickMergeTargetStatus({ project: AWAITS, hasCustomWorkflow: true, currentStatus: "in_progress" }),
    ).toBe("done");
    expect(
      pickMergeTargetStatus({ project: DR, hasCustomWorkflow: true, currentStatus: "open" }),
    ).toBe("done");
  });

  it("AWAITS_CONFIRMATION + default workflow + current=review → no transition", () => {
    expect(
      pickMergeTargetStatus({ project: AWAITS, hasCustomWorkflow: false, currentStatus: "review" }),
    ).toBeNull();
  });

  it("AWAITS_CONFIRMATION + default workflow + current=open/in_progress → review", () => {
    expect(
      pickMergeTargetStatus({ project: AWAITS, hasCustomWorkflow: false, currentStatus: "open" }),
    ).toBe("review");
    expect(
      pickMergeTargetStatus({ project: AWAITS, hasCustomWorkflow: false, currentStatus: "in_progress" }),
    ).toBe("review");
  });

  it("REQUIRES_DISTINCT_REVIEWER behaves like AWAITS_CONFIRMATION for the webhook (gate runs elsewhere)", () => {
    expect(
      pickMergeTargetStatus({ project: DR, hasCustomWorkflow: false, currentStatus: "review" }),
    ).toBeNull();
    expect(
      pickMergeTargetStatus({ project: DR, hasCustomWorkflow: false, currentStatus: "in_progress" }),
    ).toBe("review");
  });

  it("legacy flags are accepted and derive the same behavior", () => {
    expect(
      pickMergeTargetStatus({ project: LEGACY_SOLO, hasCustomWorkflow: false, currentStatus: "in_progress" }),
    ).toBe("done");
    expect(
      pickMergeTargetStatus({ project: LEGACY_DR, hasCustomWorkflow: false, currentStatus: "in_progress" }),
    ).toBe("review");
  });
});
