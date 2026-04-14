# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
