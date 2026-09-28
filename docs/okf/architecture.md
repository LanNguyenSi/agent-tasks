---
type: overview
title: "agent-tasks system architecture"
description: "Four independently-deployable components around one PostgreSQL store, with a stdio MCP surface as the agent entry point."
tags: [architecture, backend, frontend, mcp, monorepo]
timestamp: 2026-09-28T07:54:48Z
sources:
  - backend/src/config/grounding-runtime.ts
  - backend/src/services/grounding-runtime.ts
  - package.json
  - backend/src/app.ts
  - backend/src/routes/grounding-direct-tasks.ts
  - backend/src/routes/grounding-creation.ts
  - backend/src/routes/grounding-task-completion.ts
  - backend/src/server.ts
  - backend/src/routes/docs.ts
  - docker-compose.prod.yml
  - frontend/package.json
  - backend/src/routes/grounding-github.ts
  - backend/src/services/grounding-scope.ts
---

npm workspaces monorepo (`package.json` workspaces: `backend`, `frontend`, `mcp-server`, `mcp-bridge`, `cli`). This doc covers the four deployables; `@agent-tasks/cli` is a fifth workspace (a standalone REST CLI client) not detailed here.

1. **backend** (`@agent-tasks/backend`), a Hono HTTP API (`backend/src/app.ts`, served via `@hono/node-server` in `backend/src/server.ts`), Prisma ORM against PostgreSQL. All API routes mount under `/api`; the Swagger UI page is the one exception, served at `/docs` (`backend/src/app.ts:104`, `backend/src/routes/docs.ts:1946`; see `backend.md`). Owns all state.
2. **frontend** (`@agent-tasks/frontend`), Next.js 15 app (`frontend/package.json` pins `next@^15`), the human-facing UI. Talks to the backend over HTTP; has a couple of its own `app/api/*` route handlers only for GitHub OAuth redirects (`frontend/src/app/api/auth/github/*`).
3. **mcp-server** (`@agent-tasks/mcp-server`), stdio MCP server wrapping the backend REST API with a fixed `Authorization: Bearer` token. Published to npm. See `mcp-server.md`.
4. **mcp-bridge** (`@agent-tasks/mcp-bridge`), a thin CLI wrapper around mcp-server that resolves the bearer token (env var, OS keychain, or file) before handing off to the same stdio runtime. See `mcp-bridge.md`.

All state lives in one PostgreSQL database (Prisma schema at `backend/prisma/schema.prisma`); nothing else is a system of record. Prod topology (`docker-compose.prod.yml`) is `db` → one-shot `migrate` (Prisma `db push`) → `backend` and `frontend`, both behind a shared external `traefik` network; see `deploy.md`.

**Grounding composition**: the backend's optional per-app grounding dependencies
are mounted before the historical task router. Authoritative provisioning selects
the completion adapter for finish, merge and abandon, the direct adapter for
transition, review, PATCH, respec and enrolled deletion checks, and an optional
server-owned creation-policy adapter for selected new tasks/import rows. Absent
selection reaches the historical compatibility routes; on a configured app, a
task without server enrollment keeps that same compatibility behavior for
local completion, but a fresh remote operation (task merge, GitHub merge,
finish with `autoMerge`) instead returns `409 grounding_enrollment_required`
before any remote effect (`grounding-task-completion.ts:117`,
`routes/grounding-github.ts:151`) when the task's project is in the configured
`creationPolicy` scope, or when any repository or PR number the legacy handler
could act on (request owner/repo and PR URL, deliverable, project and stored
PR URL repository; path, task and PR URL number) belongs to a selected project
or is shared with a protected/`EXTERNAL_V1`/held peer (`grounding-scope.ts`,
reusing the merge service's peer predicate). A non-canonical candidate
repository string (dot segment, percent-encoded name, owner containing `/`) is
guarded too, and an unguarded request whose candidate repository fence another
operation owns returns `409 grounding_finalization_pending` before any GitHub
call (`grounding-task-completion.ts:120`, `routes/grounding-github.ts:68`).
Otherwise, including without an operation key, the same request reaches the
historical route; an unprovisioned task's PR create outside that scope reaches
the legacy creator even with a key, which reads it from the `Idempotency-Key`
header or the body `idempotencyKey`. The unconfigured default app has no such
gate either way. Outside the enforced scope the configured GitHub create and
merge routes read only the task id, body owner/repo, a well-formed key for the
history lookup and the path PR number parsed as legacy parses it, then hand
the request to the legacy handler unmodified; the remaining differences from
the unconfigured app are the guarded and fenced refusals and the agent-scope
admission check that runs first. Enabling configuration writes grounding
history (webhook deliveries, for example), so a later unconfigured restart is
refused and enabling is one-way; rollback means keeping an enabled
configuration with empty trust and an empty `creationPolicy`. Startup itself
refuses when a project outside the enforced scope shares a GitHub repository
with an enforced one, when an enforced project's repository is not canonical,
and, while the scope owns a repository, when any project's repository is not
canonical; a project created or re-pointed after startup is not re-checked.
The scope, peer and fence reads are point-in-time, not locks, and accept a
residual race: any change between the read and the legacy GitHub call that
makes some task a protected/`EXTERNAL_V1`/held peer of the targeted PR or
repository (an admin rebinding a repository or PR, a migration hold, an
enrollment), or a grouped operation acquiring a candidate repository fence, is
not seen. Invalid enrollment,
orphan binding, unavailable trusted service, and database errors fail closed.
There is no agent enrollment endpoint. An explicitly injected human-admin migration service supplies audited hold, legacy repair, external migration and readiness-checked resume. The server loads explicit runtime selection from `GROUNDING_RUNTIME_CONFIG`;
empty creation policy does not activate enrollment; before server-only enrollment of legacy work, active
legacy requests must be quiesced. The system does not claim safe live
legacy-to-external conversion or complete coverage of indirect writers.

The hosted MCP route exposes the same external attempt and receipt transport as
the stdio server, plus the bounded completion verbs needed to finish the
sequence. It forwards a caller-provided operation key and preserves backend
pending and grounding error results instead of treating receipt ingestion as a
completion outcome.

**Actor/auth model**: every request is one of two actor shapes, resolved by `backend/src/middleware/auth.ts` (`backend.md`), a `HumanActor` (browser session cookie, or a session JWT passed as a Bearer token for server-to-server callers) or an `AgentActor` (a SHA-256-hashed `AgentToken` presented as `Authorization: Bearer <raw>`, carrying a `teamId` and a list of `scopes` from `backend/src/services/scopes.ts` that gate individual verbs). The mcp-server/mcp-bridge path is always an `AgentActor`; the frontend is always a `HumanActor`.

Related: `backend.md`, `frontend.md`, `mcp-server.md`, `mcp-bridge.md`, `task-lifecycle.md`.

**Startup admission**: the real server awaits strict public-only configuration and database checks before listening or sweeping idempotency state. Enabled startup composes attempts, grouped completion, PR creation and migration on the same database. Disabled startup is available only with all grounding tables present and empty; any history requires configured routing. See [configuration and upgrade](../grounding-migration.md).
