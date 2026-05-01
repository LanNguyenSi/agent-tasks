# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-04-27

Adds the v2 verb API surface (mirroring the agent-tasks MCP tools
`task_pickup` / `task_start` / `task_finish` / `task_abandon` /
`task_submit_pr`) plus project gate discovery. Old v1 subcommands keep
working for now but emit a one-line stderr deprecation warning per process.

### Added

- `pickup` — `POST /api/tasks/pickup`. Polymorphic inbox; returns one of
  `{kind: signal | review | work | idle}` in a single call. Replaces
  polling `tasks list` plus separate `signals` checks.
- `tasks start <task-id>` — `POST /api/tasks/:id/start`. Atomic claim +
  transition, polymorphic on task state. Returns the task, project, and
  `expectedFinishState` so callers know what `tasks finish` will target.
- `tasks finish <task-id>` — `POST /api/tasks/:id/finish`. Polymorphic on
  the claim held: work-claim takes `--result` / `--pr-url`; review-claim
  takes `--outcome approve|request_changes` / `--result`. Both honor
  `--auto-merge` and `--merge-method`.
- `tasks abandon <task-id>` — `POST /api/tasks/:id/abandon`. Releases work
  OR review claim and resets state.
- `tasks submit-pr <task-id>` — `POST /api/tasks/:id/submit-pr`. Writes
  `--branch` / `--pr-url` / `--pr-number` onto a work-claimed task without
  finishing — needed by projects that gate `task_finish` on
  `branchPresent`.
- `projects effective-gates <slug-or-id>` —
  `GET /api/projects/:id/effective-gates`. Lists which workflow gates apply
  to a project and why. Resolves slugs locally before hitting the
  UUID-only endpoint.

### Deprecated

- `tasks claim` → use `tasks start`
- `tasks release` → use `tasks abandon`
- `tasks status <id> <state>` → use `tasks start` / `tasks finish`
- `review approve` → use `tasks finish --outcome approve`
- `review request-changes` → use `tasks finish --outcome request_changes`
- `review claim` → use `tasks start` (polymorphic on review-state tasks)
- `review release` → use `tasks abandon`

Each deprecated command emits one stderr warning the first time it runs in
a process, then stays quiet. Wire-format unchanged — pre-0.3.0 scripts
keep working.

### Notes

- Pre-existing test `loadConfig > exits if no endpoint configured` fails on
  developer machines that have `~/.agent-tasks.json` configured because
  the test deletes env vars but doesn't isolate from the config-file
  fallback. Untouched by this release; tracked separately.

## [0.2.0] - 2026-04-13

Fills the v0.1.0 coverage gap against the agent-tasks API so users don't
have to reach for `curl`. Every endpoint the backend exposes is now a CLI
command.

### Added

- `tasks create <project-slug-or-id>` — wraps `POST /api/projects/:id/tasks`.
  Accepts slug or UUID; supports `--title` (required), `--description`,
  `--priority`, `--workflow`, `--due-at`, `--external-ref`, and repeatable
  `--label`. Priority is validated before the slug resolve so typos fail fast.
- `tasks get <task-id>` — `GET /api/tasks/:id` without the instructions overhead.
- `tasks release <task-id>` — releases a claimed task back to the pool.
- `projects list` — list projects visible to the current token.
- `projects get <slug-or-id>` — fetch a single project by slug or UUID.
- `github pr create` — delegate PR creation via the backend
  (`POST /api/github/pull-requests`). A team member with `allowAgentPrCreate`
  consent acts on the agent's behalf.
- `github pr merge <pr-number>` — delegate merge via the backend with
  `--method merge|squash|rebase` (default: `squash`).
- `github pr comment <pr-number> <body>` — delegate PR comment via the backend.

### Security

- Bumped `vitest` devDep `^2.1.0` → `^3.2.4` to clear two medium Dependabot
  alerts in the transitive chain: GHSA-4w7w-66w2-5vf9 (vite `.map` path
  traversal) and GHSA-67mh-4wv8-2f99 (esbuild dev-server CORS). Dev-only, no
  runtime impact.

## [0.1.0] - 2026-04-13

Initial public release of agent-tasks-cli — a standalone CLI client for
local AI agents.

### Added

- `tasks list` — list tasks with optional status and project filters
- `tasks claim <task-id>` — claim a task for the current agent
- `tasks status <task-id> <state>` — transition a task to a new workflow state
  (valid states: `open`, `in_progress`, `review`, `done`)
- `tasks update <task-id>` — update `--branch`, `--pr-url`, `--pr-number`, etc.
- `tasks comment <task-id> <message>` — post a comment on a task
- `tasks instructions <task-id>` — fetch the authoritative agent instructions
  (state, allowed transitions, required fields, confidence score)
- `review approve <task-id>` — approve a task with optional `-c <comment>`
- `review request-changes <task-id>` — request changes on a task
- `review claim <task-id>` — acquire the single-reviewer lock
- `review release <task-id>` — release the review lock
- `signals` — poll the signal inbox for pending signals
- `signals ack <signal-id>` — acknowledge a signal
- Configuration via env vars (`AGENT_TASKS_ENDPOINT`, `AGENT_TASKS_TOKEN`) or
  `~/.agent-tasks.json` / `~/.config/agent-tasks/config.json`
- `--json` and `--quiet` output modes across list commands
- Colored terminal output with status formatting
- CI pipeline (GitHub Actions): typecheck, build, test
