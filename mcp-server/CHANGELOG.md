# Changelog

All notable changes to `@agent-tasks/mcp-server` are documented here.

## 0.6.1

### Changed

- `task_finish` tool description now states the claim precondition explicitly: the caller must hold an active work or review claim on the specific task, and the claim of any prior task that was just finished does not carry over. The note also disambiguates `task_pickup` (discovery-only, does not claim) from `task_start` (the actual claim verb). Description-only release, runtime behaviour unchanged. Backend route returns a matching recovery hint in the 403 body (agent-tasks PR #253).

## 0.6.0

### Changed

- `tasks_instructions` tool description now names the ADR-0011 confidence
  surface that the backend response carries: `confidence.inferredTaskType`
  (`bugfix | feature | refactoring | security | migration | docs`), set when
  the task was created from a typed preset. The new field is the bridge to
  Milestone 2 per-type required-signals and per-type thresholds. The tool's
  inputs and runtime behaviour are unchanged; this is a description-only
  release so MCP catalogues regenerate against the new shape hint.

## 0.5.0

### Added

- `project_tasks` verb. Browse tasks scoped to a single project; answers the
  "what is open in project X?" question that `task_pickup` (single item) and
  the deprecated `tasks_list` (global claimable slice) cannot. Accepts slug
  or UUID for `project` and resolves slugs server-side. Filter surface:
  `status` (single or array), `priority`, `labels`, `unclaimed`, `limit`.
  Wraps `GET /api/projects/:id/tasks`.

### Changed

- `tasks_list` deprecation note now points at `project_tasks` for
  browse-style use cases.

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
