---
type: module
title: "backend: Hono API + Prisma"
description: "Route layout, service/gate split, and the token-hash auth middleware behind every request."
tags: [backend, hono, prisma, auth, routes]
timestamp: 2026-09-08T10:24:00Z
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
  - backend/src/routes/grounding-task-completion.ts
  - backend/src/routes/grounding-direct-tasks.ts
  - backend/src/routes/grounding-creation.ts
  - backend/src/routes/projects.ts
  - backend/src/services/grounding-attempts.ts
  - backend/src/services/grounding-context.ts
  - backend/src/services/grounding-merge-provider.ts
  - backend/prisma/schema.prisma
  - backend/src/repositories/team-repository.ts
---

Framework is **Hono** (`hono@^4.12.21`), not Express, `backend/src/app.ts` builds a `Hono` app and mounts sub-routers with `app.route(prefix, router)`; `backend/src/server.ts` serves it via `@hono/node-server`. Config is a Zod schema in `backend/src/config/index.ts` (`DATABASE_URL`, `SESSION_SECRET` min 32 chars, `CORS_ORIGINS`, `TRUSTED_PROXY_HOPS`, etc.), fail-fast on missing/invalid env.

**Route mounting** (`app.ts`): `/api/health`, `/api/webhooks` (GitHub, signature-verified, no auth), `/` docsRouter (OpenAPI spec), `/api/auth` + `/api` (SSO), `/api/agent-tokens`, `/api` (projects, invites, **tasks**, workflows, boards, audit, signals), `/api/github`, `/api/mcp`.

**`backend/src/routes/tasks.ts`** (7200+ lines) is the v2 verb surface: `POST /api/tasks/pickup`, `POST /api/tasks/:id/start`, `POST /api/tasks/:id/finish`, `POST /api/tasks/:id/merge`, `POST /api/tasks/:id/abandon`, `POST /api/tasks/:id/creator-abandon`, `POST /api/tasks/:id/respec`, `POST /api/tasks/:id/submit-pr`, plus the M4 advisory-only `POST /api/tasks/:id/suggest-rewrite` (LLM rewrite helper, gated behind `Project.aiHelpersEnabled`, never mutates the task itself), plus the classic REST CRUD (`POST /api/projects/:projectId/tasks`, `PATCH/GET/DELETE /api/tasks/:id`, `/attachments`, `/artifacts`, `/comments`, `/dependencies`, `/claim`, `/release`, `/transition`, `/review`, `/review/claim`, `/review/release`). See `task-lifecycle.md`, `claim-model.md`, `workflow-gates.md`, `governance-merge.md` for the invariants living in this file.

**Services** (`backend/src/services/`): one file per concern, `confidence-gate.ts` (scorer enforcement), `review-gate.ts` + `self-merge-notice.ts` (distinct-reviewer/self-merge), `github-merge.ts`/`github-checks.ts`/`github-webhook.ts` (PR lifecycle), `transition-rules.ts` (the four declarative gates), `signal.ts`/`task-signal.ts`/`review-signal.ts` (async notifications), `scopes.ts` (canonical agent-token scope list), `audit.ts` (append-only audit log), `workflow-templates.ts`/`default-workflow.ts` (workflow engine).

**Grounding receipts** (`backend/src/services/grounding-receipt.ts`): an offline verifier accepts explicit trust, expected context and clock inputs, then checks canonical receipt bytes, Ed25519 authentication, scopes, bindings, freshness and assessment outcome. Its passing result is documentary evidence. The provisioned completion router invokes the shared finalization service before task/claim/remote effects; historical unprovisioned task handlers remain the compatibility path. The runtime imports only `node:crypto`. See [the receipt contract](../grounding-receipt-contract.md) for the API and pinned fixture sync/check procedure.

**Protected grounding attempts** (`grounding-attempts.ts`, `grounding-context.ts`, `routes/grounding.ts`): explicitly injected dormant service with protected server provisioning, server-derived workflow/context challenges, fresh authorized GitHub-head reads and atomic receipt nomination/ingest. Separate Prisma Binding/Attempt/Receipt/Finalization tables hold protected state; task metadata cannot enroll or downgrade it. `app.ts` mounts the authenticated attempt/receipt routes, but its default has no configured service. Issuance supersedes older attempts and ingest preserves immutable evidence with exact retries. Neither route changes task status, claims or PRs; unresolved shared-service reservations now block issuance/upload with 409.

**Direct and creation adapters** (`grounding-direct-tasks.ts`, `grounding-creation.ts`): provisioned direct REST transition/review/PATCH operations issue a strict, persisted route descriptor and reauthorize it at receipt ingest. Positive operations require an idempotency key and commit their selected decision with receipt/history/audit effects; the direct lane retains its endpoint policy and does not make v2 attempts interchangeable. Direct respec and submit-PR context changes invalidate attempts atomically. The optional readonly creation policy is empty by default and can atomically bind a selected new task or import row; it is neither public enrollment nor historical admin import. Enrolled deletion returns `409 grounding_history_retained` after the reservation check and retains the data.

An actual `requireGroundingForDebug` project toggle atomically invalidates each
affected attempt and writes the attributed context audit; a same-value PATCH
preserves attempts. It preserves the stored protection classification in the binding and cohort.

Finish/approve issuance keeps the established transition scope and claimant
rules. The installed REST task-merge path instead binds the validated merge
intent to the persisted attempt and actor, then applies the standalone
review-only merge authorization at issue and receipt ingest. It requires project
write access, agent merge scope and merge delegation consent, and retains the
existing required-role, self-merge and distinct-reviewer gates without creating
a universal claim rule. Its head/CI reads use merge delegation consent, while
generic finish/approve reads keep PR-create consent. Project-access and
delegation helpers accept an optional transaction client so these reads share
the protected transaction; existing callers retain their singleton default.
Exact byte projection, limits and error behavior are documented in [the receipt
contract](../grounding-receipt-contract.md).

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
routers for historical unprovisioned behavior and other context writers remain
separate from these APIs. Full API and
failure semantics: [receipt contract](../grounding-receipt-contract.md). `app.ts`
mounts `grounding-task-completion.ts` before `tasks.ts`; its optional third
`createApp` dependency is scoped to that app instance. A provisioned request
requires a JSON body and `Idempotency-Key`, normalizes omitted `autoMerge:false`
and `mergeMethod:"squash"`, checks durable operation history before current
claim/state dispatch, and replays only an identical authorized operation.
Its persisted route-effect plan supplies the historical task projection while
task, receipt, operation, audit, comments and signal rows commit together.
Replay does not recreate those rows. Webhook delivery and the optional
calibration observer run after a new commit as best-effort work, so they are not
an exactly-once delivery guarantee.
