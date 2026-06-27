# Changelog

All notable changes to `@agent-tasks/mcp-server` are documented here.

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
