# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
