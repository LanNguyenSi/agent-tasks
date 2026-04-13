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

| Tool                 | Wraps                                        |
| -------------------- | -------------------------------------------- |
| `projects_list`      | `GET /api/projects/available`                |
| `tasks_list`         | `GET /api/tasks/claimable`                   |
| `tasks_get`          | `GET /api/tasks/:id`                         |
| `tasks_instructions` | `GET /api/tasks/:id/instructions`            |
| `tasks_create`       | `POST /api/projects/:projectId/tasks`        |
| `tasks_claim`        | `POST /api/tasks/:id/claim`                  |
| `tasks_release`      | `POST /api/tasks/:id/release`                |
| `tasks_transition`   | `POST /api/tasks/:id/transition`             |
| `tasks_update`       | `PATCH /api/tasks/:id`                       |
| `tasks_comment`      | `POST /api/tasks/:id/comments`               |
| `signals_poll`       | `GET /api/agent/signals`                     |
| `signals_ack`        | `POST /api/agent/signals/:id/ack`            |

All tools return the raw JSON response from the backend as a text block.

## Transport

Stdio only. A remote Streamable-HTTP variant that preserves the same
governance semantics is tracked under the
[Zero-Setup MCP Bridge task](https://agent-tasks.opentriologue.ai/) in the
`agent-tasks` project.

## Development

```bash
npm install
npm run dev --workspace=mcp-server        # tsx watch
npm run build --workspace=mcp-server      # tsc -> dist/
npm run typecheck --workspace=mcp-server
```
