// Verbatim mirror of the built-in default workflow's agent-facing content:
// backend/src/services/default-workflow.ts's `DEFAULT_STATES` (per-state
// `agentInstructions`) and `DEFAULT_TRANSITIONS` (per-edge `requires` gate
// lists). backend/** is out of scope for the task that added this file
// (rc-v1-C003, docs/response-contract-v1.md), so this module does NOT import
// from or otherwise couple to the backend package — it is a plain,
// hand-copied snapshot kept in sync by convention, not a shared import. See
// "Keep in sync" below.
//
// Why this file exists: rc-v1-C003 stops task_start's DEFAULT response from
// embedding the full per-task workflow object (docs/response-contract-v1.md's
// "no static instructions on every call" rule — see `receiptForStart` in
// receipt.ts). Two consequences of that cut needed a home:
//
//   1. The per-state `agentInstructions` prose (open / in_progress / review /
//      done) is genuinely useful to an agent once per session, not replayed
//      on every task_start call. Per docs/response-contract-v1.md's
//      "Onboarding channels by rate of change" table, content that
//      "effectively never" changes belongs in a channel paid for once per
//      session (`initialize.instructions` + a `workflow_primer` verb), not
//      the per-call receipt. `DEFAULT_WORKFLOW_AGENT_INSTRUCTIONS` is the
//      verbatim, content-preserving handover point for that follow-up
//      (rc-v1-C004, out of scope here) — no information is lost by the cut.
//      It IS wired into task_start's `include: ["instructions"]` path today
//      (see receipt.ts's `deriveStartInstructions`): that is in-scope reuse
//      of task_start's own existing include mechanism, not the new
//      onboarding-channel verb C004 will add.
//   2. The per-edge `requires` gate list (e.g. "in_progress -> review needs
//      branchPresent + prPresent") is exactly the "task-specific gate
//      expectations" rc-v1-C003 surfaces on task_start's default response
//      (see `deriveGateExpectations` in receipt.ts). It is used live, as the
//      fallback for tasks that run the built-in default workflow (no custom
//      Workflow row: `task.workflowId === null`) — the common case per
//      backend/src/services/default-workflow.ts's
//      `resolveEffectiveDefinition`. A task governed by a CUSTOM workflow is
//      never guessed against this table; its gates are only surfaced when
//      the raw `task.workflow` relation happens to be embedded in the
//      response (today: the review-claim branch's re-fetch only — see the
//      KNOWN GAP comment on `deriveGateExpectations`).
//
// Keep in sync: if backend/src/services/default-workflow.ts's
// DEFAULT_STATES or DEFAULT_TRANSITIONS ever change, this file's
// content-equality test (tests/default-workflow.test.ts) will NOT catch the
// drift automatically — there is deliberately no cross-package import, so a
// change to the backend defaults needs a matching manual update here.

export interface DefaultWorkflowState {
  name: string;
  label: string;
  terminal: boolean;
  agentInstructions: string;
}

export const DEFAULT_WORKFLOW_STATES: readonly DefaultWorkflowState[] = [
  {
    name: "open",
    label: "Open",
    terminal: false,
    agentInstructions:
      "Claim this task, create a branch, then transition to in_progress.",
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
] as const;

/** State name -> agentInstructions. Convenience lookup for `receiptForStart`
 *  (include:["instructions"] fallback) and for rc-v1-C004's future
 *  workflow_primer verb. */
export const DEFAULT_WORKFLOW_AGENT_INSTRUCTIONS: Readonly<Record<string, string>> = Object.fromEntries(
  DEFAULT_WORKFLOW_STATES.map((s) => [s.name, s.agentInstructions]),
);

export interface DefaultWorkflowTransition {
  to: string;
  label: string;
  requires?: string[];
}

/** from-state -> the edges leaving it, each with its `requires` gate list
 *  when one applies. Mirrors backend/src/services/default-workflow.ts's
 *  `DEFAULT_TRANSITIONS` verbatim (including the deliberate absence of
 *  `branchPresent` on the `open -> in_progress` edge — see that file's
 *  comment on why: requiring a branch before work even starts would
 *  self-checkmate the default workflow once task_start enforces gates). */
export const DEFAULT_WORKFLOW_TRANSITIONS: Readonly<Record<string, readonly DefaultWorkflowTransition[]>> = {
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
};
