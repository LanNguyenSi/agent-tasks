---
type: module
title: "backend: Hono API + Prisma"
description: "Route layout, service/gate split, and the token-hash auth middleware behind every request."
tags: [backend, hono, prisma, auth, routes]
timestamp: 2026-09-08T06:15:34Z
sources:
  - backend/src/services/grounding-completion.ts
  - backend/src/services/grounding-finalization.ts
  - backend/src/services/grounding-context-mutation.ts
  - backend/src/app.ts
  - backend/src/routes/tasks.ts
  - backend/src/middleware/auth.ts
  - backend/src/services
  - backend/src/services/gates
  - backend/src/config/index.ts
  - backend/src/routes/grounding.ts
  - backend/prisma/schema.prisma
  - backend/src/repositories/team-repository.ts
---

Framework is **Hono** (`hono@^4.12.21`), not Express, `backend/src/app.ts` builds a `Hono` app and mounts sub-routers with `app.route(prefix, router)`; `backend/src/server.ts` serves it via `@hono/node-server`. Config is a Zod schema in `backend/src/config/index.ts` (`DATABASE_URL`, `SESSION_SECRET` min 32 chars, `CORS_ORIGINS`, `TRUSTED_PROXY_HOPS`, etc.), fail-fast on missing/invalid env.

**Route mounting** (`app.ts`): `/api/health`, `/api/webhooks` (GitHub, signature-verified, no auth), `/` docsRouter (OpenAPI spec), `/api/auth` + `/api` (SSO), `/api/agent-tokens`, `/api` (projects, invites, **tasks**, workflows, boards, audit, signals), `/api/github`, `/api/mcp`.

**`backend/src/routes/tasks.ts`** (7200+ lines) is the v2 verb surface: `POST /api/tasks/pickup`, `POST /api/tasks/:id/start`, `POST /api/tasks/:id/finish`, `POST /api/tasks/:id/merge`, `POST /api/tasks/:id/abandon`, `POST /api/tasks/:id/creator-abandon`, `POST /api/tasks/:id/respec`, `POST /api/tasks/:id/submit-pr`, plus the M4 advisory-only `POST /api/tasks/:id/suggest-rewrite` (LLM rewrite helper, gated behind `Project.aiHelpersEnabled`, never mutates the task itself), plus the classic REST CRUD (`POST /api/projects/:projectId/tasks`, `PATCH/GET/DELETE /api/tasks/:id`, `/attachments`, `/artifacts`, `/comments`, `/dependencies`, `/claim`, `/release`, `/transition`, `/review`, `/review/claim`, `/review/release`). See `task-lifecycle.md`, `claim-model.md`, `workflow-gates.md`, `governance-merge.md` for the invariants living in this file.

**Services** (`backend/src/services/`): one file per concern, `confidence-gate.ts` (scorer enforcement), `review-gate.ts` + `self-merge-notice.ts` (distinct-reviewer/self-merge), `github-merge.ts`/`github-checks.ts`/`github-webhook.ts` (PR lifecycle), `transition-rules.ts` (the four declarative gates), `signal.ts`/`task-signal.ts`/`review-signal.ts` (async notifications), `scopes.ts` (canonical agent-token scope list), `audit.ts` (append-only audit log), `workflow-templates.ts`/`default-workflow.ts` (workflow engine).

**Grounding receipts** (`backend/src/services/grounding-receipt.ts`): an offline verifier accepts explicit trust, expected context and clock inputs, then checks canonical receipt bytes, Ed25519 authentication, scopes, bindings, freshness and assessment outcome. Its passing result is documentary evidence; the grounding receipt-ingest route invokes it transactionally, while completion routes and transition gates do not call it yet. The runtime imports only `node:crypto`. See [the receipt contract](../grounding-receipt-contract.md) for the API and pinned fixture sync/check procedure.

**Protected grounding attempts** (`grounding-attempts.ts`, `grounding-context.ts`, `routes/grounding.ts`): explicitly injected dormant service with protected server provisioning, server-derived workflow/context challenges, fresh authorized GitHub-head reads and atomic receipt nomination/ingest. Separate Prisma Binding/Attempt/Receipt/Finalization tables hold protected state; task metadata cannot enroll or downgrade it. `app.ts` mounts the authenticated attempt/receipt routes, but its default has no configured service. Issuance supersedes older attempts and ingest preserves immutable evidence with exact retries. Neither route changes task status, claims or PRs; unresolved shared-service reservations now block issuance/upload with 409. Project-access and GitHub-delegation helpers accept an optional transaction client so these reads share the protected transaction; existing callers retain their singleton default. Exact byte projection, limits and error behavior are documented in [the receipt contract](../grounding-receipt-contract.md).

**Gate registry** (`backend/src/services/gates/`): a small discovery-only registry (`types.ts` `GateCode` enum: `distinct_reviewer`, `self_merge`, `task_status_for_merge`, `pr_repo_matches_project`) so a project can introspect *which* gates would fire before calling a verb (`GET /api/projects/:id/effective-gates`, MCP `projects_get_effective_gates`). Enforcement itself still lives inline in the route handlers, not in this registry.

**Auth middleware** (`backend/src/middleware/auth.ts`): `authMiddleware` reads `Authorization: Bearer <token>`, SHA-256-hashes it (`hashToken`, `createHash("sha256")`) and looks up `AgentToken.tokenHash` (unique). A hit yields an `AgentActor{ tokenId, teamId, scopes, userId }` (also checks `revokedAt`/`expiresAt`, updates `lastUsedAt`). A miss falls through to `verifySessionToken` (session JWT, e.g. server-to-server callers with no cookie jar) → `HumanActor`. No bearer header falls back to the session cookie (`extractSessionCookie`). `requireScope(scope)` is the per-route scope gate; `hashToken` is exported for reuse.

Related: `architecture.md`, `claim-model.md`, `workflow-gates.md`, `governance-merge.md`, `confidence-scorer.md`.

**Shared grounding completion** (`grounding-completion.ts`, `grounding-finalization.ts`):
server-only APIs use explicit persisted cohorts and immutable operations, own
concrete task/claim effects and mandatory transactional audit, and consume
external receipts atomically. The remote path reserves an exact source head,
claims one durable dispatch and uses read-only recovery after uncertain effects.
Undispatched reservations can be audited-cancelled. The shared context mutation
helper locks parent projects then sorted tasks, rejects unresolved reservations
and commits actual writes, invalidation and audit together. Current completion
routers and other context writers are not wired to these APIs. Full API and
failure semantics: [receipt contract](../grounding-receipt-contract.md).
