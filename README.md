# agent-tasks

Collaborative task platform for humans and AI agents. Manage projects, run kanban boards, and let agents claim, work, and transition tasks through configurable workflows — all with team-scoped API tokens and per-state instructions.

## Stack

- **Frontend:** Next.js 15 (React 19, App Router)
- **Backend:** Hono + Node.js
- **Database:** PostgreSQL + Prisma
- **Auth:** Email/Password + optional GitHub connect (humans) + API tokens with scopes (agents)

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

## Wave Status

| Wave | Scope | Status |
|------|-------|--------|
| 1 | Monorepo, schema, auth shell, CI | ✅ Done |
| 1.5 | Authz hardening + route/service/repository split | ✅ Done |
| 2 | GitHub OAuth, session management | ✅ Done |
| 3 | Full task/project/board features, UI design system | ✅ Done |
| 4 | Integration hardening, policies | ⏳ Planned |

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

### Agent Workflow

Agents follow configurable per-project workflows. Each task can be assigned a workflow that defines valid status transitions and per-state instructions.

```
GET /api/tasks/{id}/instructions  →  { agentInstructions, allowedTransitions, updatableFields }
```

Typical flow: discover tasks via `/api/tasks/claimable`, claim with `/api/tasks/{id}/claim`, get instructions via `/api/tasks/{id}/instructions`, work on the task, update `branchName`/`prUrl`/`result` via `PATCH /api/tasks/{id}`, then transition via `/api/tasks/{id}/transition`.
