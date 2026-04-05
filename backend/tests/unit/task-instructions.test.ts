import { describe, expect, it } from "vitest";
import {
  buildWorkflowlessTaskInstructions,
  getDefaultTransitionsForStatus,
} from "../../src/services/task-instructions.js";

describe("task instructions defaults", () => {
  it("returns actionable default transitions for review status", () => {
    const result = buildWorkflowlessTaskInstructions("review");

    expect(result.currentState).toBe("review");
    expect(result.agentInstructions).toContain("allowed transitions");
    expect(result.allowedTransitions.map((t) => t.status)).toEqual(["done", "in_progress"]);
    expect(result.updatableFields).toEqual(["branchName", "prUrl", "prNumber", "result"]);
  });

  it("returns no transitions for done status", () => {
    const result = buildWorkflowlessTaskInstructions("done");

    expect(result.allowedTransitions).toEqual([]);
    expect(result.agentInstructions).toContain("No further default transitions");
  });

  it("keeps default review transitions stable", () => {
    expect(getDefaultTransitionsForStatus("review")).toEqual([
      {
        status: "done",
        label: "Approve and complete",
        reason: "Review passed and the task is complete.",
      },
      {
        status: "in_progress",
        label: "Request changes",
        reason: "More work is needed before completion.",
      },
    ]);
  });
});
