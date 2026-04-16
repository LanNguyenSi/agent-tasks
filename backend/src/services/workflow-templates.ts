/**
 * Predefined workflow templates that can be applied to projects via the
 * "Apply Template" endpoint. Each template is a complete
 * WorkflowDefinitionShape ready to be persisted as a custom Workflow row.
 *
 * Templates stay in code (not DB) — they are versioned with the backend
 * and cannot be modified at runtime. Projects that apply a template get a
 * snapshot; subsequent template updates do not propagate retroactively.
 */

import type { WorkflowDefinitionShape } from "./default-workflow.js";

export interface WorkflowTemplate {
  /** Machine-readable slug used in the API (`apply-template/:slug`). */
  slug: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Short description for the template picker. */
  description: string;
  /** The full workflow definition snapshot. */
  definition: WorkflowDefinitionShape;
}

// ── AI Coding Agent Pipeline ────────────────────────────────────────────────
//
// 7-stage pipeline modeled after the keshrath/agent-tasks competitive
// benchmark (April 2026). Designed for solo AI coding agents that move
// tasks through backlog → spec → plan → implement → test → review → done.

const codingAgentDefinition: WorkflowDefinitionShape = {
  states: [
    {
      name: "backlog",
      label: "Backlog",
      terminal: false,
      agentInstructions:
        "This task is in the backlog. Claim it and move to spec to begin scoping.",
    },
    {
      name: "spec",
      label: "Spec",
      terminal: false,
      agentInstructions:
        "Write a clear specification: define the goal, acceptance criteria, constraints, and any open questions. Move to plan when the spec is complete.",
    },
    {
      name: "plan",
      label: "Plan",
      terminal: false,
      agentInstructions:
        "Create an implementation plan: identify files to change, outline the approach, note risks. Create a branch, then move to implement.",
    },
    {
      name: "implement",
      label: "Implement",
      terminal: false,
      agentInstructions:
        "Implement the changes according to the plan. Push commits to the branch. Move to test when the implementation is complete.",
    },
    {
      name: "test",
      label: "Test",
      terminal: false,
      agentInstructions:
        "Run tests, verify the implementation meets the spec. Fix any failures. Create a PR, then move to review.",
    },
    {
      name: "review",
      label: "Review",
      terminal: false,
      agentInstructions:
        "Code review stage. Approve to move to done, or request changes to send back to implement.",
    },
    {
      name: "done",
      label: "Done",
      terminal: true,
      agentInstructions:
        "Task is complete. Merge and deployment are external follow-ups.",
    },
  ],
  transitions: [
    // backlog → spec: claim and start scoping
    { from: "backlog", to: "spec", label: "Start scoping", requiredRole: "any" },

    // spec → plan: spec is written
    { from: "spec", to: "plan", label: "Spec complete" },
    // spec → backlog: release back
    { from: "spec", to: "backlog", label: "Release" },

    // plan → implement: plan is ready, branch created
    { from: "plan", to: "implement", label: "Start implementing", requires: ["branchPresent"] },
    // plan → spec: revisit spec
    { from: "plan", to: "spec", label: "Revisit spec" },

    // implement → test: code written
    { from: "implement", to: "test", label: "Ready for testing" },
    // implement → plan: revisit plan
    { from: "implement", to: "plan", label: "Revisit plan" },

    // test → review: tests pass, PR created
    { from: "test", to: "review", label: "Submit for review", requires: ["branchPresent", "prPresent"] },
    // test → implement: tests fail, fix needed
    { from: "test", to: "implement", label: "Fix failures" },

    // review → done: approved
    { from: "review", to: "done", label: "Approve" },
    // review → implement: changes requested
    { from: "review", to: "implement", label: "Request changes" },
  ],
  initialState: "backlog",
};

// ── Template registry ───────────────────────────────────────────────────────

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    slug: "coding-agent",
    name: "AI Coding Agent Pipeline",
    description:
      "7-stage pipeline: backlog → spec → plan → implement → test → review → done. Designed for AI coding agents with gates on branch and PR presence. Note: v2 MCP verbs (task_start, task_finish) are not yet compatible — use POST /tasks/:id/transition for state changes.",
    definition: codingAgentDefinition,
  },
] as const;

export function findWorkflowTemplate(slug: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.slug === slug);
}
