---
type: module
title: "backend: Hono API + Prisma"
description: "Route layout, service/gate split, and the token-hash auth middleware behind every request."
tags: [backend, hono, prisma, auth, routes]
timestamp: 2026-10-02T11:48:28Z
sources:
  - backend/src/config/grounding-runtime.ts
  - backend/src/services/grounding-runtime.ts
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
  - backend/package.json
  - backend/src/routes/grounding-github.ts
  - backend/src/routes/github.ts
  - backend/src/services/grounding-scope.ts
  - backend/src/services/grounding-github-create.ts
  - backend/src/services/grounding-github-webhook.ts
  - docs/grounding-receipt-contract.md
---

Framework is **Hono** (`hono@^4.13.7`), not Express, `backend/src/app.ts` builds a `Hono` app and mounts sub-routers with `app.route(prefix, router)`; `backend/src/server.ts` serves it via `@hono/node-server`. Config is a Zod schema in `backend/src/config/index.ts` (`DATABASE_URL`, `SESSION_SECRET` min 32 chars, `CORS_ORIGINS`, `TRUSTED_PROXY_HOPS`, etc.), fail-fast on missing/invalid env.

**Route mounting** (`app.ts`): `/api/health`, `/api/webhooks` (GitHub, signature-verified, no auth; the grounding GitHub webhook router when grounding is configured, otherwise the plain webhook router), `/` docsRouter (OpenAPI spec), `/api/auth` + `/api` (SSO), `/api/auth`, `/api` (teams), `/api/agent-tokens`, `/api` (projects, project invites), `/api/invites`, `/api/admin` (shares), `/api` (grounding attempts, grounding task completion, grounding direct tasks, grounding creation, then **tasks**, workflows, boards, audit, signals), `/api/github` (the grounding GitHub router first when grounding is configured, then the GitHub router), `/api/mcp`.

**`backend/src/routes/tasks.ts`** (7200+ lines) is the v2 verb surface: `POST /api/tasks/pickup`, `POST /api/tasks/:id/start`, `POST /api/tasks/:id/finish`, `POST /api/tasks/:id/merge`, `POST /api/tasks/:id/abandon`, `POST /api/tasks/:id/creator-abandon`, `POST /api/tasks/:id/respec`, `POST /api/tasks/:id/submit-pr`, plus the M4 advisory-only `POST /api/tasks/:id/suggest-rewrite` (LLM rewrite helper, gated behind `Project.aiHelpersEnabled`, never mutates the task itself), plus the classic REST CRUD (`POST /api/projects/:projectId/tasks`, `PATCH/GET/DELETE /api/tasks/:id`, `/attachments`, `/artifacts`, `/comments`, `/dependencies`, `/claim`, `/release`, `/transition`, `/review`, `/review/claim`, `/review/release`). See `task-lifecycle.md`, `claim-model.md`, `workflow-gates.md`, `governance-merge.md` for the invariants living in this file.

**Services** (`backend/src/services/`): one file per concern, `confidence-gate.ts` (scorer enforcement), `review-gate.ts` + `self-merge-notice.ts` (distinct-reviewer/self-merge), `github-merge.ts`/`github-checks.ts`/`github-webhook.ts` (PR lifecycle; `github-merge.ts` is the legacy merge path), `grounding-github-create.ts`/`grounding-github-webhook.ts` (configured GitHub create/webhook adapters, see below), `transition-rules.ts` (the four declarative gates), `signal.ts`/`task-signal.ts`/`review-signal.ts` (async notifications), `scopes.ts` (canonical agent-token scope list), `audit.ts` (append-only audit log), `workflow-templates.ts`/`default-workflow.ts` (workflow engine).

**Grounding receipts** (`backend/src/services/grounding-receipt.ts`): an offline verifier accepts explicit trust, expected context and clock inputs, then checks canonical receipt bytes, Ed25519 authentication, scopes, bindings, freshness and assessment outcome. Its passing result is documentary evidence. The runtime imports only `node:crypto`. See [the receipt contract](../grounding-receipt-contract.md) for the API and pinned fixture sync/check procedure.

The provisioned completion router invokes the shared finalization service before task/claim/remote effects. On a configured app the routers make only exact decisions (admission, task lookup, the caller's access, durable keyed history, enrollment mode, and whether the task's own project is in the configured `creationPolicy` scope): a fresh remote merge (task merge, GitHub merge, finish with `autoMerge`) on an unenrolled task in that scope returns `409 grounding_enrollment_required` (`grounding-task-completion.ts:114`, `routes/grounding-github.ts:142`), and outside it the untouched request reaches the compatibility route, including without an operation key (`grounding-task-completion.ts:118`, `routes/grounding-github.ts:141`); an unprovisioned task's PR create outside that scope reaches the legacy creator even with a key (`routes/grounding-github.ts:95`; it reads the `Idempotency-Key` header or the body `idempotencyKey`), while a key with durable grounding create history stays with the grouped create service. The compatibility handlers are unchanged except for a target check at their effect boundary (`grounding-scope.ts:103`): with configuration enabled, `performPrMerge` checks the exact repository and PR number right before the GitHub merge call (`services/github-merge.ts:114`, shared by the GitHub merge route, task merge and the review, self-approve and work finishes), and the legacy PR creator and commenter check the repository (and PR) they post to (`routes/github.ts:267`, `routes/github.ts:768`). It refuses with `409 grounding_enrollment_required` a repository string that is not exactly canonical (`grounding-scope.ts:60`), an enforced repository, a protected/`EXTERNAL_V1`/bound/held task's PR (including a peer that stores a non-canonical repository and shares the number), and a merge or create whose requesting task is itself such a task whatever PR number it sends; it refuses a merge or create with `409 grounding_finalization_pending` when another operation owns the fence of the target repository or of any repository the legacy task write's fence trigger checks for the requesting task (its effective repository, stored PR URL repository and own active PR-create intents' repositories). Comments write no task and take no fence, and a create sends no PR number; a comment is refused on an enforced repository and on a peer's PR whoever sends it, the PR the requesting task stores included, since an agent can set a task's PR number and repository. Everything is read in one statement driven by the enrollment and hold tables (`grounding-scope.ts:71`), the same peer-class id list grouped merge discovery uses (`grounding-github-merge.ts:40`). With configuration enabled the three legacy writes go out with `redirect: "manual"` (`backend/src/services/github-merge.ts:126`, `backend/src/routes/github.ts:282`, `backend/src/routes/github.ts:778`) and a GitHub redirect (a renamed or transferred repository) is answered with `409 github_redirect_refused` instead of being followed (`grounding-scope.ts:151`, `services/github-merge.ts:156`, `routes/github.ts:297`, `routes/github.ts:791`); the unconfigured app keeps fetch's default redirect handling. The completion dependencies require `scope` and `remoteGuard` whenever a `service` is wired (`grounding-task-completion.ts:41`); `createApp` hands the check to every request and the unconfigured app hands none (`backend/src/app.ts:47`, `backend/src/app.ts:59`). The configured GitHub create and merge routes check the caller's project access with the legacy rule right after the task lookup, before any Grounding read or lock (`routes/grounding-github.ts:82`, `routes/grounding-github.ts:130`), so a caller without access gets the legacy handler's own 403; outside the enforced scope they read only the task id and a well-formed key for the history lookup, then hand the request to the legacy handler unmodified. The principal differences from the unconfigured app are the boundary and in-scope refusals, the refusal of renamed or transferred repository writes, the agent-scope admission check that runs first, a transient `503 grounding_verification_unavailable` from the Serializable routing read, and the GitHub merge route's `503` retry message. Enabling configuration writes grounding history (webhook deliveries, for example), so a later unconfigured restart is refused and enabling is one-way; rollback means keeping an enabled configuration with empty trust and an empty `creationPolicy`. Startup itself refuses when a project outside the enforced scope shares a GitHub repository with an enforced one, when an enforced project's repository is not canonical, and, while the scope owns a repository, when any project's repository is not canonical; a project created or re-pointed after startup is not re-checked. Unprovisioned local completion and the unconfigured default app keep their compatibility behavior. The boundary read is point-in-time, one database round trip before the GitHub call, and two residual races within that window are accepted: a change after the read that makes some task a protected/`EXTERNAL_V1`/held peer of the targeted PR (an admin rebinding a repository or PR, a migration hold, an enrollment) is not seen, and a grouped operation that acquires one of the checked fences after the read lets the legacy GitHub effect happen while the legacy task write fails on the fence (a merge lands with the task still in review; a create leaves an unlinked PR). As defense in depth, enforced repositories must still not run comment-triggered merge or deploy automation; direct GitHub access outside agent-tasks (tokens, the GitHub UI, other apps) is not governed by the check.

**Protected grounding attempts** (`grounding-attempts.ts`, `grounding-context.ts`, `routes/grounding.ts`): explicitly injected dormant service with protected server provisioning, server-derived workflow/context challenges, fresh authorized GitHub-head reads and atomic receipt nomination/ingest. Separate Prisma Binding/Attempt/Receipt/Finalization tables hold protected state; task metadata cannot enroll or downgrade it. `app.ts` mounts the authenticated attempt/receipt routes; each route reads the task row and checks write access with a lock-free predicate before it takes the task lock (`grounding-attempts.ts:73`), so a caller without access gets one 403 whatever the task's Grounding state. The server injects the full service set only after validated runtime startup admission. Issuance supersedes older attempts and ingest preserves immutable evidence with exact retries. Neither route changes task status, claims or PRs; unresolved shared-service reservations now block issuance/upload with 409. Configured GitHub creation and webhook writers (`grounding-github-create.ts`, `grounding-github-webhook.ts`) participate in the same context-mutation protocol, backed by their own `GroundingGithubCreateOperation`/`GroundingGithubWebhookDelivery` tables; see `governance-merge.md` and [the receipt contract](../grounding-receipt-contract.md) for the detail.

**Direct and creation adapters** (`grounding-direct-tasks.ts`, `grounding-creation.ts`): provisioned direct REST transition/review/PATCH operations issue a strict, persisted route descriptor and reauthorize it at receipt ingest. Positive operations require an idempotency key and commit their selected decision with receipt/history/audit effects; the direct lane retains its endpoint policy and does not make v2 attempts interchangeable. Direct respec and submit-PR context changes invalidate attempts atomically. A direct PATCH demote of an open, unclaimed enrolled task to backlog is a disposition with the same rules as the REST demote (claimed answers `409 bad_state` with a message, any other source status `400`). The optional readonly creation policy is empty by default and can atomically bind a selected new task or import row; it is neither public enrollment nor historical admin import. With a non-empty policy the creation router checks project access before it looks at the selection and answers a caller without access with the legacy creator's own validation and 403 (`routes/grounding-creation.ts:36`), so selection is not observable without access. Enrolled deletion returns `409 grounding_history_retained` after the reservation check and retains the data.

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

**Project settings PATCH** (`backend/src/routes/projects.ts`): `PATCH /api/projects/:id` is human-only and requires the ADMIN role (on the project or its team). Its `riskModifiers` field (the write path for the M3 modifiers) is validated by `riskModifiersSchema` from `backend/src/lib/confidence.ts` (see `confidence-scorer.md`), stored as `Prisma.JsonNull` when cleared with `null`, and audited as `project.updated` only when the canonical (key-order-insensitive) value changes, the same handling as `taskTypeThresholds`.

**Gate registry** (`backend/src/services/gates/`): a small discovery-only registry (`types.ts` `GateCode` enum: `distinct_reviewer`, `self_merge`, `task_status_for_merge`, `pr_repo_matches_project`) so a project can introspect *which* gates would fire before calling a verb (`GET /api/projects/:id/effective-gates`, MCP `projects_get_effective_gates`). Enforcement itself still lives inline in the route handlers, not in this registry. The separate legacy finish gate accepts only the pinned wrapper's `claim-evaluation` and terminal `complete` phases with a session and ledger evidence; its phase compatibility is not an evaluated-outcome result.

**Auth middleware** (`backend/src/middleware/auth.ts`): `authMiddleware` reads `Authorization: Bearer <token>`, SHA-256-hashes it (`hashToken`, `createHash("sha256")`) and looks up `AgentToken.tokenHash` (unique). A hit yields an `AgentActor{ tokenId, teamId, scopes, userId }` (also checks `revokedAt`/`expiresAt`, updates `lastUsedAt`). A miss falls through to `verifySessionToken` (session JWT, e.g. server-to-server callers with no cookie jar) → `HumanActor`. No bearer header falls back to the session cookie (`extractSessionCookie`). `requireScope(scope)` is the per-route scope gate; `hashToken` is exported for reuse.

Related: `architecture.md`, `claim-model.md`, `workflow-gates.md`, `governance-merge.md`, `confidence-scorer.md`.

**Shared grounding completion** (`grounding-completion.ts`, `grounding-finalization.ts`):
server-only APIs use explicit persisted cohorts and immutable operations, own
concrete task/claim effects and mandatory transactional audit, and consume
external receipts atomically. The remote path reserves an exact source head
(equal to the signed head for a `CODE_HEAD` receipt; a `TASK_SPEC` receipt
signs no head, and the reserved head is still sent to GitHub as the expected
`sha`), compares the stored PR URL with the effective repository
case-insensitively and the PR number exactly (`githubPrUrlMatches` in
`grounding-github-fence.ts`), claims one durable dispatch and uses read-only recovery after uncertain effects.
Undispatched reservations can be audited-cancelled. The shared context mutation
helper locks parent projects then sorted tasks, rejects unresolved reservations
and commits actual writes, invalidation and audit together. Unprovisioned local
completion and other context writers remain separate from these APIs; a
configured app's fresh remote operations on an unenrolled task inside the
enforced scope fail closed with `409 grounding_enrollment_required` rather
than falling back to the unprovisioned path, and fall back to it outside that
scope instead (see the receipts paragraph above). Full API and
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

**Administrative migration** (`grounding-migration.ts`, `grounding-hold.ts`): an optional fourth `createApp` argument enables the human-admin migration endpoint and configured GitHub adapters. The server supplies it with the full service set when `GROUNDING_RUNTIME_CONFIG` is enabled; disabled startup requires every migrated grounding table to be empty, except for unowned GitHub repository-fence rows, which the repository-fence trigger produces on an ordinary GitHub-linked task write whether or not grounding is configured; an owned fence and any fence-intent row still refuse. Independent revisioned holds and immutable command history retain cohort/evidence identity, and commands authorize live memberships and audit in one transaction. See [the migration procedure](../grounding-migration.md) for the full task freeze, readiness checks and supported transitions.

**Runtime configuration**: strict, bounded `GROUNDING_RUNTIME_CONFIG` supplies frozen public trust, audience, challenge lifetime and explicit project creation selection. The same policy enrolls REST tasks, import rows and signed issue-open creations atomically. Startup checks selected projects and canonical SQL before creating the listener. Trust changes require coordinated restarts; see [configuration and upgrade](../grounding-migration.md).
