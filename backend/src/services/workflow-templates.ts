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

// ── Branch / PR / Merge Gated ───────────────────────────────────────────────
//
// The locked four-state workflow {open, in_progress, review, done} with
// stricter precondition gates than the built-in default:
//
//   - open → in_progress requires a recorded branch (branchPresent);
//   - in_progress → review and the skip-review in_progress → done both
//     require a branch and a PR (branchPresent, prPresent);
//   - every edge into `done` additionally requires the PR to be merged
//     (prMerged), so reaching `done` always means the PR landed.
//
// Unlike the built-in default — which deliberately leaves open →
// in_progress ungated so exploratory work can begin before a branch
// exists — this template enforces branch-first discipline from the very
// first transition. Projects that adopt it accept that `task_start`
// returns 422 until `branchName` is recorded; the `open` state's
// agentInstructions spell that out so the 422 is never a surprise.

const branchPrMergeGatedDefinition: WorkflowDefinitionShape = {
  states: [
    {
      name: "open",
      label: "Open",
      terminal: false,
      agentInstructions:
        "Read the task. Cut a branch off the latest master and record it on the task with `tasks_update { branchName }`, then transition to in_progress. The open → in_progress transition is gated on branchPresent, so a `task_start` before the branch is recorded returns 422.",
    },
    {
      name: "in_progress",
      label: "In Progress",
      terminal: false,
      agentInstructions:
        'Implement the change. Before submitting for review, run a rigorous review subagent and fix every finding, then open a pull request with `pull_requests_create` — the PR body must include a Test Plan. Transition to review once the PR is open, or use "Mark done" to skip review once the PR is merged. "Release" returns the task to open.',
    },
    {
      name: "review",
      label: "Review",
      terminal: false,
      agentInstructions:
        "A pull request is open for this task. If the reviewer found further issues, transition back to in_progress to rework them. Otherwise merge the PR with `pull_requests_merge`.",
    },
    {
      name: "done",
      label: "Done",
      terminal: true,
      agentInstructions:
        "The task is complete and its pull request is merged. Tagging and deployment are external follow-ups.",
    },
  ],
  transitions: [
    // open → in_progress: a branch must be recorded first.
    {
      from: "open",
      to: "in_progress",
      label: "Start",
      requiredRole: "any",
      requires: ["branchPresent"],
    },
    // in_progress → review: submit work — needs a branch and a PR.
    {
      from: "in_progress",
      to: "review",
      label: "Submit for review",
      requiredRole: "any",
      requires: ["branchPresent", "prPresent"],
    },
    // in_progress → done: skip review — additionally needs a merged PR so
    // the skip path cannot land an unmerged task on `done`.
    {
      from: "in_progress",
      to: "done",
      label: "Mark done",
      requiredRole: "any",
      requires: ["branchPresent", "prPresent", "prMerged"],
    },
    // in_progress → open: release the claim — always allowed.
    {
      from: "in_progress",
      to: "open",
      label: "Release",
      requiredRole: "any",
    },
    // review → in_progress: reviewer found issues — step back, no gate.
    {
      from: "review",
      to: "in_progress",
      label: "Request changes",
      requiredRole: "any",
    },
    // review → done: approve — the PR must be merged first.
    {
      from: "review",
      to: "done",
      label: "Approve",
      requiredRole: "any",
      requires: ["prMerged"],
    },
  ],
  initialState: "open",
};

// ── Template registry ───────────────────────────────────────────────────────
//
// The "AI Coding Agent Pipeline" template (backlog → spec → plan →
// implement → test → review → done) was retired when the state
// vocabulary was locked to {open, in_progress, review, done}. Its 7
// custom state names would now fail `workflowDefinitionSchema` validation.
// The definition is kept above for reference but no longer registered.
// Templates that vary only transitions / gates / labels within the fixed
// state set are valid — `branch-pr-merge-gated` below is the first one.
void codingAgentDefinition;

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    slug: "branch-pr-merge-gated",
    name: "Branch, PR & Merge Gated",
    description:
      "The locked four-state workflow with stricter gates than the default: a branch is required before work starts, a branch and PR before review, and a merged PR before any transition into done.",
    definition: branchPrMergeGatedDefinition,
  },
] as const;

export function findWorkflowTemplate(slug: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.slug === slug);
}
