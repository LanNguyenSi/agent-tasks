# Architecture

## Recommended Starting Shape

Das System bleibt ein **modularer Monolith** mit klaren Grenzen zwischen HTTP, Domain-Logik und Persistenz.

Begründung:
- schnelle Delivery in der aktuellen Phase
- geringe operative Komplexität
- saubere Extraktionspfade für spätere Service-Splits

Siehe auch:
- `adr/0005-modular-monolith-as-starting-architecture.md`
- `adr/0006-relational-database-as-primary-store.md`
- `adr/0007-integrations-behind-internal-boundaries.md`

## Runtime Topology

- Frontend: Next.js App (`frontend/`)
- Backend API: Hono + Node.js (`backend/`)
- Primary DB: PostgreSQL + Prisma
- Optional cache: Redis (`REDIS_URL`; the backend falls back to an in-memory cache when unset)
- Optional Docker-Dev-Stack: `docker-compose.yml` (db + redis + backend + frontend)

## Logical Modules

### Frontend
- App Router pages (`frontend/src/app`)
- API client and transport helpers (`frontend/src/lib`)

### Backend
- Routes (`backend/src/routes`): HTTP parsing, validation, status codes
- Services (`backend/src/services`): domain rules, authorization decisions
- Repositories (`backend/src/repositories`): DB access via Prisma
- Middleware (`backend/src/middleware`): auth, cross-cutting concerns
- Config (`backend/src/config`): env validation and typed runtime config

## Boundary Rules

- Keine Business-Regeln in Routen.
- Services sprechen nicht direkt HTTP, sondern Domain.
- Repositories enthalten nur Persistenzlogik.
- Integrationen (GitHub-Anbindung, OIDC-SSO) bleiben hinter internen Modulen mit expliziten Fehlerpfaden.

## Security Model

- Humans: E-Mail/Passwort-Login, GitHub-OAuth-Login (`/api/auth/github`), Verknüpfung von GitHub mit einem bestehenden Konto (`/api/auth/github/connect`), team-spezifisches OIDC-SSO (`backend/src/routes/sso.ts`)
- Agents: dedizierte Bearer-Tokens mit Scopes
- Team-/Projektzugriff wird auf Service-Ebene geprüft
- Kritische Aktionen sollen auditierbar sein

## Data and Consistency

- Relationales Modell in PostgreSQL (`backend/prisma/schema.prisma`)
- Idempotenz und Konfliktbehandlung für integrationsnahe Aktionen vorgesehen
- Claim-/Transition-Konflikte werden explizit behandelt

## Evolution Path

Kurzfristig:
- Agent-Token-Lifecycle und Tests vervollständigen

Mittelfristig:
- Module für Sync, Workflows, Boards, Policies ausbauen
- Integrations- und Fehlerpfadtests verstärken

Langfristig:
- Bei Last-/Ownership-Bedarf gezielte Extraktion einzelner Module in Services

## Diagrams

- Systemarchitektur: `diagrams/architecture-overview.mmd`
- Domänenübersicht: `diagrams/domain-overview.mmd`

## Repository layout

```
agent-tasks/
├── backend/          # Hono API (port 3001)
│   ├── src/
│   │   ├── routes/        # HTTP handlers
│   │   ├── services/      # Domain / authz logic
│   │   ├── repositories/  # Persistence access
│   │   ├── middleware/    # Auth, error handling
│   │   └── config/        # Env config
│   └── prisma/            # Schema + migrations
├── frontend/         # Next.js app (port 3000)
│   └── src/
│       ├── app/           # App Router pages
│       └── lib/           # API client
├── mcp-server/       # @agent-tasks/mcp-server, stdio MCP wrapper for agents
│   └── src/
│       ├── client.ts      # Bearer-auth HTTP client for the REST API
│       ├── server.ts      # Library entry (createServer / runStdioServer)
│       └── tools.ts       # Tool definitions (projects, tasks, signals)
├── mcp-bridge/       # @agent-tasks/mcp-bridge, npx-distributable bridge
│   └── src/                #   with keychain login, wraps mcp-server
│       ├── cli.ts         # CLI entry (serve | login | logout | status)
│       ├── login.ts       # Token prompt + backend validation
│       └── token-store.ts # env / keychain / file fallback
├── cli/              # @agent-tasks/cli, command-line client
├── scripts/          # Grounding deployment / receipt-contract checks
├── tools/            # Docker smoke override + script, Jira import
├── docs/             # Specs (this directory)
└── .github/          # CI workflows
```

## Surface map (UI pages)

| Route | Purpose |
|-------|---------|
| `/` | Landing page |
| `/auth` | Login / Register |
| `/onboarding` | First team creation |
| `/teams` | Project management, GitHub sync |
| `/dashboard` | Board + list view, task CRUD |
| `/projects/workflow` | Workflow editor (states, transitions, agent instructions) |
| `/settings` | Account, GitHub connection, API tokens |
| `/docs` | Interactive Swagger UI (served by backend) |
