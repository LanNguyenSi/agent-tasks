# agent-tasks

Collaborative task platform for humans and agents.

## Stack

- **Frontend:** Next.js 15 (React 19, App Router)
- **Backend:** Hono + Node.js
- **Database:** PostgreSQL + Prisma
- **Auth:** GitHub OAuth (humans) + API tokens with scopes (agents)

## Monorepo Structure

```
agent-tasks/
├── backend/          # Hono API (port 3001)
│   ├── src/
│   │   ├── routes/   # HTTP handlers
│   │   ├── services/ # Business logic
│   │   ├── middleware/ # Auth, error handling
│   │   └── config/   # Env config
│   └── prisma/       # Schema + migrations
├── frontend/         # Next.js app (port 3000)
│   └── src/
│       ├── app/      # App Router pages
│       ├── lib/      # API client
│       └── components/
├── docs/             # Specs (from planforge)
└── .github/          # CI workflows
```

## Development

```bash
# Copy env
cp .env.example .env

# Install
npm ci --workspace=backend
npm ci --workspace=frontend

# Database
cd backend && npx prisma db push

# Dev servers
npm run dev:backend  # port 3001
npm run dev:frontend # port 3000
```

## Wave Status

| Wave | Scope | Status |
|------|-------|--------|
| 1 | Monorepo, schema, auth shell, CI | ✅ Done |
| 2 | GitHub OAuth, session management | ⏳ Next |
| 3 | Full task/project/board features | ⏳ Planned |
| 4 | Integration hardening, policies | ⏳ Planned |

## API Highlights

```bash
# Health
GET  /api/health

# Auth (Wave 2: GitHub OAuth)
GET  /api/auth/github/callback

# Agent Tokens
POST /api/agent-tokens        # Create token (admin only)
GET  /api/agent-tokens?teamId= # List tokens
POST /api/agent-tokens/:id/revoke

# Tasks
GET  /api/projects/:id/tasks
POST /api/projects/:id/tasks
POST /api/tasks/:id/claim
POST /api/tasks/:id/release
POST /api/tasks/:id/transition
```

## Agent Auth

Agents authenticate with Bearer tokens and scopes:

```bash
curl -H "Authorization: Bearer at_..." \
     -H "Content-Type: application/json" \
     -d '{"title": "Fix bug #42", "priority": "HIGH"}' \
     http://localhost:3001/api/projects/{id}/tasks
```

Available scopes: `tasks:read` `tasks:create` `tasks:claim` `tasks:comment` `tasks:transition` `projects:read` `boards:read`
