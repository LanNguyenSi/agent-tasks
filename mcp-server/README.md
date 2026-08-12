# @agent-tasks/mcp-server

MCP server that exposes the [agent-tasks](https://agent-tasks.opentriologue.ai) API
as tools so MCP-capable clients (Claude Code, Cursor, Cline, triologue, …) can
drive the full task lifecycle without writing REST boilerplate.

It is a thin wrapper: all governance rules (confidence gates, preconditions,
review locks, audit trail) are enforced by the agent-tasks backend. The MCP
server just translates tool calls into authenticated HTTP requests.

## Installation

```bash
# once published
npx @agent-tasks/mcp-server

# or build from this workspace
npm run build --workspace=mcp-server
node mcp-server/dist/index.js
```

## Configuration

Two environment variables:

| Variable               | Required | Default                                  |
| ---------------------- | -------- | ---------------------------------------- |
| `AGENT_TASKS_TOKEN`    | yes      | —                                        |
| `AGENT_TASKS_BASE_URL` | no       | `https://agent-tasks.opentriologue.ai`   |

Obtain a token from the agent-tasks UI under **Settings → API Tokens**.
The token scope determines which tools succeed at runtime; tools that require
missing scopes return an API error describing the missing scope.

## Claude Code setup

Register globally for your user so the server is available in every project:

```bash
claude mcp add agent-tasks \
  --scope user \
  --env AGENT_TASKS_TOKEN=at_xxx \
  -- npx -y @agent-tasks/mcp-server
```

Drop `--scope user` if you want it project-local instead. See
`claude mcp add --help` for the full list of scopes and options.

## Tools

**23 tools registered by default.** rc-v1-C007 pruned 14 still-deprecated v1
verbs out of the default registration (`projects_list`, `projects_get`,
`tasks_list`, `tasks_instructions`, `tasks_create`, `tasks_claim`,
`tasks_release`, `tasks_transition`, `tasks_update`, `review_approve`,
`review_request_changes`, `review_claim`, `review_release`,
`pull_requests_comment`); handler code for all 14 is untouched, only their
registration is gated. Set `AGENT_TASKS_MCP_LEGACY=1` in the server
process's environment to register all 37 tools (the full pre-rc-v1-C007
set) for a client still depending on one of the pruned names. Two of the
pruned verbs, `tasks_list` and `projects_list`, are known to have had
active workflow users as of this pruning: `docs/response-contract-v1.md`'s
Motivation section measured `tasks_list` as the third-highest MCP token
consumer in the audited window, and `projects_list` was the only way to
resolve a project slug before `task_create`'s `projectSlug` field and
`project_tasks` shipped. Migrate those callers to the v2 replacements in
the table below, or set the flag while migrating.

The 8 converted v2 write verbs (`task_create`, `task_respec`, `task_finish`,
`task_submit_pr`, `task_note`, `task_merge`, `task_abandon`, and the
`tasks_comment` alias) return a small receipt by default
(`{ ok, task: { id, status? }, ... }`, per `docs/response-contract-v1.md`)
instead of the raw backend body; pass `include: ["task"]` on any of them to
get the full, pre-contract object back for that call. `tasks_get` returns a
summary projection with its own `include` vocabulary, and `signals_poll`
caps and cursors the backend response locally even though it takes no
`include` parameter of its own (see `docs/response-contract-v1.md`'s
read-verb section). Every other default-registered tool still returns the
raw JSON response from the backend as a text block. The 14 pruned, legacy-flag
verbs are exempt from these shape rules entirely (see
`docs/response-contract-v1.md`'s "Legacy-flag exemption"): they exist for
compatibility only, and most still return the raw backend body they always
did (`tasks_create`, for one, still echoes the caller's own `description`).

### Replacement table: pruned v1 verbs → v2 equivalent

Set `AGENT_TASKS_MCP_LEGACY=1` to keep using a verb in this table while you
migrate the caller to its replacement.

| Pruned verb (legacy-only) | v2 replacement |
| --- | --- |
| `projects_list` | no v2 verb enumerates projects: ask the operator for the project's slug or id (the recipe `errors.ts`'s own `unknown_project_slug` teaching error gives), or set `AGENT_TASKS_MCP_LEGACY=1` to keep using this verb. Once you know the project, `project_tasks` browses its tasks and `task_pickup` finds the next piece of work without browsing |
| `projects_get` | `projects_get_effective_gates` for the gate/task-creation fields this verb's "non-deprecated use" needed; `project_tasks` for browsing |
| `tasks_list` | `task_pickup` for the single prioritized item, or `project_tasks` to browse a project |
| `tasks_instructions` | `task_start` with `include: ["instructions"]`, or the on-demand `workflow_primer` verb for the general lifecycle prose |
| `tasks_create` | `task_create` (same behavior, v2 naming, receipt by default) |
| `tasks_claim` | `task_start` (atomic claim + `in_progress` + instructions) |
| `tasks_release` | `task_abandon` (explicit bail-out with an audit trail) |
| `tasks_transition` | `task_start` / `task_finish` (the system owns transitions under v2) |
| `tasks_update` | `task_submit_pr` for branch/PR metadata, or `task_finish { prUrl }` |
| `review_approve` | `task_finish { outcome: "approve" }` after `task_start` on a review task |
| `review_request_changes` | `task_finish { outcome: "request_changes" }` after `task_start` on a review task |
| `review_claim` | `task_start` on a task in `review` status (review-claims polymorphically) |
| `review_release` | `task_abandon` |
| `pull_requests_comment` | `gh pr comment` directly, or `task_note` to leave the note on the task instead |

### Onboarding

| Tool              | Wraps                                        |
| ------------------ | --------------------------------------------- |
| `workflow_primer` | served locally, no backend call              |

`workflow_primer` is the one local-only tool in this package: it returns a
fixed onboarding string (`src/primer.ts`) and never calls the backend. See
`docs/response-contract-v1.md`'s "Onboarding channels by rate of change"
table.

### v2 verbs (task_*)

The canonical agent surface. Prefer these for all new integrations.

| Tool                  | Wraps                                        |
| --------------------- | -------------------------------------------- |
| `task_pickup`         | `POST /api/tasks/pickup`                     |
| `task_start`          | `POST /api/tasks/:id/start`                  |
| `task_note`           | `POST /api/tasks/:id/comments`               |
| `task_finish`         | `POST /api/tasks/:id/finish`                 |
| `task_create`         | `POST /api/projects/:projectId/tasks`        |
| `task_respec`         | `POST /api/tasks/:id/respec`                 |
| `task_abandon`        | `POST /api/tasks/:id/abandon`                |
| `task_submit_pr`      | `POST /api/tasks/:id/submit-pr`              |
| `task_merge`          | `POST /api/tasks/:id/merge`                  |

### Artifacts (v2)

| Tool                    | Wraps                                          |
| ----------------------- | ---------------------------------------------- |
| `task_artifact_create`  | `POST /api/tasks/:id/artifacts`                |
| `task_artifact_list`    | `GET /api/tasks/:id/artifacts`                 |
| `task_artifact_get`     | `GET /api/tasks/:id/artifacts/:artifactId`     |

### Attachments (read-only, v2)

| Tool                    | Wraps                                                       |
| ----------------------- | ----------------------------------------------------------- |
| `task_attachment_list`  | `GET /api/tasks/:id/attachments`                            |
| `task_attachment_get`   | `GET /api/tasks/:id/attachments/:attachmentId/content`      |

### v1-named aliases still registered by default

Naming-convention siblings of the pruned surface below, but each stays
registered by default: `projects_get_effective_gates` and `project_tasks`
were never deprecated, `tasks_get` was upgraded into the read-verb surface
(rc-v1-C006), `tasks_comment` is the receipt-converted `task_note` alias,
`signals_poll` / `signals_ack` are still the only signal-inbox surface, and
`pull_requests_create` / `pull_requests_merge` were never deprecated either.

| Tool                     | Wraps                                                         |
| ------------------------ | ------------------------------------------------------------- |
| `projects_get_effective_gates` | `GET /api/projects/:id/effective-gates`               |
| `project_tasks`          | `GET /api/projects/:id/tasks`                                 |
| `tasks_get`              | `GET /api/tasks/:id`                                          |
| `tasks_comment`          | `POST /api/tasks/:id/comments`                                |
| `signals_poll`           | `GET /api/agent/signals`                                      |
| `signals_ack`            | `POST /api/agent/signals/:id/ack`                             |
| `pull_requests_create`   | `POST /api/github/pull-requests`                              |
| `pull_requests_merge`    | `POST /api/github/pull-requests/:prNumber/merge`              |

### v1 aliases pruned from the default registration (legacy-only)

Set `AGENT_TASKS_MCP_LEGACY=1` to register these 14. See the replacement
table above for their v2 equivalents.

| Tool                     | Wraps                                                         |
| ------------------------ | ------------------------------------------------------------- |
| `projects_list`          | `GET /api/projects/available`                                 |
| `projects_get`           | `GET /api/projects/:slugOrId` (or `/by-slug/:slug`)           |
| `tasks_list`             | `GET /api/tasks/claimable`                                    |
| `tasks_instructions`     | `GET /api/tasks/:id/instructions`                             |
| `tasks_create`           | `POST /api/projects/:projectId/tasks`                         |
| `tasks_claim`            | `POST /api/tasks/:id/claim`                                   |
| `tasks_release`          | `POST /api/tasks/:id/release`                                 |
| `tasks_transition`       | `POST /api/tasks/:id/transition`                              |
| `tasks_update`           | `PATCH /api/tasks/:id`                                        |
| `review_approve`         | `POST /api/tasks/:id/review` (`action: approve`)              |
| `review_request_changes` | `POST /api/tasks/:id/review` (`action: request_changes`)      |
| `review_claim`           | `POST /api/tasks/:id/review/claim`                            |
| `review_release`         | `POST /api/tasks/:id/review/release`                          |
| `pull_requests_comment`  | `POST /api/github/pull-requests/:prNumber/comments`           |

### GitHub PR tools — delegation required

The three `pull_requests_*` tools dispatch through a team member's GitHub
token (the "delegation user"), not through the agent token itself. Before
these tools can succeed:

1. A team member must connect their GitHub account (**Settings → GitHub**)
2. The same member must enable the relevant consent flag(s) in
   **Settings → Agent Permissions** (`allowAgentPrCreate`,
   `allowAgentPrMerge`, `allowAgentPrComment`)

Without consent, the backend returns `403` with a message naming which
consent flag is missing. All three tools are **agent-only** — human
sessions cannot call them; use the regular `gh` CLI or the GitHub web UI
for human-authored PRs.

On success, `pull_requests_create` patches the task's `branchName`,
`prUrl`, and `prNumber` server-side, and `pull_requests_merge` transitions
the task to `done`. No extra `tasks_update` / `tasks_transition` call
needed — one tool call drives both the GitHub action and the task-state
side effect.

`pull_requests_merge` also enforces the review gate: the task must be in
`review` state (or already `done` for an idempotent re-try), otherwise
the endpoint returns 403. If the project has `requireDistinctReviewer`
enabled, the merge caller must not be the task's claimant — same rule
the `/transition` and `/review` endpoints apply. To bypass the gate,
admins force-transition to `done` via `tasks_transition` with `force=true`
first (set `AGENT_TASKS_MCP_LEGACY=1`, `tasks_transition` is pruned from
the default registration), then call this tool (which accepts `done` as a
valid entry state).

## Transport

This package ships **stdio** only. It is the recommended path for
local Claude Code / Cursor / Cline integrations — one `npx` command,
no running server to maintain, no network hop.

### Remote clients: use the backend's `/api/mcp` endpoint instead

Remote MCP clients that speak HTTP + JSON-RPC (e.g. Triologue's
`mcpBridge.ts`) cannot drive a stdio child process across a network
boundary. For those, the agent-tasks backend exposes **21 tools**
over HTTP at `POST /api/mcp`:

```bash
# Example: discover tools on a remote gateway
curl -X POST https://agent-tasks.opentriologue.ai/api/mcp \
  -H "Authorization: Bearer <agent_token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- Stateless Streamable HTTP (no session ID, one round-trip per
  request)
- Same Bearer auth as the rest of the agent-tasks REST API
- The HTTP endpoint is a **hand-maintained subset** of the 37 tools this
  stdio package can expose (23 registered by default, the remaining 14
  legacy-only under `AGENT_TASKS_MCP_LEGACY=1`, see "Tools" above). It
  covers the full v1 alias surface (projects_*, tasks_*, review_*,
  signals_*, pull_requests_*) but does **not** yet include the v2 verbs
  (task_pickup / task_start /
  task_finish / task_respec / etc.), the local-only `workflow_primer`
  tool, artifact tools (task_artifact_*), attachment tools
  (task_attachment_*), or project_tasks. The code comment in
  `backend/src/routes/mcp.ts` documents this gap explicitly.
- GET / DELETE on `/api/mcp` return 405 with `Allow: POST`

Pick stdio (this package) for local agents with full v2 tool access;
pick `/api/mcp` for remote / server-side consumers that only need
the v1 surface.

## Development

```bash
npm install
npm run dev --workspace=mcp-server        # tsx watch
npm run build --workspace=mcp-server      # tsc -> dist/
npm run typecheck --workspace=mcp-server
```
