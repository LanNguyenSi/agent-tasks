# ADR 0012: Post-create label editing is human-only for now

## Status

Accepted

## Context

Labels could previously only be set at task creation (`POST /tasks`,
`createTaskSchema.labels`). Nothing in the product let anyone add or
remove a label afterward, even though `updateTaskSchema` (the human
`PATCH /tasks/:id` lane) already accepted `labels` server-side: the gap
was UI-only on the human side, and there was no path at all on the agent
side: `agentUpdateTaskSchema` (the agent `PATCH /tasks/:id` lane) omits
`labels` entirely, and `task_respec` (backend/src/routes/tasks.ts, the
MCP verb an agent uses to revise a backlog draft it created) is
deliberately not parametrized to touch it either.

This surfaced as friction during the 2026-08-25 batch-27 refinement:
labels like `needs-operator` on agent-created backlog drafts could not be
fixed through any supported path, because neither the UI, the CLI, nor
any agent verb offered a path; only a hand-rolled API call could.

Task 93397e91 scoped fixing the human side only (an editor in
TaskMetaSidebar, against the existing PATCH /tasks/:id write-tier gate)
and asked this ADR to record the decision on the agent side rather than
build it now.

## Decision

Agent-side label editing after task creation is **deferred**, not
implemented, and not decided beyond a recommendation:

- No agent verb (PATCH lane or `task_respec`) gains the ability to set or
  change `labels` post-create as part of this task.
- The recommended shape for a follow-up, if the operator wants one:
  restrict it to the task's own creator (`createdByAgentId` matches the
  caller), and only while the task is still a `backlog` draft, the same
  actor/state restriction `task_respec` already applies to its other
  fields. A general agent-labels-anytime capability was explicitly not
  recommended: labels drive dispatch routing (easy-pick/heavy-pick) and
  filtering, so letting any agent relabel any task at any time is a wider
  surface than the friction case (an agent fixing its own still-unclaimed
  draft) calls for.
- This ADR does not itself change `agentUpdateTaskSchema`, `task_respec`,
  or any other agent-facing code path. Implementing the recommendation
  above is left to a separate, explicitly scoped follow-up task.

## Consequences

- Until a follow-up ships, an agent-created task with a wrong or missing
  label still requires a human (with project write access, via the new
  TaskMetaSidebar editor) or an operator to fix it.
- The human-only UI editor added alongside this ADR does not need to
  distinguish "who created this task" the way the recommended agent path
  would, since project write access is already the correct human-side
  gate (see backend `requireProjectWrite`).
