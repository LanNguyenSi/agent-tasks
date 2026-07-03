---
type: module
title: "backend: Hono API + Prisma"
description: "Route layout, service/gate split, and the token-hash auth middleware behind every request."
tags: [backend, hono, prisma, auth, routes]
timestamp: 2026-07-03T10:59:39Z
sources:
  - backend/src/app.ts
  - backend/src/routes/tasks.ts
  - backend/src/middleware/auth.ts
  - backend/src/services
  - backend/src/services/gates
  - backend/src/config/index.ts
---

Framework is **Hono** (`hono@^4.12.21`), not Express, `backend/src/app.ts` builds a `Hono` app and mounts sub-routers with `app.route(prefix, router)`; `backend/src/server.ts` serves it via `@hono/node-server`. Config is a Zod schema in `backend/src/config/index.ts` (`DATABASE_URL`, `SESSION_SECRET` min 32 chars, `CORS_ORIGINS`, `TRUSTED_PROXY_HOPS`, etc.), fail-fast on missing/invalid env.

**Route mounting** (`app.ts`): `/api/health`, `/api/webhooks` (GitHub, signature-verified, no auth), `/` docsRouter (OpenAPI spec), `/api/auth` + `/api` (SSO), `/api/agent-tokens`, `/api` (projects, invites, **tasks**, workflows, boards, audit, signals), `/api/github`, `/api/mcp`.

**`backend/src/routes/tasks.ts`** (5300+ lines) is the v2 verb surface: `POST /api/tasks/pickup`, `POST /api/tasks/:id/start`, `POST /api/tasks/:id/finish`, `POST /api/tasks/:id/merge`, `POST /api/tasks/:id/abandon`, `POST /api/tasks/:id/submit-pr`, plus the classic REST CRUD (`POST /api/projects/:projectId/tasks`, `PATCH/GET/DELETE /api/tasks/:id`, `/attachments`, `/artifacts`, `/comments`, `/dependencies`, `/claim`, `/release`, `/transition`, `/review`, `/review/claim`, `/review/release`). See `task-lifecycle.md`, `claim-model.md`, `workflow-gates.md`, `governance-merge.md` for the invariants living in this file.

**Services** (`backend/src/services/`): one file per concern, `confidence-gate.ts` (scorer enforcement), `review-gate.ts` + `self-merge-notice.ts` (distinct-reviewer/self-merge), `github-merge.ts`/`github-checks.ts`/`github-webhook.ts` (PR lifecycle), `transition-rules.ts` (the four declarative gates), `signal.ts`/`task-signal.ts`/`review-signal.ts` (async notifications), `scopes.ts` (canonical agent-token scope list), `audit.ts` (append-only audit log), `workflow-templates.ts`/`default-workflow.ts` (workflow engine).

**Gate registry** (`backend/src/services/gates/`): a small discovery-only registry (`types.ts` `GateCode` enum: `distinct_reviewer`, `self_merge`, `task_status_for_merge`, `pr_repo_matches_project`) so a project can introspect *which* gates would fire before calling a verb (`GET /api/projects/:id/effective-gates`, MCP `projects_get_effective_gates`). Enforcement itself still lives inline in the route handlers, not in this registry.

**Auth middleware** (`backend/src/middleware/auth.ts`): `authMiddleware` reads `Authorization: Bearer <token>`, SHA-256-hashes it (`hashToken`, `createHash("sha256")`) and looks up `AgentToken.tokenHash` (unique). A hit yields an `AgentActor{ tokenId, teamId, scopes, userId }` (also checks `revokedAt`/`expiresAt`, updates `lastUsedAt`). A miss falls through to `verifySessionToken` (session JWT, e.g. server-to-server callers with no cookie jar) → `HumanActor`. No bearer header falls back to the session cookie (`extractSessionCookie`). `requireScope(scope)` is the per-route scope gate; `hashToken` is exported for reuse.

Related: `architecture.md`, `claim-model.md`, `workflow-gates.md`, `governance-merge.md`, `confidence-scorer.md`.
