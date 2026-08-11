import { describe, it, expect } from "vitest";
import {
  DEFAULT_WORKFLOW_STATES,
  DEFAULT_WORKFLOW_AGENT_INSTRUCTIONS,
  DEFAULT_WORKFLOW_TRANSITIONS,
} from "../src/default-workflow.js";
import {
  DEFAULT_STATES as BACKEND_DEFAULT_STATES,
  DEFAULT_TRANSITIONS as BACKEND_DEFAULT_TRANSITIONS,
} from "../../backend/src/services/default-workflow.js";

// rc-v1-C003 acceptance criterion: "Removed static text is content-equal
// preserved in the exported constant". The real source of truth is
// backend/src/services/default-workflow.ts's DEFAULT_STATES /
// DEFAULT_TRANSITIONS, so the primary assertions below import it directly
// and compare against it (constant==backend, not just constant==test's own
// hardcoded copy — a cross-workspace import that is test-only: it never
// reaches `npm run build`'s tsc output, since mcp-server's tsconfig.json
// excludes `tests/`; see src/default-workflow.ts's file doc comment).
//
// One hardcoded expectation is kept as a positive control alongside the
// cross-package comparisons: if this file's mirror AND the backend source
// ever drifted the SAME way at the SAME time (e.g. a find-and-replace
// across the whole repo), a toEqual against the backend constant alone
// would stay green while silently validating the wrong text. The hardcoded
// assertion is independent of both source files and would still catch
// that.

describe("DEFAULT_WORKFLOW_STATES / DEFAULT_WORKFLOW_AGENT_INSTRUCTIONS", () => {
  it("is content-equal to the backend's DEFAULT_STATES (the real source of truth, not just this file's own copy)", () => {
    expect(DEFAULT_WORKFLOW_STATES).toEqual(BACKEND_DEFAULT_STATES);
  });

  // Positive control (see file header): hand-verified, independent of both
  // source files.
  it("carries the exact, hand-verified agentInstructions prose for the open state", () => {
    expect(DEFAULT_WORKFLOW_STATES[0]).toEqual({
      name: "open",
      label: "Open",
      terminal: false,
      agentInstructions: "Claim this task, create a branch, then transition to in_progress.",
    });
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
  it("is content-equal to the backend's DEFAULT_TRANSITIONS (the real source of truth, not just this file's own copy)", () => {
    expect(DEFAULT_WORKFLOW_TRANSITIONS).toEqual(BACKEND_DEFAULT_TRANSITIONS);
  });

  it("deliberately has no requires on the open -> in_progress edge (would self-checkmate task_start's own gate enforcement)", () => {
    expect(DEFAULT_WORKFLOW_TRANSITIONS.open[0]).not.toHaveProperty("requires");
  });
});
