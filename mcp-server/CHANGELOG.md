# Changelog

All notable changes to `@agent-tasks/mcp-server` are documented here.

## 0.3.1

### Added — v2 verb-oriented workflow tools (ADR 0008)

- `task_pickup` — "what should I do next?" Returns next signal, review task, work task, or idle. Hard-limit: one active claim per agent.
- `task_start` — atomic claim + transition + context. For `open` tasks: author-claim and move to `in_progress`. For `review` tasks: take the review claim without status change. Returns `expectedFinishState` (`review` or `done`).
- `task_note` — comment on a task. Currently still requires explicit `taskId`; implicit claim lookup deferred to a later release.
- `task_finish` — polymorphic finish. Work claim: stores `prUrl`/`prNumber`, resolves target state from the workflow (prefers `review`, falls back to `done`), keeps the work claim on the way to review so `request_changes` auto-resumes the author. Review claim: `outcome: approve | request_changes` with signal emission.
- `task_create` — unchanged behavior, re-declared under the v2 namespace for discoverability.
- `task_abandon` — explicit bail-out. Rejected while the task is already in `review` to prevent orphan state.

### Deprecated

All v1 CRUD tools (`tasks_list`, `tasks_get`, `tasks_instructions`, `tasks_claim`, `tasks_release`, `tasks_transition`, `tasks_update`, `signals_poll`, `signals_ack`, `projects_list`, `projects_get`) now carry a `[DEPRECATED, use v2 tools]` prefix in their descriptions. Sunset: 4 weeks after 0.3.1 release.

Backend endpoints backing the new tools: `POST /api/tasks/pickup`, `POST /api/tasks/:id/start`, `POST /api/tasks/:id/finish`, `POST /api/tasks/:id/abandon`. Shipped in backend 0.3.x (PR #150).

## 0.3.0

### Added
- `projects_get` — fetch a single project by slug or id (auto-routes).
- `review_approve` — approve a task in review.
- `review_request_changes` — request changes on a task in review.
- `review_claim` — acquire the single-reviewer lock.
- `review_release` — release the review lock without approving or requesting changes.

Closes CLI-parity gap: MCP-only agents can now drive the review loop end-to-end, including the distinct-reviewer gate introduced in v0.2.0. Same five tools are mirrored in the HTTP MCP peer at `POST /api/mcp`.

## 0.2.0

### Added
- `pull_requests_create` / `pull_requests_merge` / `pull_requests_comment` — GitHub PR operations via delegation.

## 0.1.0

- Initial release. Twelve tools covering projects, tasks, signals, transitions, updates, and comments.
