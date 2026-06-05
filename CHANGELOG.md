# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.23.0] - 2026-06-05

**Headline: the scorer-v2 frontend surface. The dashboard now mirrors the backend prose-first confidence scorer (the live badges match what the agent-claim gate computes), surfaces the create-time confidence verdict after a task is created (the score versus the project threshold, the missing fields, and the top next steps, with an Edit-task shortcut straight into the editor), and lets a human author all the scorer-v2 executability fields (scope, out-of-scope, dependencies, risk, agentPrompt, taskType) in both the create and edit forms. The Save data-loss that wiped producer-set templateData on a human edit is fixed.** No backend schema changes; the backend scorer-v2 and the create-time confidence response shipped in v0.22.x.

Operator note: no breaking changes. Per the convention since v0.9.0, workspace `package.json` versions are not bumped (frontend and backend stay 0.3.0; `@agent-tasks/mcp-server` 0.8.0 and `@agent-tasks/mcp-bridge` 0.7.0 are unchanged). One visible behaviour change: the confidence badge numbers move from the old client-side v1 scorer to the prose-first values, which is intended, they now match the gate. The frontend was deployed and the UI flows (create badges, the create-time confidence panel, the Edit-task shortcut, the new create-form editors) were operator-verified; the create-time confidence response was verified live via the create path.

### Added

- **Create-time confidence on the task-create modal** (#320): after a successful create, the New Task modal shows the backend's authoritative scorer-v2 verdict (the score versus the project threshold, the missing fields, and the top next steps) instead of just closing. `createTask` now returns `{ task, confidence }`; the panel renders the server value, not a recomputed client one. A self-assignment failure is shown in the panel rather than hidden behind the modal overlay, and the panel takes focus and announces its verdict for keyboard and screen-reader users.
- **Edit-task shortcut from the confidence panel** (#321): the post-create panel's primary action opens the just-created task directly in the editor in edit mode, so the missing fields the panel listed are ready to fill. Normal task opens stay in view mode.
- **Author the executability fields at creation time** (#322): the create modal gains gated editors for scope, out-of-scope, dependencies, risk, and agentPrompt, plus a Task Type select, mirroring the task editor. Preset chips now copy these fields too. The create and edit forms write templateData through one shared helper.

### Fixed

- **Save no longer wipes producer-set templateData** (#319): editing a task in the UI rebuilt templateData from only the four rendered editors, so a human Save erased fields a producer had set over MCP (scope, out-of-scope, dependencies, risk, agentPrompt, prefers, taskType). Save now reconstructs the complete object from the stored data plus the editors (a non-empty value sets a key, an empty one clears it), keeping the backend full-replace contract intact.

### Changed

- **Frontend confidence scorer synced to the backend** (#319): the dashboard's client-side scorer that drives the board badge, the create-form live badge, and the task-detail badge was the drifted v1 model; it is now a faithful mirror of the prose-first scorer-v2 (fixed-denominator weights, the evals keystone cap, subscores, and score caps), with its computed outputs (score, blocking, missing, subscores, findings) asserted against backend ground truth in the test suite. The badges now match what the agent-claim gate computes. The new templateData executability fields and taskType are surfaced in the frontend types and the task editor, and the duplicated TemplateData type now has a single owner.

## [0.22.0] - 2026-06-04

**Headline: task file attachments. Humans can upload image and text files to a task (drag-drop or file picker), view image thumbnails with a lightbox and download text files, and delete their own; the bytes live on a disk volume and the database holds metadata only. Agents can read attachments (text excerpt or base64) so a pipeline stage can consume an uploaded spec, document, or screenshot.** Additive schema, applied by the existing `prisma db push` migrate step.

Operator note: a new `agent_tasks_uploads` named volume holds the uploaded files. It is NOT covered by the Postgres backups, add it to the VPS backup scope. The schema change is additive (nullable columns plus a defaulted `type`), so the migrate container's `prisma db push` is safe for existing rows. Released alongside: `@agent-tasks/mcp-server` 0.8.0 (the two new read verbs) and `@agent-tasks/mcp-bridge` 0.7.0 (re-pins the server); the frontend and backend workspace `package.json` versions stay unchanged per the convention since v0.9.0. Backend and frontend were deployed and dogfooded; the human-upload UI path is an operator visual check.

### Added

- **Task file attachments: backend upload, serve, delete** (#308): `POST /api/tasks/{id}/attachments/upload` stores an image (jpeg/png/gif/webp) or text (plain/markdown/csv) file on the `UPLOAD_DIR` disk volume, capped at 5 MiB and validated by a magic-byte sniff so the served type never trusts the client `Content-Type` (no SVG/PDF/JSON). `GET .../{attId}/raw` streams the bytes auth-gated with `X-Content-Type-Options: nosniff` and an inline (image) or attachment (text) disposition, so a same-origin `<img src>` works on the session cookie. Delete is uploader-or-admin and removes the row plus the file; task and project deletion also reclaim the backing files. New audit events `task.attachment.uploaded` / `task.attachment.deleted`. The legacy URL-pointer attachment POST now rejects non-http(s) URLs (a stored-XSS guard).
- **Task Attachments section in the task detail** (#309): the shared `TaskDetail` (board modal and `/tasks/[id]` page) gains an Attachments section with drag-drop and file-picker upload (client-side type and size pre-check, busy state), an image thumbnail grid with a focus-managed lightbox, text rows with size and a download link, and a two-step inline delete confirm for the uploader.
- **Agent read of attachments over MCP** (#310): `GET /api/tasks/{id}/attachments` (metadata list) and `GET .../{attId}/content` (a UTF-8 text excerpt for text files, or base64 for images) let agents consume uploaded files, exposed as the `task_attachment_list` and `task_attachment_get` MCP verbs (read-only; agents still cannot upload or delete, they produce artifacts for their own output). Byte caps default 200 KB text / 64 KB base64, clamped at 800 KB / 512 KB.

## [0.21.0] - 2026-06-04

**Headline: the modal and navigation UX pass. The shared Modal primitive gains an accessible X-close, a sticky header over a scrolling body, and thinner scrollbars; the task detail can be maximized from the board modal into a deep-linkable `/tasks/[id]` page; and the Agent Template Settings move out of a dashboard modal onto a dedicated `/projects/[id]/settings` page. Plus list-title clipping fixes and a server-side done-recency filter with pagination so older done tasks are reachable again.** No backend schema changes.

Operator note: no breaking changes. Per the convention since v0.9.0, workspace `package.json` versions are not bumped (frontend and backend stay 0.3.0; `@agent-tasks/mcp-server` 0.7.0 and `@agent-tasks/mcp-bridge` 0.6.3 unchanged). The UI was dogfooded by the operator; CI is green per PR and re-runs on the release tag.

### Added

- **Maximizable task detail with a deep-linkable `/tasks/[id]` page** (#305): the board's task detail modal gains a maximize control that opens the same detail as a full page. A shared `TaskDetail` component (a `variant` prop) renders identically in the modal and on the page, so the two never drift. Save and Cancel stay pinned, Escape-to-close stays modal-only, and the maximize control is hidden while editing so an in-flight edit is never dropped.
- **Agent Template Settings on a dedicated `/projects/[id]/settings` page** (#306): the settings form (governance mode, notification webhook, template fields, confidence threshold, presets) moves out of the dashboard modal onto its own page reached from the gear icon, so it has room once the template is enabled. The dashboard sheds the modal, its state, and the now-unused imports.

### Changed

- **Modal primitive polish** (#304): the header "Close" text becomes an accessible X icon button; the modal restructures into a sticky header, a scrolling body, and a pinned footer so the scrollbar lives in the body only and never reaches the top edge (scoped to a `modal-card--framed` modifier, so `ConfirmDialog` is untouched); global scrollbars are thinner (8px with a 1px thumb) with Firefox `scrollbar-width` and `scrollbar-color` in both themes, and the modal body reserves its scrollbar gutter to avoid horizontal content shift.
- **Server-side done-recency filter and pagination on the tasks list** (#303): `GET /teams/:teamId/tasks` gains server-side recency (recent within 14 days, older, or all), plus search, single-project, mine, sort, and offset params, a `filteredTotal` for pagination, and team-wide `doneRecent` / `doneOlder` counts. The `/tasks` page is now paged from the server with Recent / Older / All chips on the done scope, fixing the prior limitation where done tasks older than 14 days (around 500 of them) were unreachable behind the 1000-task client cap. The home "Recently Done" widget links are restored from the authoritative server counts.

### Fixed

- **Long task titles are clipped in the list view** (#301): every `.task-list-cell-*` gets `min-width: 0` so the title's ellipsis clamps inside its own cell instead of overlapping the Status and Project columns; the Due cell is clamped to match.
- **Dashboard list titles are clipped, with mobile field labels** (#302): the dashboard list title span gets `display: block` so its ellipsis actually clips, the muted cells are clamped the same way, and `data-label` attributes label each value in the stacked mobile layout.

### Notes

- No database schema changes. This release is frontend UX work plus one backend tasks-listing change (#303); the live deployment updates separately.

## [0.20.0] - 2026-06-03

**Headline: the deferred long tail of the 2026-06-03 UI/UX audit, a frontend polish pass across every page (home, dashboard, task modal, tasks list, teams, settings, members/invite, and the auth/onboarding/landing funnel) with a set of new shared design-system primitives, accessibility wins throughout, plus the backend half of the ESLint setup wired into CI.** No backend schema changes.

Operator note: no breaking changes. Per the convention since v0.9.0, workspace `package.json` versions are not bumped. The frontend changes are validated by CI (all jobs green on the release commit), per-PR review, and local build; the live deployment updates separately.

### Added

- **Shared design-system primitives** (#292): a `FullPageLoader` (centered spinner + page-shell skeleton variants, `role="status"`), a `.collapsing-grid` utility for two-column form grids that collapse on phones, and a theme-aware `--shadow-lg` token; plus `Button` `link` / `link-danger` variants for unboxed inline actions (#293) and a shared `roleLabel()` helper for friendly role names (#297).
- **Remaining German UI strings on home and dashboard translated to English** (#288).

### Changed

- **Home and dashboard polish** (#292): the loading skeleton renders at the page-shell width (no bootstrap jump), a real `<h1>` fronts the widgets, the "older done" reveal link is no longer hidden behind "+N more", `TaskRow` announces a clean `aria-label`, the widget links get a real hit area, board column headers stick while scrolling, and the status summary renders in both views. `AppHeader` and `Select` move off hardcoded sizes and radii onto design tokens.
- **Task detail modal** (#293): "Submit for review" stays visible (disabled with a hint) when a branch or PR is missing, the review and comment textareas get labels and a Cmd/Ctrl+Enter submit, dates are unified via a shared formatter, the agent-result clamp is driven by measured overflow, and destructive inline actions (delete comment, remove dependency) get an inline confirm.
- **Tasks list** (#294): the search input is debounced, multi-team accounts get a team switcher, mobile rows get inline field labels, sortable headers announce their sort state, and the 1000-task cap banner is reworded.
- **Teams and projects** (#295): a team switcher, valid `ProjectCard` markup (the menu button is no longer nested in the card link), a kebab icon with a resting affordance, decoupled sync and delete feedback banners with a dismiss, non-reflowing task-count chips via `Promise.allSettled`, and an app-wide `FormField` label-to-control association (`useId` + `htmlFor` for native inputs, `ariaLabel` for the custom `Select`).
- **Settings** (#296): the one-time token reveal masks itself after a delay with a Reveal button, the Agent Permissions checkboxes are truly disabled when GitHub is not connected and Save tracks unsaved changes, API token rows show created, last-used, and expiry, the custom-token form becomes a modal, and the SSO delete uses the shared confirm dialog.
- **Members and invites** (#297): the page is honestly titled "Project invites", revoking an invite is confirmed, the sign-in CTA is valid markup, and loading uses skeletons.
- **Entry funnel** (#298): the post-auth landing is unified to `/home`, the GitHub OAuth CTAs show a pending state, the landing CTAs and feature grid use design tokens with a two-column tier, the auth heading and the Login/Register toggle are mode-aware and accessible, and "Sign out" uses the POST logout helper.
- **Shared UI primitives hardened for accessibility** (#289) and **undefined CSS tokens defined plus priority colors de-duplicated** (#290).
- **Backend ESLint wired into CI** (#299): the backend gains an ESLint 9 flat config (`typescript-eslint` recommended), its eslint devDeps are pinned to ESLint 9 to match the frontend, root `lint` runs both workspaces again, and the backend CI job gains a lint step (0 errors, 7 documented baseline warnings).

### Fixed

- **Silent fetch and delete errors are surfaced** on the home and teams pages instead of failing quietly (#291).

### Notes

- Frontend (`@agent-tasks/frontend`) and backend (`@agent-tasks/backend`) stay at 0.3.0; `@agent-tasks/mcp-server` 0.7.0 and `@agent-tasks/mcp-bridge` 0.6.3 are unchanged. No database schema changes.

## [0.19.0] - 2026-06-03

**Headline: a frontend usability pass across the dashboard, home, and task detail modal, with age-based done filtering and persisted view preferences, compact filter dropdowns, a one-click status advance, and collapsible modal sections, plus security hardening (write-tier role enforcement on task-mutating endpoints and a vitest CVE bump) and a working ESLint setup wired into CI.** No backend schema changes.

Operator note: no breaking changes. Per the convention since v0.9.0, workspace `package.json` versions are not bumped; `@agent-tasks/mcp-server` 0.7.0 and `@agent-tasks/mcp-bridge` 0.6.3 remain current.

### Added

- **Age-based done filter on the project dashboard, with persisted view preferences** (#278). The binary "Hide done" toggle becomes a three-state control (recent / all / none); the default hides done tasks whose `updatedAt` is older than 14 days. The board's Done column is capped with an expander, and done-visibility, board/list view mode, and sort persist to localStorage. The pure filter and storage logic lives in `frontend/src/lib/dashboardPrefs.ts` with unit tests.
- **One-click status advance in the task detail modal** (#281). An open, unclaimed task gets a "Start" action (claim and advance to in_progress via the `/start` endpoint); an in_progress task the user owns, with a branch and PR, gets "Submit for review". Both surface workflow-gate failures instead of bypassing them, unlike the edit-mode status PATCH.
- **Collapsible task-modal sections** (#285). A reusable `CollapsibleSection` collapses the rarely-needed Activity, Artifacts, and (in view mode) Dependencies sections by default, each with a count, so the modal stops sprawling.
- **Accessibility and loading-states pass** on the frontend (#275).

### Changed

- **Dashboard filter bar consolidated into compact dropdowns** (#279). Scope, done-visibility, and labels are now three `Select` dropdowns in one row instead of a wrapping chip cloud; the shared `Select` gained an optional `ariaLabel` for an accessible name.
- **Home widgets and task modal polish** (#280). A loading skeleton replaces the flash of empty widgets, the color-only status dot gained an accessible label (home and dashboard), "Recently Done" is scoped to the last 14 days, the modal shows created and updated timestamps, the agent result renders as markdown, Activity and Comment timestamps use the shared relative-time helpers, and the redundant "On track" chip is gone.
- **Long agent results are clamped in the modal** with a Show more / Show less toggle so a multi-thousand-character result no longer stretches the modal (#282).
- **Task delete moved out of the view header into edit mode** so an accidental click is harder; the confirm dialog is unchanged (#283).
- **ESLint 9 flat config wired into CI for the frontend** (#284). The deprecated, interactive `next lint` is replaced by `eslint .` extending `next/core-web-vitals` and `next/typescript`, and the frontend CI job gains a lint step (0 errors, 5 documented baseline warnings).

### Fixed

- **Older done tasks are reachable from the Recently Done home widget** (#286). After the 14-day cap, the widget now surfaces a link to the full done list when older completions exist, so they are no longer hidden behind the recent-only count.

### Security

- **Write-tier role enforced on task-mutating endpoints** (#276), closing a HIGH audit finding where a read-only `PROJECT_VIEWER` could reach mutating routes.
- **vitest bumped to >=4.1.0** to pick up the fix for CVE-2026-47429 (#277).

### Notes

- Release dogfood (2026-06-03): every PR was green at merge (typecheck with 0 errors, 153 frontend tests, `next build`, and `eslint .` from #284 on); the production build bundle contains the shipped UI strings (`doneVisibility`, "Submit for review", "Show more", the older-done link); `https://agent-tasks.opentriologue.ai/` returns HTTP 200; and the `/start` claim-and-advance path behind #281 was exercised live via the MCP `task_start` verb throughout the session.
- The frontend ESLint enablement surfaced that the backend `lint` script was never configured (no flat config, no eslint dep). The root `lint` script points at the frontend workspace for now; setting up backend ESLint and re-chaining it is tracked as a follow-up.

## [0.18.0] - 2026-05-27

**Headline: every `Signal` create can now POST out to a per-project webhook URL, with HMAC-SHA256 signing and a redacted secret round-trip; the project settings modal grows a "Notification webhook" section so operators can wire the receiver from the UI.** Before this release the Signal layer was poll-only via `task_pickup`. This unblocks live wake-up for active Claude Code sessions via a thin bridge (e.g. `triologue-agent-gateway`'s new `/agent-tasks/webhook` route in v0.2.0): the bridge turns each Signal POST into a Triologue room message, the SSE listener on a reviewer's session sees it without polling. Dogfooded end-to-end on 2026-05-27: a real `task_available` Signal landed in the configured Triologue inbox room within seconds of the originating `task_create`.

Operator note: no breaking changes. Projects without `notificationWebhookUrl` behave exactly as before (poll-only). The optional `notificationWebhookSecret` is **never** returned by the API on read paths; `GET /projects/:id` exposes `hasNotificationWebhookSecret: boolean` instead, and the project-settings UI surfaces a `•••• (set)` placeholder with a Replace affordance. Backend, frontend, and CLI workspace `package.json` versions are not bumped (convention since v0.9.0).

### Added

- **`Project.notificationWebhookUrl` and `Project.notificationWebhookSecret`** with full PATCH support and empty-string-to-clear semantics (#272). When the URL is set, the existing `createSignal` service fans the payload out to the URL via `services/notification-webhook.ts`, alongside the existing DB insert that the polling channel reads. The POST carries `Content-Type: application/json`, `User-Agent: agent-tasks-webhook/1`, `X-AgentTasks-Event: signal.<type>`, `X-AgentTasks-Signal-Id: <signalId>`, and `X-AgentTasks-Signature: sha256=<hmac>` when a secret is configured. Best-effort delivery: one retry after 2s on non-2xx / network error / 5s timeout, then audit-and-drop. The originating Signal-create request is never blocked or failed by webhook trouble (`safeAudit`/`safeWarn` helpers guarantee non-throwing under any internal failure including JSON-stringify cycles). Payload schema and receiver contract documented in `docs/notification-webhooks.md`.
- **`signal.webhook_delivered` and `signal.webhook_failed` audit codes** with `{ signalId, signalType, url, statusCode?, attempts, durationMs, errMessage? }` payloads (#272). Both reference the originating Signal id so operators can correlate against the existing `Signal` row. `webhook_failed` only fires after the retry is also exhausted; intermediate non-2xx responses are not audited individually.
- **Project settings UI section "Notification webhook"** in the dashboard project-settings modal (#273). Type=url input for the URL with a docs link, type=password input for the secret with a Show/Hide reveal toggle and `autocomplete="off"`. When the server reports `hasNotificationWebhookSecret: true` the input is hidden behind a `•••• (set)` label plus a Replace affordance; clicking Replace transitions to an editable field with a Cancel button that restores the redacted state without saving. New `frontend/src/components/NotificationWebhookSection.tsx` exports `buildWebhookPatch()`, a pure helper that translates the section's draft state into the PATCH body keys (URL omitted when unchanged, secret omitted when the operator did not engage, both keys settable to `null` for clear). 18 component tests + 9 route tests cover the redacted/Replace/Cancel transitions, the `autoComplete="off"` and `type="url"` contracts, and the PATCH-secret-no-echo and PATCH-clear-via-empty-string flows.

### Changed

- **`Project` read responses are now redacted before serialization** (#272). Every route that returns a project, `GET /projects` (list), `GET /projects/by-slug/:slug`, `GET /projects/:id`, `POST /projects` (create), `PATCH /projects/:id`, `POST /projects/:id/sync`, runs the response through a new `redactProject()` helper that strips `notificationWebhookSecret` and adds `hasNotificationWebhookSecret: boolean`. The `Project` OpenAPI schema in `backend/src/routes/docs.ts` matches: `notificationWebhookUrl` (nullable URI) plus `hasNotificationWebhookSecret` (boolean), with the raw secret intentionally absent from the schema. PATCH audits URL transitions in plaintext (operators need to see destinations) and secret transitions as `set`/`unset` booleans only, no raw secret ever lands in `AuditLog.payload`.

### Notes

- mcp-server and mcp-bridge are unchanged in this release. `@agent-tasks/mcp-server` 0.7.0 and `@agent-tasks/mcp-bridge` 0.6.3 (cut in #270 and #271 alongside v0.17.0) remain current.
- Follow-up tasks already on the backlog: `c60941cc` (in-process HTTP integration test against a real receiver, the one mock-level gap the reviewer flagged) and a user-global webhook fallback (operator preference vs per-project override, surfaced when configuring the bridge for a personal-scale 74-project account).

## [0.17.0] - 2026-05-27

**Headline: `task_start` accepts an optional `branchName` so projects with the `branchPresent` workflow gate start in one call.** The MCP `task_start` verb and the backing `POST /tasks/:id/start` route now take an optional `branchName` field; when supplied, the value is folded into the same atomic Prisma write that creates the claim, so a `branchPresent` precondition passes without a separate `tasks_update` round-trip. The `task.claimed` audit event records `foldedBranchName` on the same call, distinguishing "branch was already set" from "branch was supplied this call". Alongside it, a CVE-driven `qs` bump and a small docs / metadata polish on `mcp-bridge`.

Operator note: no breaking changes. Existing pre-fix callers that POST `/tasks/:id/start` with no body or that pass only `{ taskId }` to the MCP `task_start` verb keep behaving as before. The MCP surface change in `@agent-tasks/mcp-server` (new optional `branchName` field) will ride to npm via a separate `release(mcp-server): cut v0.7.0` PR, matching the per-cycle convention since v0.15.0 (#254 cut `mcp-server` 0.6.1, #255 cut `mcp-bridge` 0.6.2). Backend, frontend, and CLI workspace `package.json` versions are not bumped (convention since v0.9.0).

### Added

- **`task_start { taskId, branchName? }` single-call workflow** for projects with a `branchPresent` gate on the `open → in_progress` edge (#268). When `branchName` is supplied AND the task has no branchName yet, the start handler folds the value into the gate input and into the atomic claim write, so the friction documented in `feedback_agent_tasks_branch_precondition` (two MCP calls per task pickup against agent-grounding et al.) collapses to one. Idempotent: when the task already has a branchName, the supplied value is silently ignored (never overwrites). Schema rejects empty strings with 400 before the active-claim check runs. The `@agent-tasks/mcp-server` `task_start` tool definition (`mcp-server/src/tools.ts`) exposes the new optional field with a description pointing at the gate. Covered by 7 new cases in `tasks-v2-routes.test.ts`: single-call happy path, idempotent ignore-when-already-set, empty-string reject, backward-compat empty body, review-claim accepts-but-ignores, same-value re-call no-op, sibling `prPresent` gate still blocks.
- **`task.claimed` audit event records `foldedBranchName`** when the start call also persisted a branch on the same write (#268). For `branchPresent`-gated projects, this lets post-incident review distinguish "branch was already there" from "branch was supplied this call" without needing to cross-reference the prior `task_metadata.updated` events.

### Changed

- **`mcp-bridge/README.md` states the license as MIT explicitly** (#267), replacing the prior "Same as the parent repo." line with `MIT, see [../LICENSE](../LICENSE).` (the `license: "MIT"` field on `mcp-bridge/package.json` was already in place). Root `README.md` gains a "Repo layout" section that names all five workspace packages with their deliberate version skew (`0.3.x` for backend / frontend / cli, `0.6.x` for mcp-server / mcp-bridge), and links three CLI sub-docs (`commands.md`, `configuration.md`, `workflows.md`) from the Next-steps table.

### Security

- **`qs` bumped to 6.15.2** (#266) to pick up the fix for CVE-2026-8723. Transitive-only dependency; lockfile update.

## [0.16.0] - 2026-05-22

**Headline: explicit `debugFlavor` opt-in/out, end to end.** Task creation
now accepts an explicit `debugFlavor` boolean across every create surface,
the REST endpoint, both MCP servers, and the CLI, so a caller who already
knows a task's flavor sets it deterministically instead of coaxing the
keyword heuristic; the OpenAPI spec is synced to match. Alongside it, two
more suppression fixes to the auto-classifier: `release` / `test` labels
and conventional-commit-typed titles (`feat:`, `chore:`, ...) no longer
misfire as debug-flavored.

Operator note: no breaking changes. The `debugFlavor` field is additive
and optional; omitting it preserves the existing auto-detect behaviour
exactly. Workspace `package.json` versions are not bumped (convention
since v0.9.0).

### Added

- **Explicit `debugFlavor` opt-in/out flag on task create.** The task-create
  surface (`task_create` / `tasks_create` MCP verbs and `POST
  /projects/:id/tasks`, including batch import) now accepts an optional
  `debugFlavor` boolean. When set, the value is persisted straight into
  `metadata.debugFlavor` at create time: `true` forces the grounding hint at
  `task_pickup`, `false` suppresses it. `deriveDebugFlavor` already treats a
  pre-set `metadata.debugFlavor` as authoritative, so an explicit flag
  deterministically overrides the title/description/label heuristic
  (`detectDebugFlavor`) without any pickup-path change. When the flag is
  omitted the behaviour is unchanged: no metadata is written and the
  heuristic runs lazily at pickup as before. A caller who knows a task's
  flavor up front no longer has to coax the heuristic via the title or
  labels. Covered by `task-create-debug-flavor.test.ts`. (#262)

- **CLI `tasks create` reaches parity with the REST and MCP create
  surfaces** (#263). The `@agent-tasks/cli` `tasks create` command gains
  `--debug-flavor` / `--no-debug-flavor` (a commander tri-state boolean
  mapping to the optional `debugFlavor` field) and a repeatable
  `--depends-on <task-id>`. `CreateTaskInput` carries both new fields.
  Covered by a new `createTask` request-body suite in
  `cli/tests/api.test.ts`.

### Fixed

- **`detectDebugFlavor` no longer auto-classifies `release`- or `test`-labelled tasks as debug-flavored** (#260). Extends the suppression-label set introduced in #252: a task carrying a `release` or `test` label is deliberate typed work, so the keyword heuristic is suppressed for it just as it is for `docs` / `chore` / `refactor` / `style` / ... labelled tasks. Explicit debug labels (`bug` / `incident` / ...) still classify correctly.
- **`detectDebugFlavor` no longer misfires on conventional-commit-typed task titles** (#261). A task whose title carries a non-debug conventional-commit type prefix (`feat:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`, `build:`, `ci:`, `chore:`, `release:`, with an optional `(scope)` and `!` breaking marker) is now suppressed from debug-flavor classification, the same way a suppression label is. The prefix is the task author's deliberate type signal: a `chore(deps): regression in the lockfile` task merely mentions a debug keyword while describing typed maintenance work, and should not auto-start a grounding session. `fix:` is deliberately not in the set, so bug-fix tasks stay scannable; explicit debug labels (`bug` / `incident` / ...) still win over the title-shape suppressor. This complements the label-based suppression from #260: a task with neither a suppression label nor a conventional-commit prefix is still keyword-scanned as before. Covered by a new `title-shape suppression` test block in `debug-flavor.test.ts`.

- **The OpenAPI `CreateTaskRequest` schema documents every accepted create-time field** (#264). The hand-written spec in `backend/src/routes/docs.ts` had drifted from the Zod `createTaskSchema`: `debugFlavor`, `dependsOn`, `labels`, and `externalRef` were all accepted by `POST /projects/:id/tasks` but undocumented. All four are now in the spec, with constraints (`minLength` / `maxLength` / `maxItems` / `format`) mirroring the validator. Docs-only, no behaviour change.

## [0.15.0] - 2026-05-21

**Headline: the first registered workflow template since the
state-vocabulary lock, plus a master-stability sweep.**
`branch-pr-merge-gated` ships as a predefined workflow that enforces
branch-first discipline and a merged PR before any task reaches `done`.
Alongside it, a batch of build and correctness fixes: fresh checkouts now
self-heal the Prisma client, the frontend Docker image build is unblocked,
the review-gate is split so it is safe to call at claim time, no-claim
403s name their recovery path, and debug-flavor classification stops
misfiring on docs / refactor / feature tasks.

Operator note: no breaking changes. `@agent-tasks/mcp-server` 0.6.1 and
`@agent-tasks/mcp-bridge` 0.6.2 were already published from their own
release PRs (#254, #255) and are included here for the rollup. Backend,
frontend, and CLI workspace `package.json` versions are not bumped
(convention since v0.9.0). Fresh local installs now run `prisma generate`
automatically via a backend `postinstall` hook; the Docker build stages
that `npm ci` before the Prisma schema is in context pass
`--ignore-scripts`.

### Added

- **`branch-pr-merge-gated` workflow template**, the first template
  registered in `WORKFLOW_TEMPLATES` since the state vocabulary was
  locked to `{open, in_progress, review, done}`. It is the locked
  four-state workflow with stricter gates than the built-in default:
  `open → in_progress` requires `branchPresent`, `in_progress → review`
  and the skip-review `in_progress → done` require `branchPresent` +
  `prPresent`, and every edge into `done` requires `prMerged` so reaching
  `done` always means the PR landed. Applied via
  `POST /api/projects/:id/workflow/apply-template/branch-pr-merge-gated`;
  documented in `docs/workflow-preconditions.md`. (#258)

### Changed

- The review-gate is split into a pure identity check and an
  approval-time wrapper. `checkDistinctReviewerGate` now only rejects a
  self-review (`self_review`) and is safe to call at claim time; the new
  `checkReviewApprovalGate` composes it with the two approval-time
  invariants (`no_review_lock`, `review_lock_held_by_claimant`) and is
  used at every `review → done` / `review → merged` transition. Discovered
  while building the round-trip suite (#256), which carried a
  pre-population workaround for exactly this gate. (#257)
- No-claim 403s on `task_finish`, `task_submit_pr`, and `task_abandon` now
  name `task_start` as the recovery path, so an agent chaining tasks
  back-to-back sees how to re-claim. The `task_finish` MCP tool
  description documents the claim precondition; shipped to agents via
  `@agent-tasks/mcp-server` 0.6.1 / `@agent-tasks/mcp-bridge` 0.6.2.
  (#253, #254, #255)
- `detectDebugFlavor` no longer auto-classifies a task as debug when it
  carries a `docs`, `how-to`, `polish`, `chore`, `refactor`, `style`,
  `enhancement`, or `feature` label, even if the title or description
  contains debug keywords. Explicit debug labels and mixed label sets
  still classify correctly. (#252)

### Fixed

- Fresh checkouts no longer break on ~30 Prisma-related TypeScript
  errors: `backend/package.json` gains a `postinstall: "prisma generate"`
  so the client is regenerated on every `npm install` / `npm ci`. The
  `backend/Dockerfile` and `Dockerfile.migrate` build stages that
  `npm ci` before the schema is copied pass `--ignore-scripts`.
  `cli/tests/config.test.ts` now mocks `node:fs` so
  it no longer fails on dev machines that have a real
  `~/.agent-tasks.json`. (#250)
- `frontend/Dockerfile` passes `--ignore-scripts` to its base-stage
  `npm ci`, so the backend `postinstall` added in #250 no longer aborts
  the frontend image build with `prisma/schema.prisma: file not found`.
  (#251)

### Internal

- New `backend/tests/workflow/` round-trip suite: exercises the canonical
  agent flow (`task_create → task_start → task_submit_pr → task_finish`)
  against the real route handlers with mocked Prisma + GitHub, asserting
  per-verb and aggregate output-byte budgets for the soloMode and
  distinct-reviewer paths. Catches `tasks_list`-style response-size
  regressions that per-route unit tests miss. (#256)

## [0.14.0] - 2026-05-16

**Headline: Confidence scoring is now explainable, capped, and auditable
(ADR-0011 Milestone 1).** The confidence gate stops being a single opaque
number plus a flat `missing[]` list. It now produces a structured
`TaskQualityReport` with seven named subscores, deterministic ceilings
that prevent long-but-vacuous tasks from passing, a typed `findings[]`
catalogue with actionable suggestions, an ordered `nextActions[]` for
agents and humans to consume, and two new audit events covering every
block and every force-override. The split between *measurement* and
*decision* is codified in ADR-0011, with `TaskQualityAnalyzer` and
`ClaimPolicyEvaluator` as named components so the four follow-up
milestones (task-type-aware readiness, policy engine, human improvement
loop, empirical calibration) build against a contract instead of a
function.

Operator note: there is one breaking change. Agents calling
`?force=true` against `/tasks/:id/start` or the legacy `/claim` must now
also pass `?forceReason=...` (>=10 chars), else they receive 400
`bad_request`. Previously the gate was silently bypassed, leaving no
audit trail for overrides. No internal callers used the old behaviour
(verified across tests and routes). The rest of the surface is
backwards-compatible: existing 422 consumers reading only
`details.score`, `details.missing`, and `details.threshold` keep
working; `subscores`, `findings`, `nextActions`, and `inferredTaskType`
ride alongside. Score may decrease for cap-eligible tasks (e.g. strong
description without acceptance criteria caps at 80 instead of reaching
~90); the default 60 threshold is unaffected for typical tasks.

### Added

- **ADR-0011** at `docs/adr/0011-split-confidence-scoring-into-quality-analysis-and-claim-policy.md`,
  defining `TaskQualityAnalyzer`, `TaskQualityReport`, `QualityFinding`,
  `ClaimReadinessScore`, `ClaimPolicyEvaluator`, `ClaimDecision`, the
  responsibilities matrix, the new audit event names, and the additive
  BC plan. Non-Goals copied verbatim from the design overlay. (#242)
- Seven named subscores on every confidence report: `completeness`,
  `concreteness`, `testability`, `scopeClarity`, `contextQuality`,
  `structure`, `ambiguityRisk` (inverse-of-risk: 100 = no vague terms).
  Each in 0..100; heuristic, no LLM. (#243)
- `QualityFinding[]` catalogue on every confidence report: `code`,
  `severity` (`info | warning | blocking`), `dimension`, `message`,
  optional `suggestion`. Codes include `missing_acceptance_criteria`,
  `missing_verification`, `missing_goal`, `missing_context`,
  `missing_constraints`, `vague_language`, `no_concrete_anchors`,
  `ambiguous_scope`. (#243, #245)
- Six deterministic score caps from the overlay's "Important: Add Score
  Caps" section: empty title (30), empty description (40), missing goal
  (70), missing acceptance criteria (80), no verification path (85),
  ambiguity >= 3 with no concrete anchors (75). Strictest applicable
  cap wins; every triggered cap surfaces as a finding. Suggestion
  enrichment when a cap collides with an existing blocking rule. A
  grep-friendly `console.info` line fires exactly when a cap lowers
  the score. (#244)
- Structured 422 body on blocked claims: response now carries
  `details.findings[]` plus `details.nextActions[]` alongside the
  existing `details.{score, missing, threshold}`. `nextActions` is the
  deduped, blocking-first, 5-cap prioritised list of suggestion
  strings, designed for direct agent + UI consumption. (#245)
- New `evaluateConfidenceGate` helper in
  `backend/src/services/confidence-gate.ts`. Extracted from inline gate
  code at `/tasks/:id/start` and the legacy `/claim` so the two routes
  stay in lockstep and the future `ClaimPolicyEvaluator` extraction
  (Milestone 3) is a clean refactor. (#245)
- Two new audit actions (`backend/src/services/audit.ts`):
  `task.claim_blocked_low_readiness` (every 422, payload carries
  `route`, `score`, `threshold`, `findings`, `actorType`) and
  `task.claim_override_used` (only when `?force=true` rescues a
  would-be-blocked claim, payload includes `forceReason`). Surface on
  the existing `GET /tasks/:taskId/audit` and
  `GET /projects/:projectId/audit` endpoints automatically. (#245)
- Test coverage on the confidence library: 30 unit tests in
  `backend/tests/unit/confidence.test.ts` covering description-quality
  bins, rule activation per `templateFields`, all six score caps, all
  seven subscore dimensions, finding emission per code, and the
  cap-collision suggestion enrichment. 6 tests for the
  `deriveNextActions` helper in `confidence-gate.test.ts`. Coverage on
  `backend/src/lib/confidence.ts`: 99.29% lines, 90.71% branches. (#246)
- 9 route tests in `backend/tests/unit/tasks-v2-routes.test.ts` covering
  the 4-cell gate matrix for both `/start` and the legacy `/claim`
  (block, force-no-reason 400, override audit, force-noop) plus the
  `/instructions` confidence shape (all 7 subscores, severity values,
  `inferredTaskType` present/absent). (#247)
- `taskType` enum on `templatePresetSchema` and `templateDataSchema`:
  `bugfix | feature | refactoring | security | migration | docs`.
  `calculateConfidence()` now returns `inferredTaskType` from
  `templateData.taskType`. Bridge to Milestone 2 (per-type required
  signals and per-type thresholds); scoring is unchanged in this
  release. (#248)

### Changed

- **Breaking:** `?force=true` on `POST /tasks/:id/start` and legacy
  `POST /claim` now requires `?forceReason` (>=10 chars), else returns
  400 `bad_request`. Previously the gate was silently bypassed without
  audit. Migration: pass `?forceReason=<reason>` alongside
  `?force=true`. No internal callers used the old combo. (#245)
- `lowConfidence` middleware (`backend/src/middleware/error.ts`)
  widened to accept extra fields so the 422 details body carries
  `subscores`, `findings`, and `nextActions` additively. Existing
  callers reading the three legacy fields keep working. (#243, #245)
- `tasks_instructions` tool description in `@agent-tasks/mcp-server`
  0.6.0 names the new `confidence.inferredTaskType` field so MCP
  catalogues regenerate against the bridge surface. (#248)

### Security

- Bump frontend `next` to `^15.5.18` to clear 13 Dependabot CVEs. (#238)
- Scope the `postcss` override to `next` so the residual CVE under that
  scope is cleared without widening the override surface for unrelated
  consumers. (#239)

### Internal

- CI workflows skip runs on doc-only PRs via `paths-ignore: ["**.md",
  ".github/ISSUE_TEMPLATE/**"]`. Saves runner minutes; the
  release-cut path treats doc-only PRs as no-CI by design. (#237)
- `.gitignore` adds `*.tsbuildinfo` and the incremental build cache is
  untracked; no more cache churn in diffs. (#236)
- `frontend/src/components/task/TaskArtifactsSection.tsx` migrates the
  ad-hoc wordBreak style to the `.text-break-anywhere` utility class
  for consistency with the rest of the dashboard. (#235)
- `mcp-bridge` `--version` / `-v` / `version` CLI short-circuit prints
  the package version and exits 0 within the harness doctor probe
  budget. Shipped to npm in `@agent-tasks/mcp-bridge` 0.6.0 between
  cuts (#241); included here for the cross-release rollup. (#240)

## [0.13.0] - 2026-05-11

**Headline: project-scoped task browsing across CLI and MCP, plus governance
polish.** Closes a long-standing gap: the deprecated `tasks_list` MCP verb
returned only the global claimable slice and `task_pickup` returned one item,
so "what is open in project X?" was a web-UI-only question. This release
adds a backend route extension, a new CLI subcommand surface, and a
dedicated MCP verb that all answer the question consistently. The release
also rolls up a Dependabot fix and a workflow-page layout tweak.

Operator note: a new CLI entry point `at tasks list --project <slug>` is now
available alongside the existing claimable behavior (browse-only flags
require `--project` and exit 1 without it, instead of being silently
ignored). A new MCP verb `project_tasks` is published in `@agent-tasks/mcp-server`
0.5.0 and `@agent-tasks/mcp-bridge` 0.5.0; clients pinning the older 0.4.0
package must update to see it. The backend `GET /api/projects/:id/tasks`
endpoint stays unbounded by default so the frontend dashboard contract is
preserved; new browse-style callers should pass `?limit=` for safety.

### Added
- `GET /api/projects/:projectId/tasks` accepts new query params: `priority`
  (CSV of `LOW|MEDIUM|HIGH|CRITICAL`), `unclaimed` (boolean), `limit`
  (positive integer, clamped to 500). The existing `status`, `labels`, and
  `externalRef` filters continue to work; `status` now validates against
  the enum and returns 400 on unknown values instead of forwarding an
  arbitrary string to Prisma. (#232)
- CLI `tasks list` gains `--project`, `--status`, `--priority`, `--labels`,
  `--unclaimed`, `--limit` flags. Without `--project` the command keeps its
  global-claimable behavior; passing a browse-only flag without `--project`
  exits 1 with a clear message. Slug or UUID accepted for `--project`. (#232)
- MCP verb `project_tasks` registered in `@agent-tasks/mcp-server` 0.5.0,
  with slug-or-UUID resolution and the same filter surface as the CLI.
  Wraps the new backend endpoint as a thin client. (#233)

### Changed
- Workflow page layout aligned with the project members and settings
  pages for visual consistency. (#231)
- MCP `tasks_list` deprecation note now points at `project_tasks` for
  browse-style use cases. (#233)
- `@agent-tasks/mcp-server` bumped 0.4.0 → 0.5.0 (new verb).
- `@agent-tasks/mcp-bridge` bumped 0.4.0 → 0.5.0 (re-pinned against 0.5.0
  of mcp-server).

### Security
- Override transitive `ip-address` dependency to `^10.1.1`, clearing the
  MEDIUM Dependabot alert #21. (#230)

## [0.12.0] - 2026-05-06

**Headline: docs cleanup + audit-driven rewrites.** The repo's docs
landscape grew over months of feature work and the April-2026
bootstrap drafts had drifted out of sync with the live Prisma schema
and v2 verb surface. This release deletes the bootstrap-output
folders (`.planforge/`, `scaffold/`) and seven orphaned historical
docs, refreshes the agent-facing API surface for v2 verbs and the
REST-vs-webhook merge divergence, redraws the two sequence diagrams
against the actual default-workflow states, and rewrites the
domain / state / events / contract / use-cases layer end-to-end
against the source of truth.

Operator note: no source-code changes, no schema changes, no API
contract changes. Workspace `package.json` versions are not bumped
(convention since v0.9.0). Container deploys are not affected;
upstream the new docs into any read-side mirror you maintain.

### Documentation
- Rewrote the domain / state / events / contract layer flagged as
  Rewrite by the PR #225 audit (delivered by PR #228). Six artefacts
  now match the Prisma schema and the live API surface:
  `docs/domain-model.md` enumerates every entity (User, Team,
  TeamMember, AgentToken, SsoConnection, Project, ProjectMember,
  ProjectInvite, Workflow, Board, Task, TaskDependency,
  TaskAttachment, TaskArtifact, Comment, Signal, AuditLog,
  ToolInvocation) with the governance fields called out and the
  deprecated boolean flags marked.
  `docs/state-machines.md` documents the four valid statuses
  (`open` / `in_progress` / `review` / `done`), the canonical
  default-workflow transitions with their precondition
  decorations (`branchPresent`, `prPresent`, `ciGreen`,
  `prMerged`), the three governance-tier gates
  (`AUTONOMOUS` / `AWAITS_CONFIRMATION` /
  `REQUIRES_DISTINCT_REVIEWER`), and the REST-vs-webhook merge
  divergence.
  `docs/events.md` is a full audit-action catalog grouped by
  family (identity / token, project, workflow, task, github),
  plus the seven signal types
  (`review_needed`, `task_available`, `task_assigned`,
  `changes_requested`, `task_approved`, `task_force_transitioned`,
  `self_merge_notice`).
  `docs/use-cases.md` replaces the German handoff-era stub with
  six end-to-end flows: agent picks up + finishes; per-project
  invite + soloMode auto-flip; distinct-reviewer dual-control
  merge; dependency graph blocks a claim; admin force-transition;
  agent token + GitHub delegation.
  `docs/api-contract.md` is now a thin pointer to OpenAPI /
  Swagger UI / `mcp-server/src/tools.ts` / `v2-api.md` instead of
  a parallel German API draft.
  `diagrams/domain-overview.mmd` redrawn as a `classDiagram` over
  the entities above, with relations and governance-field
  annotations on `Project`.
- Redrew the two sequence diagrams flagged as Rewrite by the PR #225
  audit (delivered by PR #227). `diagrams/sequence-agent-create-claim.mmd`
  now shows the v2
  agent surface (`signals_poll`, `task_pickup`, `task_start` returning
  instructions) and the confidence gate. `diagrams/sequence-review-
  deploy.mmd` drops the imagined `in_review` / `ready_to_deploy` states
  and the deploy-policy component, then explicitly contrasts the REST
  merge path (hardcoded `done`) with the webhook path (status picked
  by `governanceMode`, non-soloMode default workflows land in
  `review`). `docs/sequence-flows.md` rewritten as an English thin
  index with the cross-cutting invariants preserved (audit on every
  state change, scope is the source of truth, webhooks are
  idempotent).
- Refreshed agent-facing API surface in three docs (light-touch follow-up
  to PR #225 audit, delivered by PR #226). `docs/getting-started.md` MCP
  tool list now lists
  the v2 verbs (`task_pickup` / `task_start` / `task_finish` / `task_merge`
  / `task_submit_pr` / `task_abandon` / `task_note` / `task_artifact_*`
  / `signals_*` / `pull_requests_*`) as the recommended surface, with
  the v1 verbs (`tasks_claim` / `tasks_release` / `tasks_transition` /
  ...) marked deprecated-but-present. `docs/agent-workflow.md` typical
  flow rewritten as a four-column table mapping each step to MCP v2 /
  CLI / REST. `docs/v2-api.md` documents the REST-vs-webhook merge
  divergence and the three governance-mode tiers
  (`REQUIRES_DISTINCT_REVIEWER`, `AWAITS_CONFIRMATION`, `AUTONOMOUS`).
  Cross-repo PR guard called out in both `getting-started.md` and
  `agent-workflow.md`. Docs-only, no source changes.

### Removed
- `.planforge/` (320K, agent-planforge bootstrap planning pack output) and
  `scaffold/` (108K, Python scaffolding from agent-scaffoldkit) folders
  deleted. Both were dormant since 2026-04-14 and superseded by the live
  Node/TypeScript monorepo + `docs/architecture.md` + ADRs. The only
  active reference (`Makefile` `hooks:` target reading
  `.planforge/.husky-pre-commit`) was preserved by moving the script to
  `tools/husky-pre-commit`. Defensive `.dockerignore` entries dropped.
- Seven historical-only docs deleted after a triage pass:
  `docs/restructure-merge-plan.md`, `docs/backlog.md`, `docs/glossary.md`,
  `docs/implementation-guidelines.md`, `docs/open-questions.md`,
  `docs/roadmap.md`, `docs/vision.md`. Each was a planforge-era artefact
  with no in-repo cross-references and no current value (the live roadmap
  lives in `README.md`, vision in `README.md` + `docs/governance.md`).

### Documentation
- Audit pass classified the remaining 22 docs and 5 diagrams into Keep,
  Light touch, and Rewrite buckets. No rewrites land in this PR; the
  three follow-up rewrite bundles (agent-facing API surface refresh,
  domain/state/events refresh, sequence diagrams refresh) are filed as
  separate tasks.

## [0.11.0] - 2026-05-03

**Headline: per-project sharing ships end-to-end (schema + access checks +
invite/accept flow + members management page + dashboard share-marker),
the home and `/tasks` list pages stop fanning out one HTTP request per
project (a single team-scoped aggregation endpoint replaces the loop),
and the agent-tasks-cli is folded into the monorepo as a `cli/`
workspace alongside backend / frontend / mcp-server / mcp-bridge.**

Operator note: PR #217 added two new tables (`project_members`,
`project_invites`). The schema change rolls out via the deploy init
container's existing `prisma db push` step, so the upgrade requires
no extra operator action beyond the usual deploy. The new aggregation
endpoint `GET /api/teams/:teamId/tasks` is additive, mounted next to
the existing `/api/projects/:projectId/tasks` (which stays in place
for the board's per-project view). No client breakage; existing REST
and MCP callers continue to work.

### Added

#### Per-project sharing (PR #217)

A team admin can invite a user to a single project without adding them
to the project's team. The data layer:

- `ProjectMember(projectId, userId, role, invitedById)` with a unique
  `(projectId, userId)`. Role enum:
  `PROJECT_ADMIN | PROJECT_CONTRIBUTOR | PROJECT_VIEWER`.
- `ProjectInvite(projectId, tokenHash, role, expiresAt, consumed*)`
  with sha256-hashed tokens (same pattern as `agent_tokens.tokenHash`,
  plain token returned exactly once at creation).

Access expansion:

- `hasProjectAccess` now passes when the actor has either a
  `TeamMember` or a `ProjectMember` grant. Agent actors honor their
  token-owner's `ProjectMember` grant when the token's team doesn't
  own the project (matches the github-delegation attribution
  principle: an agent acts as its creator's user).
- New `getProjectMembership(actor, projectId)` returns the access
  source (`team` | `project`) plus the concrete role, for UI marking
  and per-project listings.
- `hasProjectRole` / `isProjectAdmin` recognise `PROJECT_ADMIN` as
  satisfying the `ADMIN` gate. `PROJECT_CONTRIBUTOR` satisfies
  `HUMAN_MEMBER` and `REVIEWER`. `PROJECT_VIEWER` is read-only and
  passes only the `"any"` membership check (does not unlock writes).

Frontend:

- New `/projects/[id]/members` page for team admins to view, invite,
  and remove per-project members.
- New `/invite/[token]` page for accepting a project invite (shared
  surface with the team-invite flow: validate token, sign in if
  needed, accept, redirect into the project).
- `GET /api/projects` listing for humans now expands to
  `OR(team-owned, projectMembers.some)` so shared projects appear in
  pickers; each row is annotated with `accessSource: "team" | "project"`.
- Dashboard project picker shows a share-marker on shared rows, plus
  a "Members" link on the project detail surface and a banner on
  shared projects so the user knows which team actually owns it
  (PR #220).

GitHub delegation refactor (PR #210, folded into #217): `AgentActor`
gains `userId` (sourced from `AgentToken.createdById`); `findDelegationUser`
prefers the token owner over the legacy team-pool fallback. The
authorship check in `task_submit_pr` now expects the PR author to
match the token owner when eligible, tightening defense-in-depth in
multi-user teams.

#### `agent-tasks-cli` imported as `cli/` workspace (PR #208)

The standalone `agent-tasks-cli` repo is folded into the monorepo as a
top-level `cli/` workspace alongside `backend`, `frontend`,
`mcp-server`, `mcp-bridge`. Single source of truth, single CI run,
single `npm install`. PR #209 follows up to retarget the README's
Development block at the new monorepo paths.

### Changed

#### Single roundtrip for the home and `/tasks` list pages (PR #221)

`GET /api/teams/:teamId/tasks` aggregates tasks across every
team-accessible project (team-owned + per-project shares) in one
request, plus a small projects map so the client can decorate each
task with its project name without a second roundtrip. The frontend
home and `/tasks` pages drop their `Promise.all(projects.map(getTasks))`
loop and call the new endpoint once. Polling cadences unchanged
(home: 15s; `/tasks`: 30s).

Why: PR #217 added a third DB query to `hasProjectAccess` for the new
per-project membership lookup. Combined with the per-project HTTP
fan-out, a 40-project user incurred roughly 160 DB queries per home
render every 15s. The new endpoint executes one projects query plus
one task query (with `projectId IN (...)` over the resolved set), so
the access check happens once at the team-resolution boundary instead
of N times.

The endpoint accepts `?status=`, `?priority=`, `?labels=`, and
`?limit=` (default 500, hard max 1000); responses are ordered by
`updatedAt desc`. The `/tasks` page requests the hard max and
surfaces a banner when the cap is hit so users with very large teams
know to narrow with filters. The existing
`/api/projects/:projectId/tasks` endpoint stays in place for the
single-project board view.

### Fixed

#### `agent-relay` deploy: drop `--no-cache`, add per-service `mem_limit` (PR #219)

The post-merge relay redeploy hook was burning a fresh build context
on every push, which combined with the box's available RAM produced
intermittent OOM kills on the build container itself. `--no-cache`
removed; per-service `mem_limit` lines added so the OS can no longer
starve other services if a single one balloons. No app behavior
change; deploy reliability win.

## [0.10.0] - 2026-04-28

**Headline: The task state vocabulary locks down to `open / in_progress
/ review / done` (transitions, gates, role requirements, labels, and
agent instructions stay editable per project), the MCP `tasks_list`
verb learns filters and a summary projection so the natural call shape
no longer overflows the harness's tool-result token cap, the grounding
integration ships in three phases (debug-flavor detection on pickup
and start, auto-start grounding session on debug-flavored tasks, and
an opt-in finish-gate), and the backend gains structured per-request
Pino logging plus `dependsOn` support on task creation.**

Operator note: no migrations required. The state-vocabulary lock is at
the validation layer — existing custom Workflow rows whose state set
matches the four allowed names continue to round-trip; foreign names
will surface as a 400 listing the offending state on the next edit. No
known production rows depend on foreign state names.

### Changed

#### Workflow state vocabulary is fixed: open / in_progress / review / done

`workflowDefinitionSchema` now rejects any workflow whose state set is
not exactly `{open, in_progress, review, done}`, whose `initialState` is
not `open`, or whose `terminal` flag for any state disagrees with the
lock-in (only `done` may be terminal). The schema runs server-side on
every workflow create / update path, so direct API callers cannot
bypass the editor.

The editor itself stays fully functional for everything that matters in
practice: transitions, gates, role requirements, and per-state `label` /
`agentInstructions` are all still editable. The states table hides the
add / rename / remove / set-initial / toggle-terminal affordances and
shows a notice that the vocabulary is fixed.

The `coding-agent` workflow template (7 stages: backlog → spec → plan →
implement → test → review → done) was retired — its state names would
fail the new validation. The template registry stays in place; future
templates that vary only transitions / gates / labels (within the fixed
state set) are still welcome.

**Why:** the engine has ~25 hardcoded literal-status checks (merge gate,
distinct-reviewer guard, dependency gating, webhook PR-binding, the
new `tasks_list` claimable filter from PR #204) that all assume every
workflow uses those four state names. Custom state names silently broke
those checks — see the audit summary in
[fe0bbbe0](https://github.com/LanNguyenSi/agent-tasks/issues) for the
full failure-mode catalogue.

#### `tasks_list` / `GET /tasks/claimable` — filters, summary projection, default limit 25

- Added query-param filters to `/tasks/claimable` and the matching MCP
  `tasks_list` tool: `status`, `priority`, `labels`, `claimedByAgentId`,
  `projectId`. `status` and `priority` accept either a scalar or a CSV
  (`status=open,in_progress`). `labels` is a CSV with AND-match
  (Prisma `hasEvery`). `claimedByAgentId="me"` resolves to the calling
  agent's tokenId; passing it for a human actor returns 400.
- When `status` or `claimedByAgentId` is set, the implicit
  "status=open + unclaimed" default is dropped so already-claimed and
  in-progress / review / done tasks are reachable through the same
  endpoint.
- Default `limit` lowered from 50 to 25 (max stays 200).
- Default response is now a summary projection that omits
  `description`, `comments`, `attachments`, and `artifacts` — the heavy
  fields that were pushing the MCP tool result past the harness's
  token cap. `verbose=true` opts back into the full payload (the
  legacy shape).
- Existing callers of `/tasks/claimable` that pass no query params still
  get claimable-only tasks scoped to their team, same semantics, just
  fewer bytes per task and at most 25 by default. The OpenAPI doc and
  the stdio `@agent-tasks/mcp-server` client carry the same surface.

### Added

#### Structured logging with stable per-request fields

- Replaces ad-hoc `console.log/warn/error` calls with a Pino logger
  (`backend/src/lib/logger.ts`). JSON output in production, pretty
  output in dev/test. Log level is configurable via `LOG_LEVEL` (default
  `info` in prod, `debug` elsewhere).
- An AsyncLocalStorage-backed context, seeded by the new
  `requestContextMiddleware`, surfaces these fields on **every** log line
  emitted within a request scope: `requestId`, `method`, `path`,
  `actorId`, `actorType` (stamped by `authMiddleware` BEFORE the handler
  runs, so handler-emitted logs inherit them), `verb` (MCP tool name),
  `rpcMethod` (other JSON-RPC methods like `initialize` / `tools/list` —
  separate field so tool-traffic dashboards aren't polluted by protocol
  traffic), `taskId` and `projectId` (auto-populated from `:id` /
  `:projectId` path params on `/api/tasks/...` and `/api/projects/...`).
- The middleware mints a UUID `requestId` per request, honors a 100-char
  inbound `X-Request-Id` header for trace propagation, and echoes the
  value back as a response header. Inbound IDs are validated against
  `[A-Za-z0-9._-]{1,100}` to block log/header injection — values outside
  the charset are dropped and a fresh UUID is minted.
- One access log per request (`durationMs`, `status`). Status-class
  routing: 5xx → `error`, **401/403 → `warn` (kept visible for
  brute-force detection and security audits)**, other 4xx → `debug`,
  2xx/3xx → `info`. `/api/health` 2xx are suppressed entirely (k8s
  liveness probes would otherwise drown info logs); 5xx on `/api/health`
  still logs.
- Acceptance criteria from the originating task are met:
  `docker logs agent-tasks-backend | jq 'select(.taskId == "<id>")'`
  surfaces every line in a request flow, and any cross-route correlation
  (MCP entry → REST self-dispatch → DB write → audit log) is grep-able
  by `requestId`.
- Out of v1: the stdio `mcp-server` package keeps its lone
  `console.error` fatal handler unchanged; OpenTelemetry / Jaeger /
  log-aggregation infra was deliberately not pulled in. Boot-time
  config validation still uses `console.error` because the logger
  itself isn't initialised yet at that point.

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

#### Grounding integration — debug-flavor detection, auto-start session, finish-gate

- `task_pickup` and `task_start` now classify each task as
  debug-flavored or not based on title / description / labels and
  surface a `groundingHint` on the response (recommendedAction +
  mcpToolHint + sessionId once a session exists). Phase 1.
- Debug-flavored tasks auto-start a grounding session via the
  `@lannguyensi/grounding-wrapper` client on first pickup / start;
  the resolved session id, current phase, mandatory sequence, and
  active guardrails are persisted on `task.metadata.groundingSessionState`
  so subsequent calls reconstruct the same hint without re-issuing.
  Failure-soft: if the wrapper rejects or the client is null, the
  hint collapses back to the Phase 1 advisory shape and pickup still
  proceeds. Phase 2.
- Project-level opt-in `requireGroundingForDebug` activates a
  finish-gate on the work-claim path of `task_finish` for
  debug-flavored tasks: the gate consults `getLedgerSummary` and
  blocks the finish (precondition_failed) if the ledger has zero
  entries. Off by default; non-opted projects emit a
  `task.grounding_gate.bypassed` audit event so operators can
  retroactively see what would have been blocked. Phase 3.

#### `effectiveGates` discovery surface (gate registry v1)

- New MCP verb `projects_get_effective_gates` and REST endpoint
  `GET /api/projects/:projectId/effective-gates` return a map keyed
  by `GateCode` (`distinct_reviewer`, `self_merge`,
  `task_status_for_merge`, `pr_repo_matches_project`, …). Each entry
  carries `active` (whether the gate would evaluate on this project),
  `because` (governance mode, project binding, etc.), and `appliesTo`
  (the verb names the gate can reject). Lets agents answer "will this
  verb be blocked?" before tripping a 4xx.
- The `projects_get` response includes the same `effectiveGates`
  field for backward compatibility; the dedicated verb is the new
  preferred path because the payload is leaner.

#### Opt-in `idempotencyKey` on `pull_requests_*` verbs

- `pull_requests_create`, `pull_requests_merge`, and
  `pull_requests_comment` now accept an optional `idempotencyKey`
  body field (max 128 chars). Same `(taskId, verb, idempotencyKey)`
  tuple replays the cached response within a 24-hour window instead
  of re-issuing the GitHub API call. The key is opt-in — callers
  that don't supply it see the legacy "fire every time" behaviour
  unchanged. The cache stores the verb result + status so subsequent
  hits short-circuit without touching GitHub.

#### `.text-break-anywhere` utility class (frontend)

- Inline `wordBreak: "break-word"` styles on long-string columns in
  `TaskArtifactsSection` and the connect-agent modal H2 collapsed
  into a single `.text-break-anywhere` utility class in the global
  CSS. No behavioural change; the class is now reusable across the
  frontend.

#### README 60s hook + `docs/` restructure

- Top-level `README.md` rewritten with a 60-second "what is this /
  why does it exist" hook above the fold, with deeper material moved
  into a new `docs/` subdirectory. Existing
  `docs/agent-workflow.md`, `docs/api-contract.md`, and friends move
  with the rewrite; cross-links updated.

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
