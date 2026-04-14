# agent-tasks

**Enforced workflows for human-agent delivery.**

Let humans and AI agents collaborate on tasks with explicit claim gates, transition preconditions, review signals, audit trails, and team-scoped permissions.

> Most tools help agents manage tasks. `agent-tasks` helps teams control _when_ agent work may actually move forward.

**Live:** [agent-tasks.opentriologue.ai](https://agent-tasks.opentriologue.ai/)

## Why this exists

AI agents are fast. Speed without workflow control is plausible chaos — tasks claimed on vague descriptions, transitions that skip review, hand-offs nobody can audit.

Real teams need enforceable rules for:

- **when** a task is ready to claim
- **when** it may change state
- **when** human review is required
- **who** may override what
- **how** hand-offs stay auditable

## Core differentiators

- **Claim gates** — confidence-scored tasks (deterministic, no LLM). Agents are blocked from claiming vague work via `POST /api/tasks/:id/claim → 422` until the description reaches the project's threshold. Humans see the same signal as a warning.
- **Declarative transition preconditions** — per-transition rules like `branchPresent`, `prPresent`, `prMerged`, `ciGreen` are defined in the workflow schema and [enforced server-side](docs/workflow-preconditions.md). A task literally cannot advance to `review` without a PR if the workflow says so.
- **Server-side enforcement, not prompt suggestion** — every rule is checked by the API, not by the agent's prompt. Admin override exists, but it emits an audit row so nothing is silently bypassed.
- **Durable human-agent signal inbox** — pull-based, no push-dependency. Agents poll for review requests, assignment changes, and approval signals; human acknowledgement is explicit and logged.
- **Auditability** — every claim, transition, update, and override is recorded with actor and timestamp, scoped per project and per task.

## What you get

- **Configurable workflows** — in-browser editor for states, transitions, required roles, per-state agent instructions, reachability analysis, client + server validation, admin-gated Cmd/Ctrl+S save.
- **Confidence scoring and description quality analysis** — heuristic "bullshit meter" measuring information density, structure markers, and concreteness (not character count), with reusable template presets (Bug Fix, Feature, Refactoring).
- **Task templates and dependencies** — structured fields (goal, acceptance criteria, context, constraints) plus block/blocked-by relationships with cycle detection.
- **Agent API** — team-scoped Bearer tokens with granular scopes. Full OpenAPI/Swagger docs at `/docs`.
- **GitHub integration** — repo sync, branch/PR linking, plus PR delegation (agents create, merge, and comment on PRs via the API using delegated human credentials with explicit consent).
- **Board + list views** — kanban columns, filters, search, pagination, priority sorting.

## Platform & enterprise

- **OIDC SSO** — team-scoped OpenID Connect login alongside email/GitHub. PKCE + JWKS verification, team-per-IdP config, email-domain discovery on the login page. Admin config is gated by a dedicated `sso:admin` API token, not by session cookies. See [docs/enterprise-sso.md](docs/enterprise-sso.md).
- **CSV/Excel import** — batch task import with auto-detection of Jira column headers (EN + DE).
- **GitHub webhooks (optional)** — PR lifecycle sync, automated timeline entries, PR binding, auto-transitions on review/merge. Entirely opt-in; everything works manually without them.

## Stack

- **Frontend:** Next.js 15 (React 19, App Router)
- **Backend:** Hono + Node.js
- **Database:** PostgreSQL + Prisma
- **Auth:** Email/Password + optional GitHub connect + team-scoped OIDC SSO (humans) + API tokens with scopes (agents)

## Monorepo Structure

```
agent-tasks/
├── backend/          # Hono API (port 3001)
│   ├── src/
│   │   ├── routes/   # HTTP handlers
│   │   ├── services/ # Domain / authz logic
│   │   ├── repositories/ # Persistence access
│   │   ├── middleware/ # Auth, error handling
│   │   └── config/   # Env config
│   └── prisma/       # Schema + migrations
├── frontend/         # Next.js app (port 3000)
│   └── src/
│       ├── app/      # App Router pages
│       ├── lib/      # API client
├── mcp-server/       # @agent-tasks/mcp-server — stdio MCP wrapper for agents
│   └── src/
│       ├── client.ts # Bearer-auth HTTP client for the REST API
│       └── tools.ts  # Tool definitions (projects, tasks, signals)
├── docs/             # Specs (from planforge)
└── .github/          # CI workflows
```

## Development

```bash
# Copy env
cp .env.example .env

# Install + setup
make install
make setup

# Database
make db-push

# Dev servers (local)
make dev
```

Alternative local run in separate terminals:

```bash
make dev-backend
make dev-frontend
```

### Docker Development

```bash
# Start db + backend + frontend
make docker-up

# Stop services
make docker-down
```

## Useful Make Targets

- `make install` installs workspace dependencies.
- `make setup` prepares `.env` and generates Prisma client.
- `make db-push` syncs Prisma schema to the configured database.
- `make dev` starts backend and frontend locally.
- `make dev-docker` starts full stack in Docker.
- `make ci` runs typecheck, tests, and build.
- `make hooks` installs pre-commit hooks.

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Landing page |
| `/auth` | Login / Register |
| `/onboarding` | First team creation |
| `/teams` | Project management, GitHub sync |
| `/dashboard` | Board + list view, task CRUD |
| `/projects/workflows` | Workflow editor (states, transitions, agent instructions) |
| `/settings` | Account, GitHub connection, API tokens |
| `/docs` | Interactive Swagger UI (served by backend) |

## Confidence Scoring

Every task gets a deterministic confidence score (0–100%) that measures whether a task has enough information for an agent to work on it. Agents are blocked from claiming low-confidence tasks via the API (422), humans see a warning in the UI.

**How it works — no LLM, pure heuristics:**

| Signal | What it measures |
|--------|-----------------|
| Title | Is there a title at all? |
| Description quality | Length (diminishing returns), information density (unique content words vs stop words, EN+DE), structure (lists, sections, line breaks), concreteness (file paths, URLs, code refs, numbers) |
| Template fields | Goal, acceptance criteria, context, constraints — only counted when enabled per project |

The score normalizes against what's configured: a project without templates can still reach 100% with a well-written description. A project with all template fields enabled requires more structured input.

**Template presets** let teams define reusable starting points (Bug Fix, Feature, Refactoring) that pre-fill description and template fields with actionable placeholder text. One click, then replace the `[brackets]`.

```
GET /api/tasks/{id}/instructions → { ..., confidence: { score, missing, threshold } }
POST /api/tasks/{id}/claim       → 422 if score < threshold (agents only, bypass with ?force=true)
```

## API Highlights

- Swagger UI: `GET /docs` (alias: `/api/docs`)
- OpenAPI JSON: `GET /api/openapi.json`

```bash
# Health
GET  /api/health

# Auth (humans)
POST /api/auth/register
POST /api/auth/login
GET  /api/auth/me
POST /api/auth/logout
GET  /api/auth/github
GET  /api/auth/github/connect
GET  /api/auth/github/callback

# Teams (humans)
GET  /api/teams
POST /api/teams
GET  /api/teams/:id
POST /api/teams/:id/members
POST /api/teams/:id/sync          # GitHub repo sync

# Agent Tokens (team admins)
GET  /api/agent-tokens?teamId=
POST /api/agent-tokens
POST /api/agent-tokens/:id/revoke

# Projects
GET  /api/projects/available       # Agent discovery (recommended)
GET  /api/projects?teamId=         # Full project list
GET  /api/projects/:id
DELETE /api/projects/:id           # Humans only

# Tasks
GET  /api/projects/:id/tasks
POST /api/projects/:id/tasks
GET  /api/tasks/claimable          # Open + unclaimed
GET  /api/tasks/:id
PATCH /api/tasks/:id               # Agents: branchName/prUrl/prNumber/result only
DELETE /api/tasks/:id              # Humans only
POST /api/tasks/:id/claim
POST /api/tasks/:id/release
POST /api/tasks/:id/transition     # Validated against workflow if assigned
GET  /api/tasks/:id/instructions   # Agent context: state, instructions, allowed transitions

# Workflows
GET  /api/projects/:id/workflows
POST /api/projects/:id/workflows   # Humans only
PUT  /api/workflows/:id            # Humans only

# Task Dependencies
POST /api/tasks/:id/dependencies         # Add blocker
DELETE /api/tasks/:id/dependencies/:blockerTaskId  # Remove blocker

# Task Import
POST /api/projects/:id/tasks/import      # Batch CSV/Excel import

# GitHub PR Delegation (agents)
POST /api/github/pull-requests           # Create PR
POST /api/github/pull-requests/:prNumber/merge    # Merge PR
POST /api/github/pull-requests/:prNumber/comments # Comment on PR

# Agent Signals
GET  /api/agent/signals                  # Poll inbox
POST /api/agent/signals/:id/ack          # Acknowledge signal

# Boards (humans)
GET  /api/projects/:id/boards
POST /api/projects/:id/boards

# Audit
GET  /api/projects/:id/audit
GET  /api/tasks/:id/audit
```

## Agent Auth

Agents authenticate with Bearer tokens and scopes:

```bash
curl -H "Authorization: Bearer at_..." \
     -H "Content-Type: application/json" \
     -d '{"title": "Fix bug #42", "priority": "HIGH"}' \
     http://localhost:3001/api/projects/{id}/tasks
```

Available scopes: `tasks:read` `tasks:create` `tasks:claim` `tasks:comment` `tasks:transition` `tasks:update` `projects:read` `boards:read`

### Getting started

**The fast path:** open the dashboard, pick your project, click **Connect agent** in the toolbar. A modal generates a token and gives you a copy-paste-ready install snippet for Claude Code (MCP), the CLI, or raw curl — pick the tab that matches your client, paste, done. No manual token round-trip through Settings.

For a written walkthrough or other clients, see the **[getting started guide](docs/getting-started.md)**. For detailed API examples, see the [agent workflow guide](docs/agent-workflow.md).

## GitHub Webhooks (optional)

**[Full setup guide →](docs/webhook-setup.md)** · [Automation policy →](docs/review-automation-policy.md) · [Deploy/verify strategy →](docs/deploy-verify-strategy.md)

## Agent Workflow

Agents discover tasks via `/api/tasks/claimable`, claim them, work on a branch, create a PR, update the task with PR metadata, and submit for review. If webhooks are configured, merging the PR auto-transitions the task to `done`.

**[Getting started guide →](docs/getting-started.md)** · [Agent workflow (curl) →](docs/agent-workflow.md)

### CLI Client

The [agent-tasks-cli](https://github.com/LanNguyenSi/agent-tasks-cli) provides a standalone CLI for local agents — no custom integration code needed.

```bash
npm install -g agent-tasks-cli
export AGENT_TASKS_ENDPOINT=https://agent-tasks.opentriologue.ai
export AGENT_TASKS_TOKEN=at_...

agent-tasks signals              # check inbox
agent-tasks tasks list           # find work
agent-tasks tasks claim <id>     # claim a task
agent-tasks tasks status <id> review  # submit for review
```

## Roadmap

- [x] GitHub webhook integration (PR lifecycle, review events)
- [x] Agent signal inbox (pull-based, durable signals)
- [x] Review orchestration (review lock, assignee preservation)
- [x] CLI client ([agent-tasks-cli](https://github.com/LanNguyenSi/agent-tasks-cli))
- [x] Task dependencies (block/blocked-by with cycle detection)
- [x] GitHub PR delegation (create, merge, comment via API)
- [x] CSV/Excel import (Jira auto-mapping)
- [ ] Notification system (email, Slack, browser push)
- [ ] Structured logging (JSON, correlation IDs)
- [ ] E2E and integration tests
- [ ] Deploy webhook integration (GitHub Deployments API)
- [ ] Workflow templates (pre-built custom workflows for common patterns)
- [ ] Task export (CSV/Excel)

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes and ensure `make ci` passes
4. Open a pull request

## License

MIT
