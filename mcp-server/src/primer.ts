// Onboarding channels split by rate of change, per docs/response-contract-v1.md's
// "Onboarding channels by rate of change" table. System / lifecycle / verb-order
// knowledge "effectively never" changes, so it is moved out of the per-call
// task_start receipt (see receipt.ts's receiptForStart and rc-v1-C003, which cut
// this exact content out of every task_start response) into two channels paid
// for at most once per session:
//
//   1. HANDSHAKE_PRIMER: sent once, as the MCP `initialize.instructions` field
//      (see server.ts's `new McpServer(..., { instructions: HANDSHAKE_PRIMER })`).
//      Hard budget: <= 2000 chars (the contract's own "~300-500 tokens" target).
//      tests/primer.test.ts asserts the exact measured size and, via an
//      InMemoryTransport client, that the handshake actually carries the text.
//   2. WORKFLOW_PRIMER: returned on demand by the parameterless `workflow_primer`
//      tool (tools.ts). No per-call budget: it is the fuller reference a caller
//      pulls once, not something replayed automatically on every call.
//
// Both reuse DEFAULT_WORKFLOW_STATES (default-workflow.ts) verbatim for the
// per-state lifecycle prose rather than holding a third hand-copied version of
// that text (backend's DEFAULT_STATES and this package's own mirror already
// being the first two; see default-workflow.ts's file header). Both primers
// describe the CURRENT verb surface and CURRENT error behavior: the
// structured teaching-error shape (code/message/recipe/allowedNext) from
// docs/response-contract-v1.md's "Error shape (block tier)" section is
// implemented (rc-v1-C005, see errors.ts and tools.ts's wrap()) and
// WORKFLOW_PRIMER's "## Errors" section below describes the shape actually
// emitted today, not a planned future one.
//
// No per-task data lives here (that is task_pickup's and task_start's job), and
// no em dashes in the exported prose (repo convention).

import { DEFAULT_WORKFLOW_STATES } from "./default-workflow.js";

// Derived, not hand-typed, so the state-order summary in HANDSHAKE_PRIMER can
// never silently drift from the actual default workflow's state list.
const STATE_ORDER = DEFAULT_WORKFLOW_STATES.map((s) => s.name).join(" -> ");

// Each line reuses `agentInstructions` verbatim (no paraphrase, so no separate
// consistency assert is needed against DEFAULT_WORKFLOW_STATES: a change there
// flows straight through here on the next build).
const LIFECYCLE_DETAIL = DEFAULT_WORKFLOW_STATES.map(
  (s) => `- ${s.label} (${s.name}): ${s.agentInstructions}`,
).join("\n");

/**
 * Sent once per session as the MCP `initialize.instructions` field (see
 * server.ts). System / lifecycle / verb-order knowledge only: no per-task
 * data, no receipt/error detail (those live in the receipt itself and in
 * `workflow_primer`, respectively). Hard budget: <= 2000 chars.
 */
export const HANDSHAKE_PRIMER = `agent-tasks is a task tracker for human-agent collaboration: task state changes are enforced server-side (claim gates, transition preconditions, review, audited overrides), not left to prompt discipline.

Task lifecycle: ${STATE_ORDER}. Canonical verb order: task_pickup (find work) -> task_start (claim it) -> implement the change, run \`gh pr create\` -> task_submit_pr (record branch/PR metadata) -> task_finish (advance the task).

Claim model: only one active claim is held per caller at a time. task_pickup and task_start fail with 409 if you already hold one; call task_finish or task_abandon on the current task first.

Governance: every transition and admin override is enforced and audited server-side by this project's workflow, not by convention.

The converted v2 write verbs (task_create, task_respec, task_finish, task_submit_pr, task_note, task_merge, task_abandon, tasks_comment) return small receipts by default and accept include:["task"]; task_pickup returns the full spec and task_start a receipt plus a small slice; tasks_get returns a summary by default and accepts include:["description", "comments", "artifacts", "task"]; signals_poll caps and cursors the backend response locally even though it takes no include parameter; every other tool returns the raw backend body and ignores include. Call workflow_primer (no arguments) for full lifecycle detail, include semantics, and today's error behavior; call projects_get_effective_gates before task_create or task_submit_pr to see this project's actual gates.`;

/**
 * Returned on demand by the parameterless `workflow_primer` tool
 * (tools.ts). The fuller companion to HANDSHAKE_PRIMER: per-state lifecycle
 * detail, canonical flows, the claim model, receipt/include defaults per
 * verb, and today's error behavior. No per-task data and no budget cap (it
 * is pulled once by a caller who needs it, not replayed automatically).
 */
export const WORKFLOW_PRIMER = `agent-tasks workflow primer. See also docs/response-contract-v1.md, the normative contract this text summarizes.

## Lifecycle
Per-state agent guidance from this project's own workflow when it defines one, or the built-in default below otherwise. This prose predates the v2 verbs and describes intent, not a literal call sequence; the canonical flows below are the current call sequence and supersede it.

${LIFECYCLE_DETAIL}

## Canonical flows
Work: task_pickup -> task_start (author-claim, open -> in_progress) -> implement the change, run \`gh pr create\` -> task_submit_pr (records branchName/prUrl/prNumber) -> task_finish (advances to review or done, depending on the workflow).
Review: task_pickup (kind: "review") -> task_start (review-claim, no state change) -> task_finish { outcome: "approve" | "request_changes" }. approve moves the task to done; request_changes returns it to in_progress and keeps the work claim for the original author.

## Claim model
task_start fails with 409 if you already hold an active claim on another task. task_pickup fails with the same 409 if you hold any active claim, but it never claims anything itself: it only returns a candidate, so a review candidate still needs task_start to review-claim it. task_finish, task_submit_pr, and task_abandon require that same claim, not just a taskId, and fail with 403 if you do not hold it.

## Receipt defaults (no include passed)
- task_pickup: the full task spec, without comments (the one write-verb exception; delivering the spec is its purpose).
- task_start: a receipt plus a small per-task slice (inferredTaskType, expectedFinishState, gateExpectations, gateExpectationsSource when assumed). Not the full task.
- task_create, task_respec, task_finish, task_submit_pr, task_merge, task_abandon, task_note, tasks_comment: a small receipt only, shaped { ok, task: { id, status? }, confidence?, deviations?, next? }. confidence is set only by task_create and task_respec (the score just computed for that call); every other verb in this list omits it. Fields you sent are never echoed back; deviations appear only when something needs your attention.

Pass include:["task"] on any of the verbs above to get the full, pre-contract object back instead (recovery path after context loss, or when you need the whole object in one call). task_start additionally accepts include:["description" | "instructions" | "comments"] to add back one field at a time, without paying for the rest.

## Errors
A call that cannot proceed returns an MCP tool error (isError: true) whose text is the JSON teaching-error shape \`{ ok: false, error: { code, message, recipe, allowedNext, detail? } }\`, printed the same way every other tool result is (two-space-indented JSON), never a bare status or raw backend string. \`code\` identifies the failure, \`recipe\` names the concrete corrective call, and \`allowedNext\` lists only verb names you can call immediately (a strict, machine-checkable counterpart to a receipt's free-form \`next[]\`); \`detail\` carries structured extras for the codes that have them. Known traps and their recipe: \`not_claimed\` (403, calling task_finish, task_submit_pr, or task_abandon without holding the claim, call task_start first); \`already_claimed\` (409, a claim wall on task_pickup or task_start, call task_finish or task_abandon on your current task first); \`precondition_failed\` (422, an unmet branchPresent/prPresent/ciGreen/prMerged gate, \`detail.failed\` lists each failing rule individually, call task_submit_pr first when a branch or PR gate is the one failing); \`cross_repo_pr_rejected\` (400, task_submit_pr's prUrl points outside the project's own repo); \`pr_author_mismatch\` (403, that PR was not authored by the delegation user); \`force_admin_only\` (403, the admin-only force-transition escape hatch used as a non-admin, no self-service fix exists); \`respec_conflict\` (409, task_respec on a task that is claimed or not open); \`low_confidence\` (422, task_start's pre-claim confidence gate rejected the claim, detail carries score/threshold/missing[]/totalMissing, call task_respec to raise the score); \`result_not_plain_string\` (task_finish's own result rejected before any request is sent, because it looks XML- or JSON-wrapped instead of plain prose); \`project_addressing_conflict\` (task_create's projectId/projectSlug pair rejected client-side before any request is sent, because exactly one of the two is required, whether both were sent or neither was, resubmit with exactly one, or ask the operator which project to use if you do not yet know it); \`unknown_project_slug\` (task_create's or project_tasks's projectSlug/project value did not resolve to any project on a fresh lookup, ask the operator for the correct slug or id). Any other backend error still degrades to the same shape instead of leaking raw text: a code derived from its HTTP status, the backend's own message passed through, a recipe pointing at workflow_primer, and, when the backend sent a structured details payload, a clamped copy of it in detail.

## Project rules
Call projects_get_effective_gates before task_create or task_submit_pr to see which gates are active on this project and why, instead of discovering them by tripping a 4xx.`;
