# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

#### `dependsOn` on task creation

- `POST /projects/:projectId/tasks` and the MCP `task_create` /
  `tasks_create` verbs now accept `dependsOn: TaskId[]` (max 50) — an
  array of task IDs in the same project that must reach `done` before
  the new task is pickable. The blockers connect via the existing
  `Task.blockedBy` relation, so `task_pickup`'s blocker-skip filter
  applies automatically with no further wiring. Validation rejects
  IDs that don't exist in the project (400 `bad_request`,
  `missing: [...]`); the field is optional and pure-additive — every
  existing `task_create` call continues to work unchanged.
- Cycle detection is not run at create-time on purpose: a brand-new
  task has no incoming edges, so it can't be part of a cycle. The
  existing `POST /tasks/:id/dependencies` endpoint keeps its DFS
  cycle guard for post-create dep changes.
- Post-create dep management remains on the human-only
  `/tasks/:id/dependencies` endpoints; agents express dependencies
  at create-time, which covers the documented use cases (stacked
  PRs, batch setup→children, post-merge cleanup).
- The batch import endpoint (`POST /projects/:projectId/tasks/import`)
  does **not** accept `dependsOn` — set deps in a follow-up pass via
  the per-task dependencies endpoints. Per-row try/catch in the
  importer doesn't compose with the all-or-nothing blocker
  validation of the single-create path.

## [0.9.0] - 2026-04-23

**Headline: The `/tasks` list view lands as a first-class navigation
target, the REST `/claim` route finally enforces the same transition
rules the MCP `task_start` verb already did, the backend error surface
gets a typed `AppError` hierarchy with a central handler, and the
`/api/mcp` endpoint gets a per-IP rate limit to cap AgentToken
brute-force risk.**

Nothing in this release requires an operator migration. The AppError
refactor deliberately preserves the `{error, message, details?}`
response envelope so MCP clients, the CLI, and the frontend see no
wire change; the new typed codes (`not_found`, `forbidden`,
`conflict`, `unauthorized`, `validation_error`) map byte-identically
to what the existing Hono helpers in `middleware/error.ts` already
emit.

### Added

#### `/tasks` list view + home widgets (#187)

- **New `/tasks` route** in the frontend — a first-class list view
  with filtering, grouping by project, and direct deep-links into
  each task's detail page. The home page's summary widgets now link
  into this view instead of the project-scoped board, so users land
  on a cross-project backlog in one click.

#### Rate limit on `/api/mcp` (#189)

- **300 req/min per IP** on `/api/mcp` (applies to all methods). The MCP endpoint is an
  AgentToken brute-force target: tokens are long opaque strings, and
  until now a bad-token burst would hit the DB lookup in
  `authMiddleware` unthrottled. 300/min is comfortably above a
  legitimate agent's cadence (`task_pickup → start → note → finish`
  is ~5 calls/logical-op) while still dampening blind token sweeps.
- Response carries the standard `X-RateLimit-Limit` /
  `X-RateLimit-Remaining` / `X-RateLimit-Reset` headers on every
  200/401/429. Limit is configurable via the existing
  `rateLimit({ windowMs, max })` middleware — no new env var.

#### Typed `AppError` hierarchy (#188)

- **New `backend/src/lib/errors.ts`**: `AppError` base + `NotFound`
  (404), `Unauthorized` (401), `Forbidden` (403), `Validation` (400),
  `Conflict` (409). Ported verbatim from the boardflow codebase
  before its archive. Throws map to the right HTTP status and the
  existing `{error, message}` envelope via a central
  `appErrorHandler` wired into `app.onError` (`lib/error-handler.ts`).
- **ZodError** now surfaces as `400 validation_error` with
  `details: [{path, message}]` instead of falling through to the
  generic 500 handler.
- **Migrated callers**: `WorkflowConflictError` in
  `routes/workflows.ts` now extends `ConflictError`; three ad-hoc
  `throw new Error(...)` in `services/sso.ts` domain validation now
  throw typed `ValidationError` / `ConflictError`; the blanket
  try/catch in `routes/sso.ts::PUT /teams/:teamId/sso` that
  mis-categorized infra errors as `400 bad_request` has been
  removed — real infra failures now correctly surface as 500 while
  typed validation/conflict errors still land as 400/409.

### Fixed

#### REST `/claim` now enforces MCP `task_start` gates (#185)

- **Closed a bypass**: until this release, the REST `POST
  /api/tasks/:id/claim` route did not run the full transition-rule
  stack that MCP `task_start` already did. A client could claim a
  task through REST that MCP would have rejected
  (branch-present precondition, confidence threshold, self-review
  guard). The route is now re-routed through `runTransitionRules` so
  both paths are gate-equivalent.

#### Dashboard card title overflow (#186)

- Long task titles no longer overflow the board-card width. Fixed
  with a `min-width: 0` + `truncate` pair on the card header; full
  title remains available via `title=` tooltip.

### Changed

- `routes/sso.ts::PUT /teams/:teamId/sso` no longer maps every thrown
  error to `400 bad_request`. Typed errors land as 400/409; untyped
  errors correctly reach the generic 500 handler. **API-visible
  behavior change**: infra failures (DB, crypto) that previously
  appeared as 400 now appear as 500 — a miscategorization fix, not a
  new failure mode.

### Dogfood

- **In-session MCP flow** (`task_pickup` / `task_start` / `task_finish`
  / `pull_requests_merge`) exercised end-to-end against the deployed
  backend today — verifies #185 transition-rule gates and #188
  AppError envelope stability on the currently-deployed surface.
- **Live HTTP probes** confirmed `/tasks` returns 200 on the frontend,
  `/api/health` is green, and the 404 path emits the `{error,
  message}` envelope unchanged from v0.8.0. The `X-RateLimit-*`
  headers on `/api/mcp` land with the post-tag redeploy (the live
  deployment is still pre-#189 at the time of tag cut).

## [0.8.0] - 2026-04-21

**Headline: Three-tier governance collapses `soloMode` +
`requireDistinctReviewer` into a single `governanceMode` enum with
intentionally distinct tiers, the identity broker lets project-pilot
provision users from a GitHub OAuth token, and the signal queue finally
cleans up after itself on terminal transitions.**

The governance-mode change is the load-bearing piece. The previous
two-boolean encoding permitted a nonsensical combo
(`soloMode=true + requireDistinctReviewer=true`) and forced the
frontend to hand-code mutual exclusion. After `self_merge_notice`
landed in #182 the middle tier grew a real identity of its own, so the
schema and UI now match the policy. Legacy columns stay readable
through one deprecation window — `resolveGovernanceMode` derives from
them when the enum column is null — but new code reads the enum.
Operators don't need to run a data migration; see **Migration** below.

### Added

#### Three-tier governance model (#182, #183)

- **New `GovernanceMode` enum**: `AUTONOMOUS`, `AWAITS_CONFIRMATION`,
  `REQUIRES_DISTINCT_REVIEWER`. Replaces the `soloMode` +
  `requireDistinctReviewer` pair throughout backend/frontend/docs. The
  middle tier (`AWAITS_CONFIRMATION`) is no longer just
  "requireDistinctReviewer turned off" — it has its own notification
  semantics (see `self_merge_notice` below).
- **Nullable `governanceMode` column** on `Project`
  (`backend/prisma/schema.prisma`). Existing rows stay on `null` until
  next write; `resolveGovernanceMode` (`backend/src/lib/governance-mode.ts`)
  derives from the legacy flags when null so the runtime is
  self-healing. Writes via the projects PATCH route update both the
  enum and the legacy columns in lockstep.
- **New `self_merge_notice` signal type** (#182). Emitted by
  `emitSelfMergeNoticeIfApplicable` when an `AWAITS_CONFIRMATION`
  project self-merges: every human team member (except the merging
  human) gets one signal, audit-logged as
  `task.self_merge_notice_emitted`. Solo mode and distinct-reviewer
  projects short-circuit the helper. This is what makes the middle
  tier meaningfully different from `AUTONOMOUS`.
- **New helper API** in `backend/src/lib/governance-mode.ts`:
  `resolveGovernanceMode`, `deriveGovernanceModeFromFlags`,
  `legacyFlagsFromGovernanceMode`, `governanceFlags`. Call-sites use
  these instead of reading the legacy flags directly so the
  deprecation ends as a single file change.

#### Identity broker — `register-from-project-pilot` (#176, #177, #178, #179)

- **New `POST /api/auth/register-from-project-pilot`**: accepts
  `{ githubAccessToken, githubLogin? }`, re-verifies the token
  against `api.github.com/user` (so a compromised broker cannot
  impersonate users), and returns `{ apiToken, userId, githubLogin }`
  where `apiToken` is a session JWT minted through the existing 7-day
  session machinery. Bearer middleware extended to accept either
  `AgentToken` or a session JWT (a revoked agent token cannot fall
  through to be re-interpreted as a session). GitHub network failures
  surface as `503` so the broker can retry without forcing a user
  re-auth.
- **Optional GitHub-login allowlist** via `ALLOWED_GITHUB_LOGINS` env
  (comma-separated). Empty / unset preserves accept-any back-compat.
  When set, `register-from-project-pilot` rejects unverified logins
  with `403 forbidden_github_login`. Stop-gap mirroring deploy-panel
  #57 while team-scoping is hardened for brand-new OAuth arrivals.
- **`docker-compose.prod.yml`** forwards `ALLOWED_GITHUB_LOGINS` into
  the backend container (defaulting to empty).
- **Single-team teamId auto-default** — `services/team-access.ts::
  resolveTeamId` centralises team resolution across `GET /api/projects`,
  `/projects/available`, `/projects/by-slug`, `/tasks/claimable`, and
  `/api/agent-tokens`. Session-based humans with exactly one team
  membership no longer need to pass `?teamId=`; zero or multiple
  memberships return `400` with the team list. Fixes "API error:
  400" on the tasks page right after sign-in via the broker.

### Changed

- **Self-review guard respects governance mode** (#181). The three
  inline self-review checks in `routes/tasks.ts` (task_start v2
  review-claim, legacy `/tasks/:id/review`,
  `/tasks/:id/review/claim`) all now delegate to
  `checkDistinctReviewerGate`, which learned a `soloMode` bypass
  mirroring the existing `checkSelfMergeGate` escape hatch. Before:
  solo projects returned `403 "Cannot review your own task"`,
  stranding the task in `review`. After: solo projects can re-claim
  the review as the author, consistent with the rest of the gate
  story.
- **Signal auto-ack on terminal transitions** (#180).
  `acknowledgeSignalsForTask(taskId)` is now called on every path
  that moves a task to `done`: `/finish` (both work and approve-review
  outcomes with a terminal target), `PATCH /tasks/:id` with
  `status=done`, and the GitHub webhook's `issues.closed` /
  `pull_request.closed → done` paths (solo + custom-workflow).
  `task_pickup` additionally filters out signals whose underlying
  task is `done` as defence-in-depth.
- **Project-update audit payload extended** (#183). `PATCH
  /api/projects/:id` continues to emit `project.updated`, but the
  `payload.changes` object now includes a `governanceMode: { from, to }`
  entry whenever the enum changes (alongside the existing
  `soloMode` / `requireDistinctReviewer` entries that fire when the
  legacy flags are written directly). Audit consumers grouping on
  `payload.changes` keys should expect the new field.

### Deprecated

- **`Project.soloMode` and `Project.requireDistinctReviewer`** —
  marked `@deprecated` in `schema.prisma`; kept readable for one
  release cycle so dashboards and external clients can migrate. Code
  paths that read these directly should switch to
  `resolveGovernanceMode(project)`. Planned removal: v0.9.0.

### Documentation

- `docs/agent-workflow.md`, `docs/api-contract.md`,
  `docs/review-automation-policy.md`, `docs/signal-payload-design.md`,
  `docs/workflow-preconditions.md` all updated to the new
  `governanceMode` vocabulary.

### Migration

Operators running agent-tasks in production should read this before
rolling out.

1. **No data migration required** for `governanceMode`. The new column
   is nullable, and `resolveGovernanceMode` derives the right answer
   from the legacy `soloMode` / `requireDistinctReviewer` flags when
   the enum is null. The mapping is:

   | Legacy flags                                      | `governanceMode`              |
   | ------------------------------------------------- | ----------------------------- |
   | `soloMode=true` (either DR value — DR was a no-op) | `AUTONOMOUS`                  |
   | `soloMode=false`, `requireDistinctReviewer=true`  | `REQUIRES_DISTINCT_REVIEWER`  |
   | `soloMode=false`, `requireDistinctReviewer=false` | `AWAITS_CONFIRMATION`         |

   Rows get the column populated on next write via the projects PATCH
   route (which keeps both representations in sync). External clients
   reading the `soloMode` / `requireDistinctReviewer` booleans
   continue to work unchanged through the deprecation window.

2. **Async HITL projects now emit `self_merge_notice` signals.** Any
   project with `soloMode=false, requireDistinctReviewer=false`
   (= `AWAITS_CONFIRMATION`) will, on self-merge, emit one
   `self_merge_notice` signal per human team member (excluding the
   merger). If your signal consumers weren't prepared for a new
   signal `type`, extend them accordingly; unknown types are
   currently safe to ignore.

3. **Set `ALLOWED_GITHUB_LOGINS` if you run the identity broker.**
   `POST /api/auth/register-from-project-pilot` is reachable by any
   verified GitHub user when the env var is empty/unset. For
   production instances, set a comma-separated allowlist in `.env`;
   `docker-compose.prod.yml` already forwards it. Leaving it unset
   preserves the old accept-any behaviour for development.

4. **Session JWTs are now accepted on Bearer.** The auth middleware
   previously treated `Authorization: Bearer …` as agent-token only.
   Any upstream proxy that used that distinction to route traffic
   needs to be aware that a session JWT may now arrive via the same
   header.

### Internals

- 555 backend tests passing (up from 495 at v0.7.0) — governance-mode
  derivation, self-merge-notice dispatch, review-lock bypass, PR-merge
  target picker, and signal-ack paths all have inline coverage.
- No schema-breaking changes. The `GovernanceMode` enum and
  `governanceMode` column are additive; legacy columns unchanged.
- MCP packages unchanged this release — `mcp-server` + `mcp-bridge`
  remain at 0.4.0 (tagged separately under #175).

## [0.7.0] - 2026-04-18

**Headline: Typed artifacts pipeline stages can hand to each other,
server-side PR create + merge with a structural self-merge gate, and
the settings UI now reads its scope list from the backend so the two
can no longer drift.**

Two load-bearing feature releases plus the ops-side finish that keeps
`sso:admin` from silently disappearing again. The migration story for
operators is small but real: tokens minted before v0.7 that opened or
merged PRs through agent-tasks need to be re-minted with the new
`github:pr_create` / `github:pr_merge` scopes. See **Migration** at
the bottom.

### Added

#### Typed task artifacts (#171)

- **New `TaskArtifact` model** distinct from `TaskAttachment`. Typed,
  agent-produced task outputs — `build_log`, `test_report`,
  `generated_code`, `coverage`, `diff`, `other`. Attachments remain
  the human-uploaded metadata surface with no semantics.
- **REST**: `POST /api/tasks/:id/artifacts` (create, scope
  `tasks:update`), `GET /api/tasks/:id/artifacts` (list, metadata
  only), `GET /api/tasks/:id/artifacts/:artifactId` (single, with
  `content`), `DELETE /api/tasks/:id/artifacts/:artifactId` (creator
  or project admin). Inline payload capped at **1 MiB** with a
  runtime UTF-8 byte-length re-check — multi-byte overflow is a
  `413`, not a truncated blob. URLs capped at 2048 chars.
- **MCP v2 verbs**: `task_artifact_create`, `task_artifact_list`,
  `task_artifact_get`. Typical pipeline pattern: Stage N reads Stage
  N-1's typed outputs via `task_artifact_list` + `task_artifact_get`
  instead of scraping comments.
- **UI**: task-detail modal gains an Artifacts section grouped by
  type, lazy content fetch, text preview, blob download. Delete
  affordance for creator + project admin (backend re-validates).
- **Audit**: `task.artifact.created` / `task.artifact.deleted`
  entries with type, size, and actor payload.
- **Docs**: new `docs/artifacts.md` with the full contract, storage
  limits, audit catalogue. Known gap documented: no per-task
  aggregate count cap yet (tracked as a follow-up).

#### Server-side PR lifecycle + self-merge gate (#172)

- **New `task_merge` MCP verb** and `POST /api/tasks/:id/merge` REST
  endpoint — task-scoped merge that derives owner/repo/PR number
  from the task's project metadata. Preferred over the older
  `pull_requests_merge` tool for anyone holding a task id.
- **Self-merge gate** (`services/review-gate.ts::checkSelfMergeGate`)
  shared by all four merge paths: the new `task_merge` route, the
  existing `POST /api/github/pull-requests/:n/merge`, and both
  `autoMerge: true` branches of `task_finish`. Blocks
  `actor == work-claim holder` when
  `project.requireDistinctReviewer=true && project.soloMode=false`.
  Runs before the broader distinct-reviewer gate so callers receive
  the narrower `self_merge_blocked` error code rather than the
  generic `forbidden`. Rejected attempts audit as
  `task.pr_merged.blocked_self_merge` with the via-tag, actor,
  claimant, and task id.
- **New token scopes** `github:pr_create` and `github:pr_merge`
  (`services/scopes.ts::ALL_SCOPES`). `POST /api/github/pull-requests`
  now requires `tasks:update` **and** `github:pr_create`;
  `POST /api/github/pull-requests/:n/merge` requires
  `tasks:transition` **and** `github:pr_merge`. Existing tokens do
  **not** auto-gain the new scopes — operators re-mint.
  Token-creation validates with `z.enum(ALL_SCOPES)` so typos like
  `github:pr-create` fail loudly at mint time instead of producing a
  permanently-403'd token.
- **Un-deprecated** `pull_requests_create` and `pull_requests_merge`
  MCP tools. Descriptions updated to document the new scope
  requirements; the historic `gh` CLI fallback path still works for
  orgs that prefer not to share a GitHub identity with agent-tasks.
- **Audit**: new `task.merged` (successful server-side merge via the
  new verb) and `task.pr_merged.blocked_self_merge` actions.

#### Canonical scope list endpoint (fix/scope-ui-backend-drift)

- **New `GET /api/agent-tokens/scopes`** returns `{ id, label }[]`
  from `services/scopes.ts::ALL_SCOPES` / `SCOPE_LABELS`. The
  settings UI fetches from it instead of hard-coding its own list,
  so the two sources of truth can't drift again (they already had —
  the new GitHub scopes were invisible in the UI before this fix).

### Fixed

- **`sso:admin` scope was silently excluded** when #172 narrowed the
  token-creation schema to `z.enum(ALL_SCOPES)`. Minting a token
  with that scope was returning 400 even though `routes/sso.ts` was
  still enforcing it at runtime. Re-added to `ALL_SCOPES`; a new
  regression test pins the scope in place.
- **Non-solo default-workflow tasks** now land in `review` when their
  PR merges on GitHub, instead of skipping straight to `done` and
  stranding downstream `task_finish` calls with 409s. (#169)

### Documentation

- `docs/agent-workflow.md` gains a "Server-side PR lifecycle"
  section describing the new `task_merge` flow, the self-merge
  rejection semantics, the scope-by-scope matrix, and a legacy
  gh-CLI fallback block clearly labelled as such.
- `docs/api-contract.md` adds entries for the new artifact routes,
  the new `/tasks/:id/merge`, and the two github-delegation routes
  with their scope requirements.
- Policy-matrix + handler note (#170) — documents that the two stay
  in lockstep, no code change.

### Migration

Operators running agent-tasks in production should read this before
rolling out.

1. **Re-mint tokens that open or merge PRs.** Any token that used
   `pull_requests_create` or `pull_requests_merge` pre-v0.7 was
   silently passing with `tasks:update` / `tasks:transition` alone.
   Starting with this release those paths also require
   `github:pr_create` / `github:pr_merge`. Expect 403 until
   re-minted. The Settings UI surfaces the new scopes once
   #fix-scope-ui-drift is deployed.
2. **Self-merge rejection is new.** Projects with
   `requireDistinctReviewer=true && !soloMode` will now refuse to
   merge when the actor is the work-claim holder, including via
   `task_finish { outcome: "approve", autoMerge: true }`. Workflows
   that relied on a single-agent approve+merge need a second actor
   or need to opt the project into `soloMode`.
3. **`sso:admin` tokens minted between #172 and the hotfix**
   silently dropped the scope. If any such token exists, re-mint
   it — the SSO routes still enforce the scope at request time, so
   those tokens will 403 on SSO admin calls.

### Internals

- 493 → 495 backend tests (gate + scope-validation + token-route
  tests added inline with the feature commits).
- No schema-breaking changes; the `TaskArtifact` table is new
  (additive), no existing columns renamed.

## [0.6.0] - 2026-04-17

**Headline: Frontend polish release — theming lands in Settings,
dashboard widgets load faster, and task-row elements no longer
break out of their containers.**

### Added

- **Light / dark / system theme toggle** — preference persisted in
  localStorage; follows `prefers-color-scheme` while set to
  "system". Inline `<head>` init script resolves the theme before
  first paint (no FOUC). Light-theme CSS overrides core tokens plus
  rules with hard-coded dark hexes (form controls, task list, view
  toggle, modals, alerts, filter chips, dropdowns, landing card,
  prose blockquote). Vitest coverage for resolution, cycling,
  persistence, restore, live `prefers-color-scheme` change, and
  invalid stored-value fallback. (#163)
- **`taskListInclude`** — lightweight backend include for task-list
  endpoints (no comments/attachments); `detail=full` query param
  opts into the full includes on demand. (#162)
- **Server-side status filter** on the task list endpoint. (#162)

### Changed

- **Theme toggle lives in Settings** — new `ThemePreferenceField`
  (radio group System / Light / Dark with `aria-checked`) in an
  Appearance section under `/settings`, with an anchor in the
  in-page nav. Removed from `AppHeader`, the landing header, and
  the `ThemeCorner` fallback on auth / onboarding / error / SSO
  pages. (#165)
- **Dashboard polling interval** 5s → 15s — less background chatter
  for the same perceived freshness. (#162)

### Performance

- **Dashboard widget load time reduced** — parallelized
  `getCurrentUser` + `getTeams` via `Promise.all`, `TaskCard`
  wrapped in `React.memo` to avoid unnecessary re-renders, and the
  list endpoint no longer overfetches comments/attachments. Task
  detail still loads the full payload when a modal opens. (#162)

### Fixed

- **Home widget no longer overflows for long metadata** — the
  `projectName` span and `externalRef` pill in the home-page
  TaskRow now cap at 8rem / 6rem with ellipsis truncation plus
  `minWidth: 0`, so they shrink inside the `minmax(0, 1fr)` grid
  column instead of forcing the row wider than its Card. `title=`
  attrs preserve the full value on hover. (#166)
- **Dashboard TaskCard no longer stretches for long labels** — each
  label span and the `externalRef` pill now use `maxWidth: 100%` +
  `overflowWrap: anywhere`, so unbreakable 40+ character tokens
  wrap inside the card instead of pushing the kanban column wider.
  `title=` attrs added for consistency. (#167)

## [0.5.0] - 2026-04-16

**Headline: Custom workflows now work end-to-end with v2 MCP verbs,
and the first predefined workflow template ships out of the box.**

This release closes the "custom workflows are cosmetic" gap — agents
using the MCP surface (`task_start`, `task_finish`, `task_abandon`,
`claim`, `release`) can now operate on projects with non-default
state machines. The AI Coding Agent Pipeline template provides a
ready-made 7-stage workflow for coding-focused teams.

### Added

#### Workflow templates
- **Predefined workflow templates** — `GET /api/workflow-templates`
  lists available templates; `POST /api/projects/:id/workflow/apply-template/:slug`
  applies one to a project in a single call. (#159)
- **AI Coding Agent Pipeline** (`coding-agent`) — 7-stage template:
  `backlog → spec → plan → implement → test → review → done` with
  gates on `branchPresent` (plan→implement) and
  `branchPresent`+`prPresent` (test→review). Each state carries
  `agentInstructions` for MCP agents. (#159)
- Template picker buttons in the workflow editor UI alongside
  "Customize this workflow". (#159)

#### v2 verbs workflow-aware
- **Semantic state helpers** — `isInitialState`, `isTerminalState`,
  `isReviewState`, `isWorkState`, `firstTransitionTarget`,
  `approveTarget`, `requestChangesTarget` derive state roles from
  any `WorkflowDefinitionShape`. (#160)
- **task_start** uses `initialState` instead of hardcoded `"open"`,
  `isReviewState` instead of `"review"`, dynamic transition target
  instead of `"in_progress"`. (#160)
- **task_finish** work branch accepts any work state, review branch
  derives approve/request_changes targets from workflow transitions,
  claim clearing uses `isTerminalState`. (#160)
- **task_abandon** resets to `initialState` instead of `"open"`. (#160)
- **claim/release** use workflow-derived targets. (#160)
- `resolveProjectEffectiveDefinition` for task creation without a
  task object. (#160)

#### Solo mode & autoMerge (ADR-0010)
- **`task_finish { autoMerge: true }`** — atomic PR merge + task
  transition in a single call. Mode A (solo work-claim) and Mode B
  (reviewer-triggered). (#155)
- **`project.soloMode`** flag — enables Mode A for single-agent
  projects that skip distinct review. (#155)
- ADR-0010 documenting the design. (#154)

#### task_submit_pr
- **`POST /tasks/:id/submit-pr`** — new v2 verb to register branch +
  PR on a task with validation and authorship verification. (#152, #156)
- Cross-repo PR rejection hardening. (#156)

#### Gate enforcement
- **task_start** now evaluates workflow transition gates (was
  previously a no-op). (#153)
- **task_finish** evaluates gates before transitioning. (#151)
- `branchPresent` removed from `open→in_progress` default edge to
  avoid structural self-checkmate with `task_submit_pr`. (#153)

### Fixed

- **v1 /transition** skipped project-default workflow lookup (step 2
  of ADR-0008 §50-56 resolution chain). Extracted
  `resolveEffectiveDefinition` helper, DRY'd 6 inline blocks. (#158)
- **Security sweep** — bumped hono (JSX SSR injection), follow-redirects
  (auth header leak), dompurify (ADD_TAGS bypass). (#157)

## [0.4.0] - 2026-04-15

### Added

- **v2 verb-oriented MCP surface** — `task_start`, `task_finish`,
  `task_pickup`, `task_abandon`, `task_note` replace the CRUD-style
  v1 tools. Agents interact via lifecycle verbs instead of raw
  status strings. (#150)
- `@agent-tasks/mcp-server` 0.3.1 and `@agent-tasks/mcp-bridge` 0.3.0
  updated to expose the v2 tools.

## [0.3.0] - 2026-04-15

**Headline: MCP agents can now drive the full review loop, and the
one-click onboarding flow got a security and reliability pass.**
`@agent-tasks/mcp-server` ships five new tools that close the last
CLI-parity gap so agents no longer have to fall back to REST to
approve, request changes, or hold a review lock. Plus real fixes for
two production rough edges — the signal service no longer under-reports
partial writes, and the GitHub token-health probe stops flashing
"Token revoked" when users just brushed against a rate limit.

### Added

#### MCP CLI parity
- **`@agent-tasks/mcp-server` 0.3.0** — five new tools:
  - `projects_get` — fetch a single project by slug or UUID
    (`GET /api/projects/:slugOrId`, auto-routes)
  - `review_approve`, `review_request_changes` — wraps
    `POST /api/tasks/:id/review` with the two actions
  - `review_claim`, `review_release` — acquire and release the
    single-reviewer lock
- All five mirrored in the HTTP MCP peer at `POST /api/mcp`, so
  remote / stateless clients (Triologue's `mcpBridge`, custom MCP
  clients) get them too. Stdio + HTTP transports now both expose
  the same 20 tools.
- Fully typed, documented in `mcp-server/README.md`, covered by
  unit tests on both surfaces.

#### Audit forensics
- `workflow.customized` audit events now carry a
  `forkedFromDefault` snapshot (`stateCount`, `transitionCount`,
  `stateNames[]`, `initialState`) so an auditor looking at an old
  row can reconstruct what the user actually forked even after
  `DEFAULT_STATES` drifts. No change to the customize endpoint's
  HTTP response — audit-payload only.

#### Connect modal hardening
- **Token masking after copy** — 30s after the user clicks
  "Copy snippet", the raw token in the `<pre>` is replaced with
  `••••••••` while the surrounding command stays readable. A
  "Reveal token" button restores it on demand. Closes the
  shoulder-surfing / DOM-scrape window without disrupting the
  one-click flow.
- **`AbortSignal` plumbing** — `createAgentToken` now accepts an
  optional `{ signal }` options bag; `ConnectAgentModal` creates a
  fresh `AbortController` per effect run and calls `abort()` in
  cleanup. Closing the modal mid-flight cancels the actual fetch
  instead of just ignoring the response server-side.
- **HTTP MCP transport disclosure** — a collapsed `<details>`
  under the MCP tab with a ready-to-paste
  `claude mcp add --transport http agent-tasks <base>/api/mcp`
  snippet for remote / headless agents that can't spawn a stdio
  subprocess. Shares the same copy / mask pipeline as the main
  snippet.

### Fixed

#### Signals
- **`emitForceTransitionedSignal` partial-write handling** — the
  recipient loop used to be wrapped in a single try/catch, so a
  failure on recipient N would return `0` even if N-1 signals had
  already persisted, and the failing recipient was silently
  dropped. Each iteration now has its own try/catch with a
  targeted error log; the return value accurately reports the
  number of signals written.

#### GitHub health probe
- **403 rate-limit vs genuine revocation disambiguation** — a user
  who briefly tripped a GitHub secondary rate limit saw a false
  "Token revoked, reconnect" banner in Settings, because the probe
  collapsed every 403 into `invalid`. `classifyProbeResponse` now
  inspects the response headers and body: `x-ratelimit-remaining=0`
  / `retry-after` / a rate-limit mention in `body.message` →
  `unknown` (transient, preserves the last definitive state); any
  other 403 → `invalid` (genuine OAuth app revocation or scope
  downgrade). Backward-compatible signature with defaulted params.

### Changed

- `@agent-tasks/backend` and `@agent-tasks/frontend` bumped
  `0.2.0 → 0.3.0` to match the release tag. `@agent-tasks/mcp-bridge`
  stays at `0.2.0` — no changes this cycle.

## [0.2.0] - 2026-04-14

**Headline: Agents can now connect themselves.** Onboarding a new agent is
a copy-paste from Settings instead of a config file, and a single agent can
no longer both open and merge a PR for the same task.

### Added

#### Agent onboarding
- `@agent-tasks/mcp-bridge` — zero-setup MCP distribution via `npx`, with
  OS keychain login so credentials don't live in config files
- "Connect your agent" modal in Settings: inline API token generation and
  per-client install snippets (Claude, Cursor, Continue, generic MCP)
- Full npm metadata (repository, homepage, bugs, license) on the published
  `@agent-tasks/mcp-server` and `@agent-tasks/mcp-bridge` packages

#### Governance
- **Distinct-reviewer gate**: a task's reviewer must be a different actor
  than the one who moved it into review. Enforced at every transition and
  at the merge endpoint, not just in the UI.
- Per-project toggle `requireDistinctReviewer` with default-on for new
  projects
- Merge endpoint refuses delegated merges when the authenticated actor is
  the same agent that requested the review

#### MCP tools
- New MCP tools for GitHub delegation: `pull_requests_create`,
  `pull_requests_merge`, `pull_requests_comment` — agents can now drive
  their own PR lifecycle entirely through MCP without falling back to the
  REST API

### Changed

- Connect-agent flow moved from the dashboard header into `Settings` where
  it belongs; the dashboard button was removed
- `mcp-server` and `mcp-bridge` bumped to `0.2.0` on npm (shipped
  separately in the previous release cycle, now aligned with the main
  app version)

### Security

- Swept 3 medium Dependabot alerts:
  - vitest chain in `mcp-bridge` + `mcp-server` bumped 2.1 → 3.2.4
    (pulls patched vite ≥7.3.2, esbuild ≥0.27)
  - `scaffold/requirements-dev.txt` pytest floor bumped to 9.0.3

## [0.1.0] - 2026-04-13

Initial public release of agent-tasks — enforced workflows for human-agent delivery.

### Added

#### Workflow Engine
- Declarative workflow states and transitions with server-side enforcement
- Transition preconditions: `reviewApproved`, `ciGreen`, `prMerged`, `hasAssignee`
- Admin force-transition with audit trail
- Customizable per-project workflows with reset-to-default
- Default workflow gating for projects without custom configuration

#### Task Management
- Board (Kanban) and list views with filter, sort, and search
- Task templates with confidence scoring for agent claim gating
- Task dependencies (blocks / blocked-by)
- Task comments for humans and agents
- External reference (`externalRef`) and labels fields
- Batch import endpoint for bulk task creation

#### Agent Integration
- Agent auth via scoped API tokens
- Signal inbox API — pull-based durable signals (`review-needed`, `changes-requested`, `task_available`, `force-transitioned`)
- Signal acknowledgement with status filtering
- Authoritative `/instructions` endpoint for agent decision-making
- MCP server (`@agent-tasks/mcp-server`) — expose API as MCP tools over stdio
- HTTP MCP endpoint at `POST /api/mcp` (stateless Streamable HTTP)

#### GitHub Integration
- GitHub OAuth login
- Branch and PR linking to tasks
- Webhook ingestion: `pull_request`, `pull_request_review` events
- Prioritized Task-PR binding strategy
- Agent delegation: create PRs, merge, post comments on behalf of agents
- Delegation consent UI and audit logging
- GitHub token health monitoring with lazy probe

#### Review System
- Review actions: approve / request changes
- Single-reviewer lock to prevent concurrent reviews
- Review orchestration with assignee preservation
- Webhook-driven review automation

#### Import & Migration
- CSV/Excel import dialog with Jira column auto-detection
- Confluence Wiki Markup to Markdown auto-conversion
- Jira import CLI tool (`tools/jira-import`)

#### Enterprise
- OIDC SSO (team-scoped) with admin configuration UI
- SSO scope gating on agent tokens

#### Frontend
- Next.js 15 with React 19 and App Router
- Design token system with CSS-driven states
- Custom component library: Select, ConfirmDialog, AlertBanner, DropdownMenu
- Responsive layout with mobile support
- Markdown rendering for description and template fields
- Keyboard shortcuts and dirty-check in task modal
- Relative time formatting
- Landing page and `/auth` route

#### Operations
- PostgreSQL 16 with Prisma ORM
- Docker Compose for development and production (Traefik)
- CI pipeline (GitHub Actions): typecheck + tests for backend and frontend
- Redis-backed GitHub checks cache for multi-instance deploys
- Queryable audit logging for all critical operations

#### Documentation
- Architecture docs, domain model, API contract (OpenAPI)
- 7 Architectural Decision Records (ADRs)
- Getting started guide, webhook setup guide, agent workflow guide
- Enterprise SSO documentation
- Workflow preconditions reference
- Deploy/verify integration strategy
