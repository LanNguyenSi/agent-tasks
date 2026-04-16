# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
