---
type: overview
title: "agent-tasks system architecture"
description: "Four independently-deployable components around one PostgreSQL store, with a stdio MCP surface as the agent entry point."
tags: [architecture, backend, frontend, mcp, monorepo]
timestamp: 2026-10-06T09:28:57Z
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
  - backend/src/services/github-merge.ts
  - backend/src/routes/github.ts
  - backend/src/services/grounding-attempts.ts
  - backend/src/services/grounding-migration.ts
---

npm workspaces monorepo (`package.json` workspaces: `backend`, `frontend`, `mcp-server`, `mcp-bridge`, `cli`). This doc covers the four deployables; `@agent-tasks/cli` is a fifth workspace (a standalone REST CLI client) not detailed here.

1. **backend** (`@agent-tasks/backend`), a Hono HTTP API (`backend/src/app.ts`, served via `@hono/node-server` in `backend/src/server.ts`), Prisma ORM against PostgreSQL. All API routes mount under `/api`; the Swagger UI page is the one exception, served at `/docs` (`backend/src/app.ts:120`, `backend/src/routes/docs.ts:2061`; see `backend.md`). Owns all state.
2. **frontend** (`@agent-tasks/frontend`), Next.js 15 app (`frontend/package.json` pins `next@^15`), the human-facing UI. Talks to the backend over HTTP; has a couple of its own `app/api/*` route handlers only for GitHub OAuth redirects (`frontend/src/app/api/auth/github/*`).
3. **mcp-server** (`@agent-tasks/mcp-server`), stdio MCP server wrapping the backend REST API with a fixed `Authorization: Bearer` token. Published to npm. See `mcp-server.md`.
4. **mcp-bridge** (`@agent-tasks/mcp-bridge`), a thin CLI wrapper around mcp-server that resolves the bearer token (env var, OS keychain, or file) before handing off to the same stdio runtime. See `mcp-bridge.md`.

All state lives in one PostgreSQL database (Prisma schema at `backend/prisma/schema.prisma`); nothing else is a system of record. Prod topology (`docker-compose.prod.yml`) is `db` → one-shot `migrate` (Prisma `db push`) → `backend` and `frontend`, both behind a shared external `traefik` network; see `deploy.md`.

**Grounding composition**: the backend's optional per-app grounding
dependencies are mounted before the historical task router. Authoritative
provisioning selects the completion adapter for finish, merge and abandon, the
direct adapter for transition, review, PATCH, respec and enrolled deletion
checks, and an optional server-owned creation-policy adapter for selected new
tasks/import rows. Absent selection reaches the historical compatibility
routes. On a configured app the routers make only exact decisions: admission,
task lookup, the caller's access, durable keyed history, enrollment mode, and
whether the task's own project is in the configured `creationPolicy` scope. A
fresh remote merge (task merge, GitHub merge, finish with `autoMerge`) on an
unenrolled task in that scope returns `409 grounding_enrollment_required`
(`grounding-task-completion.ts:114`, `routes/grounding-github.ts:142`);
outside it the untouched request reaches the historical handler, with or
without an operation key (`grounding-task-completion.ts:118`,
`routes/grounding-github.ts:141`), and an unprovisioned task's PR create
outside the scope reaches the legacy creator even with a key
(`routes/grounding-github.ts:95`), which reads it from the `Idempotency-Key`
header or the body `idempotencyKey`. The historical handlers are unchanged
except for a target check at their effect boundary: with configuration
enabled, `performPrMerge` checks the exact repository and PR number right
before the GitHub merge call (`services/github-merge.ts:143`, shared by the
GitHub merge route, task merge and the review, self-approve and work
finishes; the merge reservation of `workflow-gates.md` is taken right after
that check), and the legacy PR creator and commenter check the repository (and
PR) they post to (`routes/github.ts:272`, `routes/github.ts:840`). The check
(`grounding-scope.ts:103`) refuses with `409 grounding_enrollment_required` a
repository string that is not exactly canonical (`grounding-scope.ts:60`), an
enforced repository, or a protected/`EXTERNAL_V1`/bound/held task's PR,
including a peer that stores a non-canonical repository and shares the
number, and a merge or create whose requesting task is itself such a task,
whatever PR number it sends. It refuses with
`409 grounding_finalization_pending` a merge or create when another operation
owns the fence of the target repository or of any repository the legacy task
write's fence trigger checks for the requesting task (its effective
repository, its stored PR URL repository and its own active PR-create intents'
repositories). Comments write no task and take no fence, and a create sends
no PR number. A comment is refused on an enforced repository and on a peer's PR whoever sends it, the PR the
requesting task stores included, since an agent can set a task's PR number and
repository. Everything is read in one statement
driven by the enrollment and hold tables (`grounding-scope.ts:71`). With
configuration enabled the three legacy writes are sent with
`redirect: "manual"` (`backend/src/services/github-merge.ts:162`, `backend/src/routes/github.ts:287`,
`backend/src/routes/github.ts:850`), and a GitHub redirect (a renamed or transferred
repository) is answered with `409 github_redirect_refused` instead of being
followed (`grounding-scope.ts:151`, `services/github-merge.ts:195`,
`routes/github.ts:302`, `routes/github.ts:863`); the unconfigured app keeps
fetch's default redirect handling.
`createApp` hands the check to every request (`backend/src/app.ts:47`,
`backend/src/app.ts:59`); the unconfigured app hands none, so its handlers run
no check, and a completion service without its check refuses startup
(`grounding-task-completion.ts:41`). Every Grounding router checks the
caller's access before any Grounding read or lock: the GitHub create and merge
routes with the legacy rule (`routes/grounding-github.ts:82`,
`routes/grounding-github.ts:130`), so a caller without access gets the legacy
handler's own 403, the attempt and migration routes with a lock-free read
before the task lock (`grounding-attempts.ts:73`,
`services/grounding-migration.ts:44`), and the creation router before it looks
at the `creationPolicy` selection (`routes/grounding-creation.ts:36`). The
principal differences from the unconfigured app are the boundary and in-scope
refusals, the refusal of renamed or transferred repository writes, the
agent-scope admission check that runs first, a transient
`503 grounding_verification_unavailable` from the Serializable routing read,
and the GitHub merge route's `503` retry message. As defense in depth,
enforced repositories must still not run comment-triggered merge or deploy
automation; direct GitHub access outside agent-tasks (tokens, the GitHub UI,
other apps) is not governed by the check. Enabling
configuration writes grounding history (webhook deliveries, for example), so a
later unconfigured restart is refused and enabling is one-way; rollback means
keeping an enabled configuration with empty trust and an empty
`creationPolicy`. Startup itself refuses when a project outside the enforced
scope shares a GitHub repository with an enforced one, when an enforced
project's repository is not canonical, and, while the scope owns a repository,
when any project's repository is not canonical; a project created or
re-pointed after startup is not re-checked. The boundary read is
point-in-time, one database round trip before the GitHub call, and two
residual races within that window are accepted: a change after the read that
makes some task a protected/`EXTERNAL_V1`/held peer of the targeted PR (an
admin rebinding a repository or PR, a migration hold, an enrollment) is not
seen, and a grouped operation that acquires one of the checked fences after
the read lets the legacy GitHub effect happen while the legacy task write
fails on the fence (a merge lands with the task still in review; a create
leaves an unlinked PR). Invalid enrollment, orphan binding, unavailable
trusted service, and database errors fail closed. There is no agent enrollment endpoint. An
explicitly injected human-admin migration service supplies audited hold,
legacy repair, external migration and readiness-checked resume. The server
loads explicit runtime selection from `GROUNDING_RUNTIME_CONFIG`; empty
creation policy does not activate enrollment; before server-only enrollment of
legacy work, active legacy requests must be quiesced. The system does not
claim safe live legacy-to-external conversion or complete coverage of indirect
writers.

The hosted MCP route exposes the same external attempt and receipt transport as
the stdio server, plus the bounded completion verbs needed to finish the
sequence. It forwards a caller-provided operation key and preserves backend
pending and grounding error results instead of treating receipt ingestion as a
completion outcome.

**Actor/auth model**: every request is one of two actor shapes, resolved by `backend/src/middleware/auth.ts` (`backend.md`), a `HumanActor` (browser session cookie, or a session JWT passed as a Bearer token for server-to-server callers) or an `AgentActor` (a SHA-256-hashed `AgentToken` presented as `Authorization: Bearer <raw>`, carrying a `teamId` and a list of `scopes` from `backend/src/services/scopes.ts` that gate individual verbs). The mcp-server/mcp-bridge path is always an `AgentActor`; the frontend is always a `HumanActor`.

Related: `backend.md`, `frontend.md`, `mcp-server.md`, `mcp-bridge.md`, `task-lifecycle.md`.

**Startup admission**: the real server awaits strict public-only configuration and database checks before listening or sweeping idempotency state. Enabled startup composes attempts, grouped completion, PR creation, migration and the effect-boundary check on the same database (`services/grounding-runtime.ts:92`). Disabled startup is available only with all grounding tables present and empty apart from unowned repository-fence rows, which ordinary GitHub-linked task writes create; any other history requires configured routing. See [configuration and upgrade](../grounding-migration.md).
