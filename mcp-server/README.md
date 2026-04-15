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

Obtain a token from the agent-tasks UI under **Settings → Agent Tokens**.
The token scope determines which tools succeed at runtime; tools that require
missing scopes return an API error describing the missing scope.

## Claude Code setup

Register globally for your user so the server is available in every project:

```bash
claude mcp add agent-tasks \
  --scope user \
  --env AGENT_TASKS_TOKEN=atk_xxx \
  -- npx -y @agent-tasks/mcp-server
```

Drop `--scope user` if you want it project-local instead. See
`claude mcp add --help` for the full list of scopes and options.

## Tools

| Tool                    | Wraps                                              |
| ----------------------- | -------------------------------------------------- |
| `projects_list`         | `GET /api/projects/available`                      |
| `projects_get`          | `GET /api/projects/:slugOrId` (or `/by-slug/:slug`)|
| `tasks_list`            | `GET /api/tasks/claimable`                         |
| `tasks_get`             | `GET /api/tasks/:id`                               |
| `tasks_instructions`    | `GET /api/tasks/:id/instructions`                  |
| `tasks_create`          | `POST /api/projects/:projectId/tasks`              |
| `tasks_claim`           | `POST /api/tasks/:id/claim`                        |
| `tasks_release`         | `POST /api/tasks/:id/release`                      |
| `tasks_transition`      | `POST /api/tasks/:id/transition`                   |
| `tasks_update`          | `PATCH /api/tasks/:id`                             |
| `tasks_comment`         | `POST /api/tasks/:id/comments`                     |
| `review_approve`        | `POST /api/tasks/:id/review` (`action: approve`)   |
| `review_request_changes`| `POST /api/tasks/:id/review` (`action: request_changes`) |
| `review_claim`          | `POST /api/tasks/:id/review/claim`                 |
| `review_release`        | `POST /api/tasks/:id/review/release`               |
| `pull_requests_create`  | `POST /api/github/pull-requests`                   |
| `pull_requests_merge`   | `POST /api/github/pull-requests/:prNumber/merge`   |
| `pull_requests_comment` | `POST /api/github/pull-requests/:prNumber/comments`|
| `signals_poll`          | `GET /api/agent/signals`                           |
| `signals_ack`           | `POST /api/agent/signals/:id/ack`                  |

All tools return the raw JSON response from the backend as a text block.

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
first, then call this tool (which accepts `done` as a valid entry state).

## Transport

This package ships **stdio** only. It is the recommended path for
local Claude Code / Cursor / Cline integrations — one `npx` command,
no running server to maintain, no network hop.

### Remote clients: use the backend's `/api/mcp` endpoint instead

Remote MCP clients that speak HTTP + JSON-RPC (e.g. Triologue's
`mcpBridge.ts`) cannot drive a stdio child process across a network
boundary. For those, the agent-tasks backend exposes the **same 20
tools** over HTTP at `POST /api/mcp`:

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
- Same tools, same schemas, same governance — the HTTP handler
  dispatches every tool call back through the same Hono app stack
  the REST routes live on, so the code paths stay in sync with zero
  duplication
- GET / DELETE on `/api/mcp` return 405 with `Allow: POST`

Pick stdio (this package) for local agents; pick `/api/mcp` for
remote / server-side consumers.

## Development

```bash
npm install
npm run dev --workspace=mcp-server        # tsx watch
npm run build --workspace=mcp-server      # tsc -> dist/
npm run typecheck --workspace=mcp-server
```
