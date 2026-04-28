import { describe, expect, it } from "vitest";
import { pickMergeTargetStatus } from "../../src/services/github-webhook.js";

// Direct unit tests for the webhook's post-merge target selection. The
// function is small and pure, so every governance-mode × current-status
// combination that actually matters in production fits in one table.
// Keeps the three-tier policy pinned as the semantic anchor for the
// webhook path.
//
// The legacy `hasCustomWorkflow` parameter was removed when agent-tasks
// locked to the fixed 4-state model — there is no longer a per-project
// workflow graph that could place a custom state name in place of
// "review" / "done", so the function depends only on governance mode +
// current status.

const AUTONOMOUS = { governanceMode: "AUTONOMOUS" as const };
const AWAITS = { governanceMode: "AWAITS_CONFIRMATION" as const };
const DR = { governanceMode: "REQUIRES_DISTINCT_REVIEWER" as const };
const LEGACY_SOLO = { soloMode: true, requireDistinctReviewer: false };
const LEGACY_DR = { soloMode: false, requireDistinctReviewer: true };

describe("pickMergeTargetStatus", () => {
  it("current=done short-circuits regardless of mode", () => {
    expect(
      pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus: "done" }),
    ).toBeNull();
    expect(
      pickMergeTargetStatus({ project: AWAITS, currentStatus: "done" }),
    ).toBeNull();
    expect(
      pickMergeTargetStatus({ project: DR, currentStatus: "done" }),
    ).toBeNull();
  });

  it("AUTONOMOUS → done regardless of currentStatus", () => {
    for (const currentStatus of ["open", "in_progress", "review"]) {
      expect(
        pickMergeTargetStatus({ project: AUTONOMOUS, currentStatus }),
      ).toBe("done");
    }
  });

  it("AWAITS_CONFIRMATION + current=review → no transition", () => {
    expect(
      pickMergeTargetStatus({ project: AWAITS, currentStatus: "review" }),
    ).toBeNull();
  });

  it("AWAITS_CONFIRMATION + current=open/in_progress → review", () => {
    expect(
      pickMergeTargetStatus({ project: AWAITS, currentStatus: "open" }),
    ).toBe("review");
    expect(
      pickMergeTargetStatus({ project: AWAITS, currentStatus: "in_progress" }),
    ).toBe("review");
  });

  it("REQUIRES_DISTINCT_REVIEWER behaves like AWAITS_CONFIRMATION for the webhook (gate runs elsewhere)", () => {
    expect(
      pickMergeTargetStatus({ project: DR, currentStatus: "review" }),
    ).toBeNull();
    expect(
      pickMergeTargetStatus({ project: DR, currentStatus: "in_progress" }),
    ).toBe("review");
  });

  it("legacy flags are accepted and derive the same behavior", () => {
    expect(
      pickMergeTargetStatus({ project: LEGACY_SOLO, currentStatus: "in_progress" }),
    ).toBe("done");
    expect(
      pickMergeTargetStatus({ project: LEGACY_DR, currentStatus: "in_progress" }),
    ).toBe("review");
  });
});
