# Changelog

All notable changes to `@agent-tasks/mcp-server` are documented here.

## Unreleased

**CONTRACT CHANGE**: `project_tasks` now returns summary rows by default
(id, title, status, priority, labels, externalRef, createdAt, claims,
blockedBy, prUrl), not the full backend task per row. Descriptions and
templateData are no longer echoed back on every row without asking: pass
`include: ["description"]` or `include: ["templateData"]` to add one
field back to every row, or `include: ["task"]` for the full, pre-contract
rows (the recovery path after context loss), same `include` semantics
`tasks_get` already uses. `nextCursor` and every existing filter (status,
priority, labels, unclaimed, limit, sort, cursor) are unchanged. This
keeps a browse-scoped listing of many long-description tasks well inside
the tool-result token cap without lowering `limit` (task 3653962f).

## 0.14.0

**Backlog status v1 on the MCP surface** (PR #477): `project_tasks` and
`tasks_list` status filters accept `backlog`; new teaching errors
`backlog_routing_enforced` (400, agent tried to create with an explicit
non-backlog status) and `backlog_not_promoted` (403, task_start/claim on an
unpromoted task) with recipes; `task_create` receipts on a backlog-routed
task carry the "awaits operator promotion" next hint; `workflow_primer`
gains a "Backlog routing (v1)" section; a regression test pins that the
client tolerates unknown status strings in responses (cross-version window).

Also since 0.13.0:

- `task_create` accepts a unified `project` param (slug or UUID) (#469).
- Creator-abandon flow surfaced (task_creator_abandon recipes and
  conflict teaching error) (#473).
- Confidence: per-type thresholds surfaced on badge-relevant read paths (#465).
- Error wire ceiling enforced with surrogate-safe clamps and a
  recipe-allowedNext coherence guard (#451).
- `task_start` receipt consumes `effectiveGates` + `previousStatus` (#446).
- `already_claimed` passes activeClaim detail through, three-case recipe
  (review-retention aware) (#443, #444).
- Clamped zod issue details in the generic degrade path (#442).
- Test-file typecheck in CI (#464).

## 0.13.0

**Response Contract v1** (rc-v1 series, PRs #434–#440; normative reference:
`docs/response-contract-v1.md` in the repo). **Breaking release**: default
response shapes change for every existing caller, and 14 deprecated v1 verbs
leave the default registration. `include: ["task"]` is the per-call valve
back to the old full-object behavior on every converted verb, and
`AGENT_TASKS_MCP_LEGACY=1` re-registers the 14 pruned verbs (37 tools total).

**Measured** (mcp-token-audit, response-shape-bucketed, chars/4 ≈ tokens,
successful calls only; corpus as of 2026-08-12). Before, from the 14-day
dogfood corpus: `task_start` 1,966 tokens/call (n=148), `task_finish` 1,783
(n=145), `task_create` 1,380 (n=58), `task_submit_pr` 1,481 (n=76). After,
from the cold-start eval sessions against the packed 0.13.0 tarball: 75
(n=3), 26 (n=1), 46 (n=2), 40 (n=1): small live samples that corroborate
the test-pinned response budgets, which are the actual guarantee. Weighted
by the before-side call profile, the four verbs drop from 742,251 to 20,578
tokens per 14 days (−97.2%; the release-gate target was −50%). `tasks_get`'s
summary default is pinned at 431 emitted chars (≈ 108 tokens) against a
~1.3k-token/call full-object average before.

**Cold-start eval** (release gate): a fresh, isolated agent session with no
prior knowledge of this tracker completed the full lifecycle (`task_start` →
PR → `task_submit_pr` → `task_finish`) against the packed 0.13.0 tarball,
guided only by the handshake primer and tool descriptions; a negative-control
session that was instructed to call `task_finish` out of sequence was
corrected by the `not_claimed` teaching error alone.

### Changed

- **The eight write verbs return small receipts by default** (rc-v1-C002,
  #435). `task_create`, `task_finish`, `task_submit_pr`, `task_note`,
  `task_respec`, `tasks_comment`, `task_merge`, and `task_abandon` now answer
  with a receipt (`{ ok, task: { id, status }, … }`) instead of echoing the
  full backend object: no echo of the description/templateData you just sent,
  report-by-exception `deviations` (e.g. `CONFIDENCE_BELOW_THRESHOLD`) with
  detail clamped by construction (at most 5 entries per array plus an explicit
  total count, 19-char per-entry budget), and a `confidence` scalar on
  create/respec only. Tier budgets are test-asserted on the emitted wire
  string (receipt ≤ 240, advise tier ≤ 1600 serialized chars).
- **`task_start` returns a receipt plus a small per-task slice** (rc-v1-C003,
  #436): `inferredTaskType`, `expectedFinishState`, `gateExpectations` (with
  a `gateExpectationsSource: "assumed-default-workflow"` provenance marker
  when the list comes from the static fallback rather than the project's own
  workflow definition): ~75 tokens (300 emitted chars) on the plain
  work-claim fixture, against ~2k tokens per call before (the most expensive
  verb of the surface). The persisted `groundingSessionState` blob never reaches the
  default response; debug-flavored tasks get a compact session recipe
  instead. `include` gains `description`/`instructions`/`comments`/`task`;
  `task_pickup` keeps the full spec (minus `comments` by default) as the
  single full-spec moment (a composition test proves pickup + start together
  still carry all work data).
- **`tasks_get` returns a summary projection by default** (rc-v1-C006, #439):
  id, title, status, priority, clamped labels/blockedBy, claims, prUrl,
  pinned at 431 emitted chars on the happy-path fixture; `include` adds
  `description`, `comments`, `artifacts`, or the full object.
- **Every error is a teaching error** (rc-v1-C005, #438): errors serialize as
  `{ code, message, recipe, allowedNext }`, bounded ≤ 1200 chars by
  construction, with a nine-entry catalog of the documented agent traps
  (`not_claimed`, `already_claimed`, structured `precondition_failed` listing
  each failing gate with its own corrective, `low_confidence` with
  score/threshold/missing detail, `cross_repo_pr_rejected`,
  `pr_author_mismatch`, admin-only `force`, respec conflict, and the
  plain-string result guard); rc-v1-C006 adds two project-addressing entries
  (`project_addressing_conflict`, `unknown_project_slug`, see Added), for
  eleven shipped in 0.13.0. Unknown errors degrade to the same shape and
  pass the backend's own `body.error` code through verbatim (`http_<status>`
  only when the body carries no code), preserving recursively clamped
  details.
- **`signals_poll` caps its response honestly** (rc-v1-C006, #439): default
  limit 10 with an explicit `truncated` marker and a resumable cursor, plus
  `atBackendFetchCeiling` when the fetched backlog hits the backend's 200-row
  window, so nothing is silently dropped.

### Removed

- **14 deprecated v1 verbs pruned from the default registration**
  (rc-v1-C007, #440): `projects_list`, `projects_get`, `tasks_list`,
  `tasks_create`, `tasks_update`, `tasks_instructions`, `tasks_claim`,
  `tasks_release`, `tasks_transition`, `review_approve`,
  `review_request_changes`, `review_claim`, `review_release`, and
  `pull_requests_comment`. The default surface is 23 tools; setting
  `AGENT_TASKS_MCP_LEGACY=1` in the server process's environment registers
  all 37 tools: the 36 pre-0.13.0 verbs plus the new `workflow_primer`
  (handlers untouched). The README carries
  a per-verb replacement table. `tasks_get`, `tasks_comment`, `signals_poll`,
  and `signals_ack` stay registered by default and lose their stale
  deprecated prefixes.

### Added

- **Onboarding channels** (rc-v1-C004, #437): the MCP initialize handshake
  now carries `instructions` (a ≤ 2000-char primer: lifecycle, claim model,
  receipt promise), and a new parameterless, local-only `workflow_primer`
  verb serves the full lifecycle reference on demand. Static onboarding
  knowledge is paid for once per session instead of being replayed inside
  every `task_start` response (the deprecated `tasks_instructions` design).
- **`projectSlug` addressing** (rc-v1-C006, #439): `task_create` accepts
  `projectSlug` as an alternative to `projectId`, resolved through a
  TTL-cached slug map (~15 min) with invalidate-and-retry on the backend's
  real 403/404 signals; `project_tasks`'s existing slug support routes
  through the same cached resolver. Contradictory or unknown project
  addressing is a teaching error.
- **Sort + cursor pagination on `tasks_list` / `project_tasks`** (#413): both
  list tools default to `createdAt:desc` at the tool layer so small-`limit`
  browsing sees the newest tasks, with `nextCursor`/`cursor` for stable
  paging. (`tasks_list` itself is legacy-only from this release; see
  Removed.)

### Docs

- **`docs/response-contract-v1.md`** (rc-v1-C001, #434) is the normative
  response-shape reference (receipt tiers, report-by-exception rules,
  include semantics, error shape, onboarding channels, token budgets,
  versioning), linked from the README nav table and CONTRIBUTING.

## 0.12.0

### Added

- **`task_respec` verb** (backend PR #409). Wraps `POST /api/tasks/:id/respec`: edit an **open, unclaimed** task's `description` and/or `templateData` in place, so an under-specified or low-confidence task can be fixed without abandoning and recreating it. At least one of `description`/`templateData` is required — checked client-side before the request for fast feedback, and enforced authoritatively by the backend (400), which also rejects individually-empty values (blank/whitespace-only `description`, empty `templateData` object). `templateData` is a **wholesale replace** of the stored value, not a merge. By default only the task's creator may respec it; a project admin can relax this via `project.allowNonCreatorRespec` (403 otherwise; missing `tasks:update` scope for agent callers is also 403). Any claimed (work or review) or non-`open` task is rejected with 409 `Task must be open and unclaimed to respec`; unknown task ids 404. Response is `{ task, confidence }`, passed through unchanged — `confidence` uses the same shape as `task_create`'s create-time confidence (`{score, threshold, enforcementMode, blocking, missing, findings, nextActions}`).

### Changed

- README Tools table regenerated for the new 36-tool count.

## 0.11.0

### Added

- **`deliverableRepo` on `task_create`** (agent-tasks task cab4d048). Optional `owner/repo` override for tasks whose legitimate deliverable is a PR in a different GitHub repo than the project's linked `githubRepo` (benchmark/measurement/docs tasks) — the backend's cross-repo PR guard and merge-automation refusal key off this repo instead. Post-create changes are project-admin-only (human, via `PATCH /api/tasks/:id`); agents cannot retarget it later. See `docs/workflow-preconditions.md` in the backend repo for the full mechanism.

## 0.10.0

### Added

- **`reclassify` flag on `task_pickup` and `task_start`** (#359). Both MCP tool definitions now expose an optional `reclassify?: boolean` parameter. On `task_pickup`, passing `true` appends `?reclassify=true` to the backend query string, instructing it to overwrite the task's `debugFlavor` with the result of the classifier (and delete stale grounding-session metadata on a true-to-false flip). On `task_start`, the flag is forwarded as a JSON boolean in the request body; `branchName` and `reclassify` can coexist in the same call. Both parameters are discoverable in the MCP tool catalogue: callers no longer need to know the wire-level detail.

### Changed

- **`task_finish` result field documented as free-text** (#377). The tool description now states the `result` field is free-text prose/markdown, not a structured or XML payload, addressing a pattern of agents appending fake XML to the field.
- **README Tools table and server-version constant reconciled with the code** (#361). `mcp-server/README.md` is regenerated to list the actual 35 registered tools in four groups (v2 verbs, artifacts, attachments, and v1 aliases). PR #361 reconciled the `SERVER_VERSION` constant in `src/server.ts` with `package.json`; this release bumps both to `0.10.0`, so the MCP handshake reports the real version. "Settings -> Agent Tokens" references are corrected to "Settings -> API Tokens" throughout.

### Security

- **`tsx` devDependency bumped to `^4.22.4`** (#342). Clears esbuild advisories GHSA-gv7w-rqvm-qjhr and GHSA-g7r4-m6w7-qqqr; `tsx >=4.22.0` resolves `esbuild ~0.28.x` (patched range).

## 0.9.0

### Added

- **scorer-v2 executability fields on `task_create`** (#313): `scope`, `outOfScope`, `dependencies`, `risk`, `agentPrompt`, and `prefers` are now accepted in the structured `templateData` the confidence scorer reads.
- **Create-time confidence on the `task_create` response** (#317): the verb surfaces the scorer-v2 confidence verdict (score versus the project threshold, missing fields, next steps) so an agent sees immediately whether a created task clears the gate.
- **Task-template requirements exposed at discovery time** (#324): the project discovery surface (`projects_get_effective_gates` and the project read) now reports the `taskCreation` block (`enforcementMode`, `confidenceThreshold`, `templateModeEnabled`, `requiredFields[]`), so an agent can learn a project's required fields before composing a task.

## 0.8.0

### Added

- `task_attachment_list` and `task_attachment_get` verbs: agents can read human-uploaded task attachments (images + text). `task_attachment_list` returns attachment metadata for a task; `task_attachment_get` returns a UTF-8 text excerpt for text files, or base64 for images when `includeBase64` is set, with `textByteLimit` (max 800000) and `base64ByteLimit` (max 512000) caps and a `status` of `ready`/`missing`/`unsupported`/`error`. Read-only by design: agents cannot upload or delete attachments (they produce artifacts for their own output). Requires the `tasks:read` scope. Backs agent-tasks task d0e6fce9, root release v0.22.0.

## 0.7.0

### Added

- `task_start` accepts an optional `branchName` argument. When supplied, the backend folds the value into the atomic claim write so projects that enforce the `branchPresent` workflow gate on the `open → in_progress` edge (agent-grounding, agent-planforge, agent-preflight, agent-tasks itself) start in a single MCP call instead of the historic two-call `tasks_update { branchName } → task_start` dance. Idempotent: when the task already has a branchName, the supplied value is silently ignored (never overwrites). Empty strings are rejected by the MCP tool zod schema (in `mcp-server/src/tools.ts`) before the wire. Polymorphic contract documented in the tool description: on a review-claim start the field is accepted but ignored. Pre-v0.17.0 backends ignore the extra body field because the older `/tasks/:id/start` route reads no request body at all, so the gate still fires for branchless tasks against older deployments, the new field only changes behaviour against an `agent-tasks v0.17.0+` backend. Agent-tasks PR #268, root release v0.17.0.

## 0.6.1

### Changed

- `task_finish` tool description now states the claim precondition explicitly: the caller must hold an active work or review claim on the specific task, and the claim of any prior task that was just finished does not carry over. The note also disambiguates `task_pickup` (discovery-only, does not claim) from `task_start` (the actual claim verb). Description-only release, runtime behaviour unchanged. Backend route returns a matching recovery hint in the 403 body (agent-tasks PR #253).

## 0.6.0

### Changed

- `tasks_instructions` tool description now names the ADR-0011 confidence
  surface that the backend response carries: `confidence.inferredTaskType`
  (`bugfix | feature | refactoring | security | migration | docs`), set when
  the task was created from a typed preset. The new field is the bridge to
  Milestone 2 per-type required-signals and per-type thresholds. The tool's
  inputs and runtime behaviour are unchanged; this is a description-only
  release so MCP catalogues regenerate against the new shape hint.

## 0.5.0

### Added

- `project_tasks` verb. Browse tasks scoped to a single project; answers the
  "what is open in project X?" question that `task_pickup` (single item) and
  the deprecated `tasks_list` (global claimable slice) cannot. Accepts slug
  or UUID for `project` and resolves slugs server-side. Filter surface:
  `status` (single or array), `priority`, `labels`, `unclaimed`, `limit`.
  Wraps `GET /api/projects/:id/tasks`.

### Changed

- `tasks_list` deprecation note now points at `project_tasks` for
  browse-style use cases.

## 0.3.1

### Added — v2 verb-oriented workflow tools (ADR 0008)

- `task_pickup` — "what should I do next?" Returns next signal, review task, work task, or idle. Hard-limit: one active claim per agent.
- `task_start` — atomic claim + transition + context. For `open` tasks: author-claim and move to `in_progress`. For `review` tasks: take the review claim without status change. Returns `expectedFinishState` (`review` or `done`).
- `task_note` — comment on a task. Currently still requires explicit `taskId`; implicit claim lookup deferred to a later release.
- `task_finish` — polymorphic finish. Work claim: stores `prUrl`/`prNumber`, resolves target state from the workflow (prefers `review`, falls back to `done`), keeps the work claim on the way to review so `request_changes` auto-resumes the author. Review claim: `outcome: approve | request_changes` with signal emission.
- `task_create` — unchanged behavior, re-declared under the v2 namespace for discoverability.
- `task_abandon` — explicit bail-out. Rejected while the task is already in `review` to prevent orphan state.

### Deprecated

All v1 CRUD tools (`tasks_list`, `tasks_get`, `tasks_instructions`, `tasks_claim`, `tasks_release`, `tasks_transition`, `tasks_update`, `signals_poll`, `signals_ack`, `projects_list`, `projects_get`) now carry a `[DEPRECATED, use v2 tools]` prefix in their descriptions. Sunset: 4 weeks after 0.3.1 release.

Backend endpoints backing the new tools: `POST /api/tasks/pickup`, `POST /api/tasks/:id/start`, `POST /api/tasks/:id/finish`, `POST /api/tasks/:id/abandon`. Shipped in backend 0.3.x (PR #150).

## 0.3.0

### Added
- `projects_get` — fetch a single project by slug or id (auto-routes).
- `review_approve` — approve a task in review.
- `review_request_changes` — request changes on a task in review.
- `review_claim` — acquire the single-reviewer lock.
- `review_release` — release the review lock without approving or requesting changes.

Closes CLI-parity gap: MCP-only agents can now drive the review loop end-to-end, including the distinct-reviewer gate introduced in v0.2.0. Same five tools are mirrored in the HTTP MCP peer at `POST /api/mcp`.

## 0.2.0

### Added
- `pull_requests_create` / `pull_requests_merge` / `pull_requests_comment` — GitHub PR operations via delegation.

## 0.1.0

- Initial release. Twelve tools covering projects, tasks, signals, transitions, updates, and comments.
