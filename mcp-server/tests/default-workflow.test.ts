import { describe, it, expect } from "vitest";
import {
  DEFAULT_WORKFLOW_STATES,
  DEFAULT_WORKFLOW_AGENT_INSTRUCTIONS,
  DEFAULT_WORKFLOW_TRANSITIONS,
} from "../src/default-workflow.js";

// rc-v1-C003 acceptance criterion: "Removed static text is content-equal
// preserved in the exported constant". These are hardcoded, verbatim
// expectations (not derived from the constant itself) so a future edit that
// silently drifts the text is caught here, not just a "the constant exists"
// smoke test. Source of truth for the verbatim strings:
// backend/src/services/default-workflow.ts's DEFAULT_STATES /
// DEFAULT_TRANSITIONS (out of scope to import directly — see
// src/default-workflow.ts's file doc comment on why this is a hand-copied
// mirror, not a shared import).

describe("DEFAULT_WORKFLOW_STATES / DEFAULT_WORKFLOW_AGENT_INSTRUCTIONS", () => {
  it("carries all four default-workflow states with their exact agentInstructions prose", () => {
    expect(DEFAULT_WORKFLOW_STATES).toEqual([
      {
        name: "open",
        label: "Open",
        terminal: false,
        agentInstructions: "Claim this task, create a branch, then transition to in_progress.",
      },
      {
        name: "in_progress",
        label: "In progress",
        terminal: false,
        agentInstructions:
          "Implement the changes. When done, push the branch, create a PR, update prUrl and branchName, then transition to review.",
      },
      {
        name: "review",
        label: "In review",
        terminal: false,
        agentInstructions:
          "Review is a code-review state. Approve or request changes here. Merge, deploy, and production verification are external follow-up actions unless your project defines a custom workflow for them.",
      },
      {
        name: "done",
        label: "Done",
        terminal: true,
        agentInstructions:
          "Task is complete. Merge, deploy, and production verification are operational follow-ups outside the modeled task states unless a custom workflow models them explicitly.",
      },
    ]);
  });

  it("DEFAULT_WORKFLOW_AGENT_INSTRUCTIONS is a state-name-keyed lookup over the same text", () => {
    for (const state of DEFAULT_WORKFLOW_STATES) {
      expect(DEFAULT_WORKFLOW_AGENT_INSTRUCTIONS[state.name]).toBe(state.agentInstructions);
    }
    expect(Object.keys(DEFAULT_WORKFLOW_AGENT_INSTRUCTIONS).sort()).toEqual(
      ["done", "in_progress", "open", "review"].sort(),
    );
  });
});

describe("DEFAULT_WORKFLOW_TRANSITIONS", () => {
  it("matches the default workflow's exact edges and requires[] gate lists", () => {
    expect(DEFAULT_WORKFLOW_TRANSITIONS).toEqual({
      open: [{ to: "in_progress", label: "Start" }],
      in_progress: [
        { to: "review", label: "Submit for review", requires: ["branchPresent", "prPresent"] },
        { to: "done", label: "Mark done", requires: ["branchPresent", "prPresent"] },
        { to: "open", label: "Release" },
      ],
      review: [
        { to: "done", label: "Approve" },
        { to: "in_progress", label: "Request changes" },
      ],
      done: [],
    });
  });

  it("deliberately has no requires on the open -> in_progress edge (would self-checkmate task_start's own gate enforcement)", () => {
    expect(DEFAULT_WORKFLOW_TRANSITIONS.open[0]).not.toHaveProperty("requires");
  });
});
