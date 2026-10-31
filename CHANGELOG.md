# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- The root `overrides` floor for `ip-address` is now `^10.7.4` (was `^10.7.2`), so a fresh resolve cannot pick 10.7.2 or 10.7.3 (GHSA-rxp7-6hxx-x8q5). The lockfile already resolves 10.7.4 and is unchanged.
- **Team names now refuse invisible and smuggling characters (400) on create and rename.** `teamNameSchema` (`backend/src/lib/team-name.ts`, shared by `POST /api/teams` and `PATCH /api/teams/:id`) refuses exactly these anywhere in the trimmed name: the tag characters (U+E0020-U+E007F, which can carry an invisible ASCII payload) except the three exact subdivision flag sequences of England, Scotland and Wales (U+1F3F4, five tag letters, the cancel tag U+E007F; a partial sequence, an unknown region or a tag run without U+1F3F4 is still refused), the implicit direction marks (U+200E, U+200F, U+061C), the interlinear annotation marks (U+FFF9-U+FFFB), the invisible operators (U+2061-U+2064) and any unassigned code point (`\p{Cn}`, for example U+0378 and U+2065), all under one new message (`TEAM_NAME_INVISIBLE_MESSAGE`); and it refuses Zalgo text under `TEAM_NAME_MARKS_MESSAGE`: more than 8 combining marks in one grapheme cluster, counted after removing invisible format characters (so zero-width joiners, zero-width spaces, word joiners, soft hyphens or a BOM cannot split a stack); the count runs on a check copy (`Intl.Segmenter`, every `\p{Cf}` code point and U+00AD removed) and the stored name is unchanged, while exactly 8 marks and Burmese syllables with several marks per cluster stay valid. U+FFFC (object replacement character) joins the blank class, so a name of only U+FFFC is "Team name must not be empty". The rules are checked in order (control characters, unpaired surrogates, separators and bidi controls, private use and noncharacters, the invisible set, the mark cap, emptiness, the 100 code point limit) and a refusal is a 400 whose `message` names the first failed rule: a name that is only a tag character is refused as invisible, not as empty, and a tag character together with a bidi override reports the direction rule. Stays valid inside a visible name: the rest of `\p{Cf}` (the zero-width joiner U+200D in an emoji sequence, the variation selector U+FE0F), the three subdivision flags, U+FFFC, Thai and Arabic text, Devanagari, Burmese text with stacked marks, decomposed Vietnamese and a keycap. `isBlankTeamName` (`frontend/src/lib/teamName.ts`) mirrors the blank class, so the create form and the "Team name" card keep their submit controls disabled for a U+FFFC-only name; the client does not judge the refused characters and shows the server's message. Names already stored are not changed.
- **`@hono/node-server` 2.1.5** (GHSA-rmxm-3fg6-px4f): the lockfile resolves 2.1.5 (was 2.0.12), which fixes `serveStatic` decoding the request path a second time and so letting a request bypass middleware on static paths (affected: `>= 1.19.10, < 2.1.3`). Lockfile only, a direct dependency whose range is unchanged.
- **The dev compose stack publishes its ports on 127.0.0.1 only.** `docker-compose.yml` published `5432:5432`, `6379:6379`, `3001:3001` and `3000:3000`, so Postgres (fixed credentials `agent_tasks`/`agent_tasks`) and Redis (no auth) were reachable from any host that could route to the machine's address while the dev stack ran. All four host-side bindings are now `127.0.0.1:`-prefixed (container sides unchanged), so every local consumer (`localhost` DATABASE_URL/REDIS_URL, the browser on `localhost:3000`) keeps working and none of the ports is published on the machine's other network interfaces; the stack is a local dev stack, and self-hosting on a server uses `docker-compose.prod.yml`. Guarded by `backend/tests/unit/docker-compose-loopback-ports.test.ts`; README and `docs/development.md` now say the quickstart is a local dev stack with loopback-bound ports.

### Added

- **A team admin can rename the team after creating it.** `PATCH /api/teams/:id` takes `{ name }` (trimmed, then 1 to 100 characters, the same rule as team creation; a whitespace-only name is a 400) and returns `{ team }`. Only the display name is written: the slug never changes. Agent tokens get 403, an unknown team 404, a non-member 403 ("Not a member of this team"), a team member who is not `ADMIN` 403 ("Only team admins can rename the team"). A rename writes a `project.updated` audit event with `{ teamId, from, to }`, the same way team creation writes `project.created` with a team payload. `/settings/team` has a new "Team name" card: team admins get an input and a Save button (disabled for an empty, whitespace-only or unchanged name; a server error is shown and the old name stays), everyone else sees the name only. A saved rename reloads the shell's one team list (`refreshTeams`), so the header, the team switcher and the API Tokens section show the new name without a page reload; a rename that finishes after the user switched teams still reloads it. `renameTeam` is the client call in `frontend/src/lib/api.ts`. The OpenAPI document does not describe the team routes, so it is unchanged.

### Changed

- **`workflow_primer`, the `github:pr_merge` teaching error and `docs/agent-workflow.md` say what to do when a PR was merged outside agent-tasks and the task did not move.** When the token lacks `github:pr_merge`, do not retry `task_merge`: ask the operator to close the task in the UI and to check the "merge did not move the task" row of the troubleshooting table in `docs/webhook-setup.md` (App installation per repo, Recent Deliveries, the new warn line). The `forbidden` recipe for a missing `github:pr_merge` scope appends this to the admin re-mint text (within the 240-character recipe budget); the primer gained a "Merged outside agent-tasks" section (its sanity ceiling in the test is now 8300 characters).

- **The project board renders its columns from the project's workflows.** The board's columns are the `Backlog` queue (always first) followed by the states of the project's stored workflows: the default workflow's states in a stable order (its initial state first, its terminal states last, the rest in graph order along the transitions), then the states that only occur in the project's other (task-pinned) workflows, in the order the workflows are listed. A column's title is the state's workflow `label` when set, except the five built-in state names, which keep the board's own names (`Backlog`, `Open`, `In Progress`, `Review`, `Done`) whatever the workflow labels them, else the state name made readable. A task whose status matches no column (a state of a deleted workflow) lands in an extra last column, titled with the board's own name when the status is one of the five built-in state names the workflow left out and with the raw status otherwise, so every task but an abandoned one is visible and the column counts add up to the project's tasks; `abandoned` (a discarded backlog task) stays off the board with no column and is counted nowhere, as it always was. A project on the built-in workflow therefore sees exactly today's five columns: same ids, labels, badge tones, `+` only on Backlog and Open (the workflow initial state is locked to `open`), Done cap, jump bar, and identical list-view status chip row (it follows the same column list). Workflows are read with `GET /projects/:id/workflows` (any project member); a project whose workflows cannot be read (403, network) shows the built-in five. Every stored definition is read through the backend-sanitising port (`sanitizeStoredDefinition`), so a legacy `backlog` initial state or state reads as the backend reads it and never becomes a second backlog column; terminal detection uses the sanitised definition's `terminal` flags, not the name `done`. The board grid takes its column count from an inline `--db-cols` custom property instead of a hard-coded five, the 761-1279px band keeps one horizontally scrolled row (`minmax(240px, 1fr)`), a board with more than the five built-in columns takes that same readable minimum and horizontal scroll at 1280px and above instead of squeezing every card (five columns and fewer are untouched at those widths), mobile still stacks, and custom columns get a neutral dot (`--status-open`) and badge fallback. The pure column list lives in `frontend/src/lib/boardColumns.ts`. No API change.

- **The workflow API accepts custom state names.** `POST /api/projects/:projectId/workflows` and `PUT /api/workflows/:id` no longer require the exact states `open`, `in_progress`, `review` and `done`: any name matching `[a-z0-9_]+`, any terminal flags and a definition that leaves built-in names out are valid (`workflowDefinitionSchema`, `backend/src/routes/workflows.ts`; `FIXED_STATE_NAMES` and its companions are gone). Four rules remain, each a 400 with the validator's `error.issues`: `initialState` must be `open` and be one of the states (the engine still keys pickup, the claimable pool, start, promote, demote and reopen on that literal status, so lifting this pin needs an engine change first), the names `backlog` and `abandoned` are reserved (a state with either name, or an edge from or to either, is refused; both are written by dedicated routes and never by a workflow edge), the initial state is not terminal, and the definition has at least one terminal state. The structural checks (duplicate state names, an edge to or from a missing state, duplicate `from`/`to` pairs, the name format) are unchanged. Existing four-state projects and the registered templates behave as before. Not changed: the project workflow editor still shows the state list read-only (it cannot create custom states), no template uses a custom state yet. The confidence telemetry (`GET /api/projects/:id/telemetry/confidence`) follows the task's workflow: a review-approve into any terminal state of the task's effective workflow (pinned, else project default, else built-in) writes the `done` disposition, so a task that ends in a custom terminal state such as `shipped` counts as a success in `doneRateByScoreBand` and `lowScoreSuccesses` and not as a high-score failure; `finalStatus` keeps the state name. `abandoned` is reserved and never a workflow state, so the creator-abandon disposition stays the only failure outcome. When the definition cannot be read the literal `done` status is the fallback. `docs/workflow-preconditions.md` now describes the accepted state names instead of the fixed four. Comments and docs (`docs/state-machines.md`, `docs/deploy-verify-strategy.md`, `docs/domain-model.md`, the confidence telemetry comments in `schema.prisma`) no longer describe the vocabulary as fixed. A state name is at most 64 characters, the same bound as the `mcp-server` tools and the CLI (`STATE_NAME_MAX_LENGTH`). The terminal snapshot of the two `task_finish` approve branches writes the success disposition from the terminal check the route already made (`reachedTerminal`), so a failing second lookup cannot drop it; only the Grounding calibrate path still looks the definition up.

- **Lint toolchain moves to ESLint 10.** `eslint` is `^10.14.0` (backend, frontend, and the root `package.json`, so the peer ranges of `eslint-plugin-react`, `eslint-plugin-import` and `eslint-plugin-jsx-a11y`, which stop at ESLint 9, resolve to the one ESLint 10 instead of hoisting a deprecated 9.39.5), `@eslint/js` `^10.0.1`, `typescript-eslint` `^8.72.1` and `eslint-config-next` `^16.4.3` (the app stays on Next 15; `@eslint/eslintrc` and FlatCompat are gone). Both configs use `defineConfig` from `eslint/config`; the frontend imports `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript` directly. `npm install` prints an `ERESOLVE overriding peer dependency` warning for those three plugins, which is expected until they declare ESLint 10; the lockfile was written with npm 10.9.9. Coverage delta: the backend gains the ESLint 10 recommended rules `no-unassigned-vars`, `no-useless-assignment` and `preserve-caught-error`, and `no-shadow-restricted-names` now reports `globalThis`; the frontend gains the eslint-plugin-react-hooks 7 React Compiler rules (`set-state-in-effect`, `refs`, `purity`, `immutability`, `static-components`, `use-memo`, `preserve-manual-memoization` and others) and `@next/next/no-location-assign-relative-destination`; no rule was dropped and `no-constant-condition` keeps `checkLoops: "allExceptWhileTrue"`, as before. Two rules are set to `warn` explicitly in `frontend/eslint.config.mjs`, for the listed files only and with the reason in the config: `react-hooks/set-state-in-effect` (15 files, 19 effects that read localStorage or other browser-only state after mount, bundle a reset or a loading/error flag with an async load or a ref/storage side effect, or reset a form or section while the same effect starts the next load) and `react-hooks/purity` (the three `Date.now()` memos of the done-task hide window on the home page and the project board, which read the clock only when their inputs change; moving the timestamp into the fetch state would shift the window on recomputes that are not polls). Both rules stay errors in every other file. Code fixes: two dead initial values removed in the backend (`projectConf` in `routes/tasks.ts`, `data` in `services/grounding-completion.ts`); "latest callback" refs in `Toast`, `ConnectAgentModal` and the team settings page are synced in an effect instead of during render; `Select` uses the one `panelRef` from `usePopover` instead of writing to it from a callback ref; 12 effects that only reset or derive state now adjust it during render (the pending team switch in `AppHeader`, the signed-out user in `AppChrome`, the open state of `ImprovementPanel`, the search box, the team-bound dialogs and the loading/error decision on `/tasks`, the page number on `/projects` and the board list view, the loading decision on `/home` and `/projects`, the task detail on the board, the popover's position-ready flag), and the 2 portal mount guards (`Toast`, `usePopover`) use a new `useMounted` hook (`useSyncExternalStore`). Tests pin the search-box sync, the page resets and the popover flag. `engines` is unchanged: root `>=22.9` (and `>=22` in `mcp-server`, `mcp-bridge` and `cli`) admits Node versions that ESLint 10 does not support (it needs `^22.13`), while CI runs Node 22 (22.23.x) and 26. Lint is 0 errors before and after; frontend warnings go from 2 to 24.

### Fixed

- **The prod compose file now forwards `LOG_LEVEL` and `REDIS_KEY_PREFIX`.** Neither was in the `backend` `environment:` block of `docker-compose.prod.yml`, so a deployment `.env` could not tune the backend log level or the Redis cache key prefix; both are now forwarded as `${LOG_LEVEL:-info}` and `${REDIS_KEY_PREFIX:-agent-tasks:}`, with each default equal to the backend's own fallback (`backend/src/lib/logger.ts`, `backend/src/services/cache.ts`). The default lives in the compose expression, not in an empty `${VAR:-}` forward, because both consumers read the raw variable with `??`: a forwarded empty string would beat the fallback, and pino refuses an empty level. Compose `:-` substitutes on unset and empty alike, so unset keeps the code default, an empty `.env` value keeps the code default, and a set value wins. `backend/tests/unit/prod-compose-env-forwarding.test.ts` pins the form and the three inputs. `.env.example` gains a commented production block for `POSTGRES_PASSWORD`, `APP_DOMAIN`, `BACKEND_URL` and `SSO_ENCRYPTION_KEY` (placeholders only, with an `openssl rand -hex 32` generation hint; every line commented so a dev copy is unchanged) and a note that copying the template's `TRUSTED_PROXY_HOPS=0` to a prod host overrides the prod compose default of 1. Docs: `docs/development.md` said `.env.example` ships `TRUSTED_PROXY_HOPS` as `1` (it ships `0`; the prod compose default is `1`), and the merge row of `docs/agent-workflow.md` now marks `agent-tasks github pr merge` as non-equivalent to `POST /api/tasks/{id}/merge` (the CLI calls `POST /api/github/pull-requests/{prNumber}/merge`).
- **A merged PR that matches no project or no task is no longer silent.** The webhook acknowledges a delivery with `200` before it processes it, so a merged PR whose repo is bound to no project (`githubRepo` is matched exactly, case-sensitively), or whose project has no open task carrying the PR, used to leave a green delivery and a task that did not move, with nothing in the log. The legacy handler (`handlePullRequestEvent`) and the configured Grounding webhook service now log a warn with `repo`, `prNumber` and `reason` (`no_project` or `no_task`) and write a `task.reviewed` audit row with `event: pr_merged_unmatched` (no project on a `no_project` row), like the existing `pr_opened_unmatched` row. A task bound to the PR that is already terminal or in `backlog` is the echo of an earlier merge and writes neither. A handler failure in `routes/webhooks.ts` is also logged with the repo next to the delivery id and the event. Replay tests pin that a merged delivery in the depsight payload shape moves an `AUTONOMOUS` project's `review` task (work claim held) and `in_progress` task to `done` with both claims cleared and a `[webhook]` comment, on the legacy and the Grounding path (an exact binding completes, a weaker one stays a pending observation), and that a confirmation-required project keeps its review gate. This does not change which deliveries arrive: a GitHub App not installed on the repo still shows up only as a missing delivery (see the new troubleshooting row in `docs/webhook-setup.md`).
- **The auth error page shows the failure reason, and a declined GitHub authorization lands there.** `/auth/error` read `?error=` while the SSO callback (the only producer) sent `?reason=`, so every failure showed the generic text. The page now reads `reason` only (`?error=` is ignored; nothing produced it) and maps each code to its own message (`frontend/src/app/auth/error/messages.ts`): `callback_failed`, `session_mismatch`, `bad_request`, `state_mismatch`, `access_denied`, `server_error`, `temporarily_unavailable`, `login_required`, `consent_required`, `interaction_required`, `sso_unavailable`, `sso_not_configured`, `not_provisioned` and `sso_failed`. Any other code gets the generic "Something went wrong during authentication" message. The "Reference" line shows the code only when it is 1 to 40 letters, digits, `_` or `-` (what the backend forwards); anything else is not echoed. The old `no_email` and `email_taken` messages are gone: no code path sent them. The GitHub OAuth callback (`GET /api/auth/github/callback`) no longer answers JSON 400 and no longer redirects without a reason: a declined or refused authorization (`error=access_denied`, with no `code`) redirects to `/auth/error?reason=access_denied` (GitHub's `error` is forwarded after reducing it to `[A-Za-z0-9_-]`, 40 characters at most, `callback_failed` when nothing is left; it wins over `code` and `state`), a missing `code` to `reason=bad_request`, an invalid or missing state cookie to `reason=state_mismatch`, a connect attempt whose session does not match to `reason=session_mismatch`, and a failed token exchange or user lookup to `reason=callback_failed`. Every one of these paths clears the `oauth_state`, `oauth_intent` and `oauth_connect_user` cookies, as the success paths do. Which requests fail, the success redirects and the session cookie are unchanged. `docs/enterprise-sso.md` lists the extra reason codes and `docs/architecture.md` describes the page.
- **A merged PR hands a confirmation-required task to a review state its current state has an edge to.** The legacy GitHub webhook (`handlePullRequestEvent`) and the Grounding GitHub webhook (`pr_merged`) both pick the hand-off target with `pickMergeTargetStatus`, which used to answer the workflow's first review-like state. On a workflow with several work states or several review-like states that state can have no edge from the task's current state, and the task then sat in a state whose `task_finish` or review path did not match its position. It now picks the first review-like state, in state order, with a DIRECT edge from the task's current state; with no such edge it answers the unchanged workflow-wide first review-like state. The edge test is one shared predicate (`reachableReviewState`, `backend/src/services/default-workflow.ts`) that `finishTargetFrom` uses as well, so the webhook and a work-claim `task_finish` cannot pick different review states for the same task. Unchanged: a terminal or `backlog` task is left alone, `AUTONOMOUS` still targets the first terminal state, a task already in a review-like state stays there, there is no multi-hop search, and the built-in four-state workflow behaves as before (`open` and `in_progress` both land in `review`). The webhook still writes the target without enforcing the edge's `requires`.
- **A work-claim `task_finish` targets a review state the task's current state has an edge to.** It used to move the task to the workflow's first review-like state, so on a workflow with several work states (or several review-like states) a task in a later work state answered `no_transition` and needed `tasks_transition` steps before the finish. `finishTargetFrom` (`backend/src/services/default-workflow.ts`) now picks the first review-like state, in state order, with a direct edge from the task's current state; with no such edge the target is the unchanged workflow-wide fallback (first review-like state, else first terminal state), so an unreachable finish still answers 400 `no_transition`. The edge, and therefore its `requires` and `requiredRole`, is the one the finish enforces. The `task_start` work-claim preview (`expectedFinishState` and `effectiveGates.finish`, computed from the state the start moves the task to) and the grounded finish check (`resolveGroundingTarget`) use the same helper. No multi-hop search and no shortcut past review into a terminal state. The built-in four-state workflow is unchanged. Not changed: the review-claim `expectedFinishState` (still the definition-wide work-finish target) and the `autoMerge` finish. The GitHub webhook merge hand-off follows the same pick (next entry).
- **A task created from a GitHub issue starts in its workflow's initial state and is announced to agents.** Both `issues.opened` creators, the configured Grounding webhook handler and the legacy `handleIssuesEvent`, no longer write the literal `open`: each linked project's task starts in the initial state of the project's default workflow (`createInitialStatus` with no `workflowId`, the built-in `open` when the project has no default row or its stored definition cannot be read), resolved inside the delivery transaction on the Grounding path. They also send `task_available` to the team's claim-eligible agents, with `context.taskStatus` set to the created state (before this a task created from an issue sent no signal, on any workflow, so agents only found it by polling). On the Grounding path the signal rows are written inside the delivery transaction, so a rolled back delivery leaves none and a replayed delivery returns its stored result and adds none; the outbound notification webhooks go out after the commit. On the legacy path the signal is best effort per linked project: a failed signal is logged and does not stop the other projects of the delivery. A Grounding-selected project whose initial state is a terminal state is still refused, and a workflow that does not start at `open` is no longer refused for the old literal `open` (it used to be created outside the workflow or refused). With the built-in four-state workflow the status is what it was; the one visible difference is the new `task_available` signal and its `task.created` audit row (`event: task_available_signal`) in a team with a claim-eligible agent. Documented in `docs/events.md` and `docs/webhook-setup.md`.

- **A task created without a status starts in its workflow's initial state.** `POST /projects/:id/tasks` and the batch import no longer default the status to the literal `open`: a human create (or import row) without a status now lands in the initial state of the effective definition, the task-pinned workflow row when the create carries a `workflowId`, else the project's default workflow row, else the built-in definition, whose initial state is `open`. The `task_available` signal follows the same rule and fires when the created status equals that initial state, so a workflow that does not start at `open` no longer creates tasks no agent is told about. With the built-in four-state workflow the status and the signal are what they were, and an explicit status is still the caller's choice. The Grounding creation router (the same two routes for a project the creation policy selects) follows the same rule and resolves the initial state inside its own transaction: before this it defaulted to the literal `open`, which a workflow that starts elsewhere refused with `409 bad_state` or left outside the workflow, with no signal. Agent creates on that path stay routed to `backlog` and signal nothing.

- **Clients no longer hard-code the built-in state names, so a custom workflow state is reachable end to end.** The `mcp-server` tools `tasks_transition`, `tasks_list` and `project_tasks` take a bounded state-name string and show the backend's 400 for an unknown one unchanged; the CLI's `tasks list --status` does the same, and its task-id prefix search also pages over the custom states of the projects' workflows when the built-in statuses find nothing; the `/home` Priority widget decides actionable work the way the backend's priority count does (a status counts unless it is `backlog`, `abandoned` or a terminal state of the task's own workflow: the pinned workflow, else the project default, else the built-in one) and asks the team route for the workflows' open states once it has read the projects' workflows (`GET /api/projects/:id/workflows`, once per team; a list it cannot read counts as the built-in workflow). With the built-in workflow the requests and rows are what they were. This closes the clients part of the entry below ("Not changed: ... keep their fixed status lists"); the `/tasks` page's Priority preset (`scope=priority`) keeps its fixed three-status list. The workflow API accepted only the four built-in state names when this was written; the Changed entry above lifts that lock.

- **The `/projects` row menu is a real menu now.** Its "..." trigger carries `aria-haspopup="menu"` and `aria-expanded`, the open panel holds a `role="menu"` named after the project and `role="menuitem"` entries, and the "Managed by GitHub sync" note is an `aria-disabled="true"` menuitem the keyboard cycles through but never activates, the same pattern as the `/tasks` row menu and the header menus. Opening by keyboard, arrow-key cycling and Escape closing with focus back on the trigger are unchanged.
- **A truncated band summary says what it hides.** When `PageHeader` truncates a string summary (the `/projects` band with the team name), the ellipsised element carries the full text as `title`, so hover or touch-hold shows the whole line; a non-string summary and a never-truncated one get no title.
- **The board column jump bar keeps keyboard focus and leaves no hash behind.** Activating a chip scrolls the column into view and moves focus to the column heading (now `tabIndex=-1`), so the next Tab continues inside the column instead of the page top, and the default anchor navigation is prevented, so no `#db-col-*` hash enters the URL and none survives the Board to List toggle. The bar also now shows up to 760 px, the width where the columns stack (measured: five 712 px columns at 760 px, five 240 px columns at 761 px), instead of stopping at 639 px and leaving 640 to 760 px stacked without it; the stacked-width sticky column heads follow the same breakpoint.
- **A board card's PR chip no longer sticks out of narrow cards.** The card's top row (priority, spec badge, PR chip) now wraps instead of overflowing: at 1280 px the Review column cards are about 221 px wide and the chip's right edge moved from 8.3 px past the card's right edge to 13 px inside it; at 390 px the row still fits on one line.
- **The spec badge explanation is readable without hover.** `ConfidenceBadge` is now a `role="img"` (an `aria-label` on a role-less span is an axe `aria-prohibited-attr` violation) and its accessible name carries the tooltip's whole explanation ("How complete the task spec is (0-100). Project threshold: N."), so a touch screen reader reads what only the title tooltip showed; the visible badge text and the title are unchanged.
- **Task states the engine accepts or writes now come from the task's workflow, so a custom vocabulary cannot be mishandled.** The Grounding GitHub webhook no longer writes the literal `done` or `in_progress`: an issue close or a positive merge target is the workflow's terminal state (`terminalTargetFrom`, `pickMergeTargetStatus` with the task's definition, as the regular webhook does), and a changes-requested review on a task in a review-like state moves it along the review state's non-terminal edge (`requestChangesTarget`); a workflow without such an edge keeps the status and logs a warning. A Grounding webhook write into a terminal state now also clears the work and the review claim in the same write, so the Grounding webhook is no longer an exception to "a finished task carries no claim" (the claim repair stays as the backstop for older rows). The API status inputs follow the workflow too: `POST /projects/:id/tasks` and the batch import accept a state of the pinned workflow, else the project default (plus `backlog`), human `PATCH /tasks/:id` accepts a state of the task's effective workflow plus `backlog` and `abandoned`, and the MCP `tasks_transition` and `tasks_list` status arguments are free strings that the backend judges. `GET /projects/:id/tasks` and `GET /tasks/claimable` accept the workflow states of the project (every workflow row of it; at team scope the built-in states and every row of the team) plus `backlog` and `abandoned`. An unknown name is still a 400 in the old shape (create: the body-validation error on `status`; PATCH: `bad_request` / "Validation failed"; filters: the old `Invalid status` messages with the accepted names listed). The status filters now answer their 400 after the access check, so a caller without access to the project gets the 403. The home priority count (`counts.priority` of `GET /teams/:id/tasks`) counts a HIGH or CRITICAL task unless it is in the terminal state of its own workflow, `backlog` or `abandoned`, instead of the three literals `open`, `in_progress` and `review`. The Grounding creation router (`POST /projects/:id/tasks` and `/import` for a selected project) runs the same check on every item before it opens a transaction, so one unknown name still refuses the whole batch with nothing created (`validation_error`, path `tasks.<index>.status`). With the built-in workflow the lists, messages and counts are what they were, with two differences. On create and batch import, a caller without access to the project, or with a read-only role, gets the 403 where an unknown status used to get the body-validation 400 (so the answer discloses nothing about the project's workflow to a caller who may not write). On create, batch import and human `PATCH /tasks/:id`, a body with an unknown status and another invalid field reports only the other issue until that is fixed, because the status is judged after the body otherwise validates. Unchanged: an empty, over-long or non-string status still gets the single `invalid_value` issue. A stored definition that holds exactly the four built-in names in another order still lists them in the canonical order in those messages. Not changed: the workflow API still accepts only the four built-in state names, and the frontend home widgets (`isPriorityTask`), the CLI and the `mcp-server` package keep their fixed status lists, so a custom state is not yet reachable from them.
- **Text that Postgres cannot store is a 400 on every route, including the grounding routers.** Three inputs still answered a server fault: a NUL byte nested inside a value bound to a `Json` column (a task `templateData` or `metadata` string, say) reaches Postgres as 22P05 "unsupported Unicode escape sequence" rather than 22021 and answered `500 internal_error`; an unpaired UTF-16 surrogate (a JSON string such as `"\ud800"`) in any text field outside the team-name rule (a task title or a comment, for example) is refused by Prisma itself, before the query is sent, as a `PrismaClientKnownRequestError` with code `InvalidArg` and one of two message fragments ("unexpected end of hex escape", "lone leading surrogate in hex escape") and answered 500; and both error classes reached the grounding routers' own `router.onError` (`backend/src/routes/grounding.ts`, `backend/src/routes/grounding-migration.ts`), whose catch-all is `503 grounding_verification_unavailable`, so a refused value there looked like a Grounding outage. `appErrorHandler` (`backend/src/lib/error-handler.ts`) recognises each form explicitly (SQLSTATE 22021 and 22P05 as an `UnknownRequestError` message or `P2010` with `meta.code`, and the two surrogate fragments under `InvalidArg`) and answers `400 validation_error` with a fixed message naming the form ("Request contains a character that cannot be stored (NUL byte)", "(NUL byte in a JSON value)", "(unpaired surrogate character)"); it never echoes the database text or the value, and logs a warn per form with method and path only. The same refusal is exported and runs first in both grounding routers' `onError`, so a recognised form is the identical 400 while every other error keeps its status (a real Grounding failure stays 503, the `GroundingAccessError` and `GroundingReceiptVerificationError` mappings are unchanged) and every other unexpected error still answers 500. A well-formed surrogate pair (an emoji) is unaffected. Tests: unit cases per form plus a DB-backed suite against a real Postgres (`backend/tests/integration/client-error-status-db.test.ts`) covering the jsonb and surrogate routes and both grounding routers.
- **Leaving the project hub no longer leaves a second `<title>` element in head.** The hub segment renders no server-rendered title (`title: null` metadata, `frontend/src/app/projects/[id]/layout.tsx`) and `useDocumentTitle` (`frontend/src/components/DocumentTitle.tsx`) sets the tab title from an effect, so on the hub the assignment made the browser create an unmanaged `<title>`; after a client navigation away the next route's React/Next-managed title was added next to it and head held two elements. The hook now remembers the element it created when the document had no `<title>`, updates it in place on a title change (no flicker while mounted), and removes exactly that element on unmount, only while it is still in head; a title element that already existed (Next/React-managed or not) is never removed, and every other behaviour (layout vs page precedence, `ExactPathTitle`, soft navigation to the same URL, the board modal's query-only change) is unchanged.
- **The project hub's Retry no longer mounts the tab while the reload is in flight.** A failed project load on a non-board hub tab showed "Could not load project" with a Retry, but Retry cleared the error before refetching, so the child tab mounted and started its own fetches and unmounted again when the reload failed a second time, flickering and dropping the focus off the button. The error branch now stays rendered until a reload succeeds (the error is cleared on success, not at the start of the load); while a retry is in flight the button is unavailable (`aria-disabled`, kept focusable and focused, same pattern as the Select trigger) with a "Retrying" busy label and ignores clicks, and a second failure shows the banner again with Retry enabled. A retry that answers 401/403/404 still redirects as before; the board tab has its own load and Retry and is unchanged.
- **Team names that render as nothing, or reorder the text around them, are refused (400) on create and rename.** After the one-rule fix, names made only of the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the braille blank U+2800, combining marks or variation selectors alone (U+0301, U+FE0F, U+034F) were still accepted, and so were private-use characters (U+E000), noncharacters (U+FDD0-U+FDEF, U+FFFE, U+FFFF and the last two code points of each plane) and, inside a visible name, bidi controls (U+202A-U+202E, U+2066-U+2069) and the line and paragraph separators U+2028 and U+2029. `teamNameSchema` (`backend/src/lib/team-name.ts`) now refuses separators and bidi controls (`TEAM_NAME_DIRECTION_MESSAGE`) and private-use or noncharacter code points (`TEAM_NAME_UNASSIGNED_MESSAGE`) anywhere in the name, and treats the fillers, U+2800 and `\p{M}` (combining marks, variation selectors) as blank in the empty check, so a base letter plus combining marks (`e` + U+0301), emoji (variation selector, ZWJ sequence, flag) and inner spaces stay valid. The client blank check (`frontend/src/lib/teamName.ts`) mirrors the blank class, so the create form and the name card keep their submit controls disabled for those names. The "Team name" card input no longer sets `maxLength=100`: the attribute counts UTF-16 units, so it stopped typing at 50 emoji although the server allows 100 code points; the server's 400 message is shown for an over-long name. Names already stored are not changed; to count stored names made only of these characters run `SELECT count(*) FROM teams WHERE name ~ '^[[:space:]\u3164\u115f\u1160\uffa0\u2800]*$' OR name ~ '[\u2028\u2029\u202a-\u202e\u2066-\u2069\ue000-\uf8ff]'` (an approximation: names made only of combining marks, names with noncharacters or supplementary private-use characters, and fillers mixed with format characters are not counted).
- **A malformed JSON body and a NUL byte in a path id answer 400, not 500.** Two classes of client input never reached a route's own validation and surfaced as `500 internal_error`: an unparsable JSON body (Hono's JSON validator throws an `HTTPException(400)`, which the global handler did not know, seen on `POST /api/teams` and `PATCH /api/teams/:id`) and a NUL byte in a path id such as `PATCH /api/teams/ab%00c` or `GET /api/tasks/ab%00c` (Postgres refuses it with 22021 out of `findUnique`). `appErrorHandler` (`backend/src/lib/error-handler.ts`) now answers an `HTTPException` with a 4xx status in the shared `{ error, message }` shape under its own status (`400 validation_error` with "Malformed JSON in request body"; 401, 403, 404, 409 and 413 map to their usual codes, any other 4xx to `bad_request`), returns a response the thrower supplied as given, and leaves a 5xx `HTTPException` a generic 500. A Prisma error that carries Postgres 22021 (an `UnknownRequestError` whose message holds `code: "22021"`, or `P2010` with `meta.code` 22021 for a raw query) is a `400 validation_error` ("Request contains a character that cannot be stored (NUL byte)") without leaking the database message; it is logged at warn with method and path (not the value), so a NUL from server-side data stays visible. This is handler-level on purpose: one place covers every route and every input that reaches Postgres (path, query, body strings), where per-route `:id` validation would touch hundreds of handlers and miss the next route. Ids are plain strings, so a malformed UUID is not an error here, and every other unexpected error still answers 500. Tests: unit cases for each branch and a DB-backed suite (`backend/tests/integration/client-error-status-db.test.ts`) that runs the team and task routes against a real Postgres.
- **Team names follow one rule on create and rename, and a NUL byte is a 400, not a 500.** `POST /api/teams` and `PATCH /api/teams/:id` shared only part of the rule: a NUL byte in the name returned 500 `internal_error` (Postgres refuses U+0000 in text), a name made only of a zero-width space was accepted, newlines and other control characters were stored as is, and `POST` took a whitespace-only name (201) while `PATCH` trimmed it. Both routes now use one schema (`backend/src/lib/team-name.ts`): the name is trimmed, may not contain a control character (`\p{Cc}`: NUL, newline, tab, other C0, DEL, C1) or an unpaired UTF-16 surrogate (a JSON string such as `"\ud800"` made Prisma fail, also a 500; emoji pairs pass), may not be empty once format characters (`\p{Cf}`, such as the zero-width space) and whitespace (including NBSP) are removed, and is at most 100 code points (100 emoji pass, 101 are refused). A refusal is a 400 whose body keeps the shared validation shape and adds a top-level `message` naming the first failed rule (`zValidate(..., { message: true })` in `backend/src/lib/z-validate.ts`, so the body is still built in one place), so the "New team" dialog, the first-team form and the "Team name" card show the server's reason (the client shows "Request failed" for a validation 400 without it). The create form and the name card also refuse a name that is empty after removing format characters and whitespace before sending (`frontend/src/lib/teamName.ts`). Names already stored are not changed; to count stored names that break the rule (control characters, or only whitespace and zero-width or other format characters) run `SELECT count(*) FROM teams WHERE name ~ '[[:cntrl:]]' OR name ~ '^[[:space:]\u00a0\u2007\u202f\u200b-\u200f\u2060\ufeff\u00ad]*$'` (the format-character class is a common subset, not all of `\p{Cf}`; NBSP, U+2007 and U+202F are listed because `[[:space:]]` does not match them on Postgres 16 with `en_US.utf8`, and what `[[:space:]]` and `[[:cntrl:]]` cover depends on the database locale, so check the count against a few known rows). A DB-backed test runs both routes against a real Postgres.
- **Keyboard focus survives disappearing controls on `/tasks`, and an open dropdown menu no longer leaks keys to the page.** Three focus fixes. A `/tasks` row action that drops its own row from the refreshed list (Promote or Discard while the Backlog chip filters, a demote out of an Active view) unmounted the row's "..." trigger while it held focus and left focus on the document body; the page now hands focus to the trigger of the row that took its slot (the previous row's trigger when it was the last row, the results region when the table is now empty), and keeps it on the row's own trigger when the row stays. Dismissing the "Failed to load tasks" banner now focuses the inline "Couldn't load tasks" Retry that takes its place, and either Retry focuses the results region it refetches into instead of dropping focus. And the `DropdownMenu` panel now stops keydown while it is open, for every caller (account menu, team menu, project picker, row menus): typing inside an open menu no longer fires page shortcuts such as `c` (New task) or `/` (search focus) on `/tasks`; Escape still closes the menu (the shared popover handles it before the panel sees it) and the arrow keys still cycle items. The `/tasks` row menu's own stop-propagation wrapper is gone, being redundant now.
- **The backend production image boots on arm64 (Apple Silicon) hosts.** The Prisma client was generated with `binaryTargets = ["native", "debian-openssl-3.0.x"]` in a build stage without openssl, so on arm64 `native` resolved to `linux-arm64-openssl-1.1.x` and the openssl-3 prod image crash-looped with a missing query engine. `linux-arm64-openssl-3.0.x` is now a binary target and the `backend/Dockerfile` build stage installs openssl so Prisma detects the right libssl. x64 images keep the same `debian-openssl-3.0.x` engine; the image now contains the x64 and arm64 engines instead of an unused openssl-1.1.x one (amd64 image 150.26 MB before, 149.90 MB after; arm64 149.136 MB before, 149.137 MB after). `SMOKE_BUILD_PLATFORM=linux/amd64` is no longer needed for `tools/backend-docker-smoke.sh` on an arm64 host. A test pins both targets and the build-stage openssl. `Dockerfile.migrate` (`npm ci --ignore-scripts`) is unchanged: it fetches the schema engine for its platform at runtime.
- **The dialog close button sits near the card's top-right corner.** The `Modal` header had 32 px top and right padding, so the visible X was about 40 px from the card edge on desktop (24 px at 760 px and below). The header now uses 16 px top/bottom and 12 px right (12 px top/bottom and 8 px right at 760 px and below), which puts the X about 20 px from the edge (16 px on mobile). The 32×32 click target is unchanged and the title keeps its left inset aligned with the body. Applies to every dialog built on `Modal`; `ConfirmDialog` and the attachment preview have their own layout and are unchanged.
- **A team member who is also a project admin sees the admin controls the backend already allows.** `GET /projects/:id` reported `accessRole` with the team role first, so a team `HUMAN_MEMBER` or `REVIEWER` who also holds a `PROJECT_ADMIN` grant on the project reported their team role, and the workflow editor, the "Customize for this project" action and the task status-override and claim-release controls stayed hidden, although every workflow, force-transition, invite and project-settings write route accepts that user (`isProjectAdmin`), except minting a `PROJECT_ADMIN` invite, which also needs the team `ADMIN` role. The response now also carries `canAdmin: boolean`, computed with that same `isProjectAdmin` check (true for a team `ADMIN`, a `PROJECT_ADMIN` with or without a team membership, false for team `HUMAN_MEMBER` or `REVIEWER` without the grant, for `PROJECT_CONTRIBUTOR`, `PROJECT_VIEWER` and for agents). `accessRole` and `accessSource` are unchanged (team role first), and `getProjectMembership` keeps its semantics. The workflow page, the board task modal and `/tasks/[id]` gate their admin controls on `canAdmin` through `projectCanAdmin` (`frontend/src/lib/api.ts`); `canAdmin` wins when the response has it, and a response without it (an older backend) falls back to the previous `accessRole` rule. Write-tier gates are unchanged: every team role is write-capable and a per-project share reports its own role, so `accessRole` already shows the write tier correctly. The project list does not return `accessRole` or `canAdmin`. A DB-backed test runs the real routes and pins that `canAdmin` agrees with what the workflow customize route allows for every principal.
- **In-app links to team-scoped pages carry the current team where it is known, so the opened page names its team from the first render.** A team-scoped page whose URL names no team writes the team it resolved into the URL, and that write is a navigation which can discard a click still in flight; the header links already carried `?teamId=`, and now these do too when the current team is known at the link: the `/tasks` boot-error "Projects" link carries the team the URL names (a failed lookup does not erase the URL's team), the "Go to projects" link in the `/tasks` create flow carries the page's team, the `/settings` "Open team settings" link carries the team the shell resolves exactly like the header (`?teamId`, then the remembered team, then the first team; personal settings resolve it for the link only and never write it into their own URL), the `/settings/team/sso` breadcrumb and API Tokens link carry the token's team once a token has unlocked the page, the Connect-an-agent dialog's "Team settings → API Tokens" link carries the team its token was created for, and the `/onboarding` redirect for a user who already has teams carries the team `/home` would resolve on entry (remembered, then first). Links where no team is known stay bare and keep today's behaviour: the invite page's "Back to home" and the team-less `/onboarding` skip link (no team exists), the `/tasks` no-team empty state (the user has no teams to name), the entry redirects (`/`, `/auth`), the legacy `/projects/workflow` and `/teams/tokens` redirects (the team is never loaded there), and the project hub and board 403/404 fallbacks to Projects (the project failed to load, so its team is not known).
- **The header and the team-scoped pages always show the same team: they read one team list.** `AppChrome` loaded the caller's teams once for the header while `/home`, `/projects`, `/tasks` and `/settings/team` each loaded their own copy, so after a membership change (a team created or joined elsewhere) a URL `?teamId` could name a team the header's older list lacked and the header showed a fallback team while the page showed the URL's. The shell now owns one list (`frontend/src/lib/teamList.tsx`) that the header and the four pages read, so a normal page load makes one `GET /api/teams` request instead of two (header and page). When `?teamId` names a team the list lacks, the list is reloaded once per missing id (the header and the page asking together cause one reload; a reload that fails keeps the old list and does not retry), and the fallback team is written into the URL only after that reload answered. Creating a team from the "New team" dialog reloads the list before it opens the new team's Home. A team list that failed to load is retried once when the next team-scoped page mounts (a persistent failure costs one request per page mount, never a loop), and the pages resolve no team, request no team data and write no `?teamId` until the session check has answered with a user.
- **Loading a project with an expired session now goes to sign-in instead of a dead-end error.** On the project hub and the board, a 401 from the project load (expired or invalid token) previously showed "Could not load project" / "Could not load tasks" with a Retry that could not succeed until a manual reload from elsewhere. It now redirects to `/auth?redirect=<current path and query>`, so the sign-in page opens and, after signing in, the user returns to the project location (full path and query); 403/404 keep redirecting to the Projects page and 500 or network failures keep the message with Retry.

- **/onboarding says so when shared projects could not be checked.** A team-less user whose unscoped `GET /api/projects` lookup failed saw only the create-team form, silently implying nothing was shared. A hint ("We couldn't check for projects shared with you.") with a Retry button now shows above the form, which stays usable; Retry disables with a busy state while the lookup runs, a success clears the hint ("Skip for now" appears when projects come back, and stays hidden when there are none), and a failure keeps the hint for another try. No hint when the lookup succeeded. `needsOnboarding` and the entry redirects are unchanged; the fail-soft lookup moved into `retrySharedProjects` (`frontend/src/lib/access.ts`), used by both `getAccessContext` and the Retry button.
- **Dismissing "Failed to load tasks" on `/tasks` leaves a compact inline Retry, not a blank list.** When the current team's load error was dismissed and no list existed for that team, the list region rendered nothing until the 30 s poll: no skeleton, no list, no way back except waiting. The region now shows an inline "Couldn't load tasks" with a Retry button (keyboard operable) that runs the banner's own Retry path: clear the team's error, start a fresh request, show the loading state, then the list or the banner again. The dismissal itself still does not fall back to the loading state, and a team that has a list on screen keeps behaving as before (dismiss removes the banner, the rows stay).
- **A token created while the team changes is no longer lost: its one-time secret is shown naming the token and the team it belongs to.** On `/settings/team`, switching teams while a create request was still in flight replaced the token section, and the secret in the response was dropped without a trace. The page now holds each reveal, one per create and tagged with the team it was created in (React state only: nothing is stored, put in the URL or logged, and it is gone when the page closes). After a switch, the secret appears once in a banner titled `Token "<name>" created for <team> (shown once)` above the section of the team you are viewing, with the usual Copy, mask-after-30-seconds, Reveal and Dismiss, and it is never listed under the other team; going back to its team shows it in that team's section as before, also while that team's token list is still loading or failed to load. Several creates, also for one team, each keep their own reveal (newest on top, each with its own timer and Dismiss), so a late response can no longer swap one secret for another. A token created while its section was gone is appended to the list when you are back in its team, without reloading it, so an open create or rename dialog stays open. A create that fails after the switch shows "Failed to create token for <team>" with the error instead of vanishing. Creating without switching is unchanged, except that a second create no longer replaces the first one's reveal. The "Connect an agent" dialog is covered by the next entry.
- **A token created through "Connect an agent" keeps its one-time secret when the team changes, or the dialog is closed, during the create.** The dialog held the secret in its own state and was unmounted with the token section on a team switch, so the response was dropped without a trace; a dialog closed while the request was pending kept it in hidden state that a reopened dialog then showed. The dialog still shows its snippets and the secret itself while it is open. When it cannot (it was closed, or its section is gone, before the response arrives) the secret goes to the page-held reveal of the same flow, tagged with the team the request was made for: after a switch it appears once in a banner titled `Token "<name>" created for <team> (shown once)` above the section of the team you are viewing and is never listed under the other team; in its own team it appears in that team's section, and the token is added to the list. A secret still on screen in the dialog when its section is unmounted (back/forward to another team) is handed over the same way, and one the dialog had already masked (after Copy snippet) arrives masked, with Reveal available, never in clear. A dialog closed by hand discards the secret as before, and a reopened dialog starts clean, whichever request is still pending. A create that fails after the dialog was closed or the team changed shows "Failed to create token for <team>" with the error instead of an error in the wrong place. Nothing is stored, put in the URL or logged, and a response that arrives after the page is gone keeps no secret and starts no timer.
- **Muted text in the dark theme meets 4.5:1 contrast on every surface.** The dark `--muted` token (`#6d7480`) measured 4.23:1 on the page background and fell to 3.39:1 on the active header-nav surface, so nav links, settings labels, tab labels and task-row meta text failed WCAG 1.4.3. It is now `#848b98` (5.81:1 on `--bg`, 4.65:1 on `--surface-active`, still dimmer than `--text-secondary`); a unit test pins the ratio on all five dark surfaces. The light theme is unchanged.
- **A project admin without a team membership can edit the project's workflow.** The workflow page enabled editing only for a team ADMIN, although every workflow write route (customize, apply-template, reset, create, update) accepts a team ADMIN or a per-project PROJECT_ADMIN, so a project-only admin saw a read-only page for a project they administer. The page now gates on the project's `accessRole` (the same field the board page uses) and no longer loads the team list; its hints and the governance field copy say "project admins" instead of "team admins". The backend 403 message text is unchanged.
- **Home shows true counts: every widget is filled from its own scoped request, and "+N more" counts the rows not shown.** `/home` filled all six widgets from one `GET /teams/:teamId/tasks` call that the backend caps at 500 rows (newest update first), so in a team with more than 500 tasks the Backlog, Active, Review, Priority and My Tasks widgets could miss rows (a Backlog tile saying "15 total" over three rows) while their server counts stayed right; the link also said "+5 more" for `total - 10` whatever number of rows was on screen. Each widget now asks for its scope (`status`, `priority`, `mine`, `recency`, `limit=10`, as the `/tasks` presets do) and the link shows `total - rows shown` (hidden when 0), so 15 total over 3 rows reads "+12 more" and over 10 rows "+5 more". The 15 s poll makes six parallel requests (it made one); the active request asks for up to 500 rows so the "Your projects" strip can show a project's active count only when the active rows are provably complete (`counts.open` <= rows), which now holds in more cases than the old whole-team check. No backend change. The stale-data warning ("Last update failed; ...") is no longer in the page's accessibility tree while the data is fresh: the banner is rendered only while the warning is active. The Home reference chip uses the primary text colour (axe colour contrast on `/home` in light mode: 0 violations, was 9 nodes) and truncates from the start so the distinctive end of a long reference stays visible.
- **Approving through the legacy `POST /tasks/:id/review` route no longer leaves the work claim on the finished task.** The approve write cleared only the review lock, so the author kept an active-looking claim on a terminal task until the deploy repair (`clear-terminal-claims`) ran. It now clears the work claim and the review lock in the same compare-and-swap write, using the shared `clearAllClaims` field set, whenever the target is a terminal state of the task's own workflow (also a pinned workflow with a custom terminal name). `request_changes` is unchanged: it clears the review lock and keeps the work claim so the author can resume.
- **Workflow customize, apply-template and reset act on the default row readers use.** With more than one default workflow row in a project, these three routes selected a default row without an order and could modify or delete a row the readers (and the SQL repair) do not use. They now pick the oldest default row (`FIRST_DEFAULT_ROW_ORDER`: `createdAt`, then `id`), covered by an integration test with two default rows. Duplicate default rows themselves are not collapsed and no unique index is added.
- **In the `/projects` Table view the row "..." menu runs its items instead of opening the board.** Enter on "Workflow" or "Delete project", and a click on "Delete project", opened the project's board: the menu panel is rendered into the page body, but its events still reached the table row, which navigates. Table rows now ignore clicks and keys that start outside the row, so "Workflow" opens the workflow page and "Delete project" asks for confirmation, in every table whose rows open a page or a dialog.
- **The last pages outside the page frame join it, and section headings share one size.** The `/projects/workflow` redirect states render in the default page column instead of a 480px box centred under the header, `/settings` and `/settings/team` show their real header band and column while loading instead of a viewport-centred spinner (the title no longer moves when the sections arrive), and the project settings page takes its 760px measure from a class instead of an inline style. Section headings on Home widgets, settings, the hub tabs and task detail use one `--heading-section-*` token pair (14px, weight 600; Home widgets and the workflow tables were 12 to 13px, the workflow tables 700), and the task-detail breadcrumb has the project breadcrumb's size.
- **Home widget links and settings inline links meet WCAG contrast and are distinguishable without colour.** The home widget text links (`.widget-link`: "N total", "+N more", "older done") used the raw accent fill `--primary` as their text colour, 4.05:1 on the dark surface (axe color-contrast, 8 nodes on `/home` in dark mode); they now use the accent text token `--primary-text` (8.0:1 on the dark `--surface`, underline on hover kept; light improves from 4.7:1 to 7.1:1 on white). The settings inline link (`.settings-inline-link`, the API Tokens links in team settings and the SSO page) carried only the `--link` colour at 1.44:1 against the surrounding `--muted` prose with no underline, failing axe link-in-text-block in both themes; it is now underlined in both themes and the underline thickens on hover. A unit test pins the token choice, the token's 4.5:1 ratio on all five dark surfaces and the underline.
- **A merge-only token gets the merge gate that refused it from the grounding-attempt route, not `Token missing scope: tasks:transition`.** `POST /tasks/:id/grounding-attempts` rethrew the claim path's scope refusal whenever merge eligibility refused too, which sent a standalone merger (`github:pr_merge` and project write access, no `tasks:transition`, no claim) after a scope and a claim it can never use, while `task_merge` named the real gate. The route now gives a merge-only caller the refusal merge eligibility answered with (consent, review lock or approval gate, transition role, or `409 bad_state` in any state), as `task_merge` does. As before, a merge-capable caller (a human, or an agent token with `github:pr_merge`) that neither path admits gets merge eligibility's `409 bad_state` on an initial or terminal state or an ambiguous review workflow, or an unavailable workflow definition's own answer; otherwise the caller keeps the claim or scope refusal. The full precedence, per combination of claim, `tasks:transition` and `github:pr_merge` and for humans, is in `docs/agent-workflow.md` (grounding-attempt issue route).
- **Nine accent-hue text rules meet 4.5:1 contrast in the dark theme.** The raw accent fill `--primary` is 4.05:1 on the dark `--surface`, below the 4.5:1 the plain link rule (`a`), the active auth tab, markdown links, the board "Show N more" expander, the task result "Show more" toggle, the artifact and attachment doc links, the workflow instructions link hover and the import dialog reference cells need as normal text. A new `--primary-fg` token now carries accent-hue text: it resolves to the text-safe `--primary-text` (8.0:1 on the dark `--surface`) in dark and to `--primary` in light, so light mode keeps exactly the colour it has today (`#5e6ad2`). Icon and large-bold uses of `--primary` (the brand icon, the board share icon, the done-stat number) need only 3:1 and keep the raw fill. Markdown links in task descriptions and results are underlined in dark so the lighter colour stays distinguishable from the surrounding text; light keeps its colour-only link. A unit test pins the nine rules on the token, the dark resolution at 4.5:1 on all five dark surfaces, the light resolution at `--primary`, and the light `--primary-text` at 4.5:1 on all five light surfaces.

### Security

- **Production deploys no longer accept data loss.** `Dockerfile.migrate` ran `prisma db push --accept-data-loss` on every deploy, so a schema change that drops a populated column or table was applied silently, and a rollback of the images did not bring the data back. It now runs `prisma db push` without the flag. Upgrade note: any schema change for which Prisma prints a data-loss warning (including adding any UNIQUE constraint, with or without duplicates, dropping a populated column or table, and lossy type changes) now makes the `migrate` service exit non-zero and stops the deploy. `backend` does not start, and the backend and usually the frontend, which compose recreates for such a deploy, are left in `Created` state: the whole site is down until agent-relay's automatic rollback completes, and stays down if that rollback is blocked. Apply such a change deliberately: build, stop the backend, back up, then a one-off `docker compose run --rm --no-deps migrate sh -c '... --accept-data-loss'`, see `docs/ops-backups.md` ("Applying a destructive schema change"). The two SQL steps still follow on success.

### Changed

- **The `/tasks` presets and the Home widgets follow each project's workflow states, not five fixed names.** The Home Priority widget already did; now My Tasks, In Review and Done on `/home` and the Priority, My Tasks, In Review and Recently Done tabs on `/tasks` resolve their status lists from the stored workflows of the team's projects: My Tasks and Priority ask for every non-terminal state (not backlog, not abandoned), In Review for the review-like states (the frontend port of the backend's `isReviewState`: not the entry state, not terminal, an edge into a terminal state, not a direct target of the entry state), Done for the terminal states. Both are read the way the backend reads a stored definition: after its backlog clean-up (a legacy copy with entry state `backlog` reads as `open`, `backlog` and every edge into it are dropped, an edge out of it is remapped or dropped) and with the built-in names as the fallback for a definition the backend cannot read, so a legacy copy of the built-in default no longer lists `in_progress` as review-like. A shared fixture file pins the backend's answers for both copies. A widget keeps the rows whose status means that scope in the task's own workflow (a state named `review` in a workflow where it is not review-like stays out of In Review; `shipped` counts as done only where it is terminal), and a name that is terminal in one workflow and open in another is requested and then filtered per task. Active stays open and in progress. On `/tasks` the `status=` parameter keeps every state name in the URL (it reaches the first request before the workflows are read, survives a chip click meanwhile and when a project's workflows answer 403; the team task list does not check the names, so a name no workflow defines lists no tasks and stays in the URL until the filter is cleared or reset), each custom state gets a filter chip (labelled as the workflow labels it, only once its workflow is loaded), and "custom filter" detection compares against the resolved preset, so Home's Priority link opens a view that includes the custom states. Until the workflows are read, and for a project whose workflows cannot be read, the fixed built-in lists apply (open/in progress/review, review, done). Home asks again once only for the widgets whose list grew when the workflows arrive. Also: a project whose workflow list answers 403 is asked once per team instead of on every 15 s Home poll; other failures are still retried. The `/tasks` tabs filter by status name on the server, so a name that has the scope's meaning in one workflow (terminal for Recently Done, review-like for In Review) also lists that name's tasks from projects where it means something else; the Home widgets keep only the rows whose status has the scope's meaning in the task's own workflow. The Active tile and widget are unchanged.
- **The dependency picker in the task detail is searchable.** "Add blocker..." is now a text input that filters the project's tasks as you type (a title substring in any case, or the start of a task id; an id is matched by prefix only, so a query never hits the middle of an id), instead of a flat list of titles. Each option shows the title, the first 8 characters of the id and the status, so tasks with the same title can be told apart. Arrow keys move through the filtered list, Enter selects (the Add button still adds), Escape or the chevron closes (a click inside the input keeps the list and the query), the input always holds exactly what was typed while the chosen task is shown inside the field with its id and status never truncated and is announced to screen readers as the field's description, and no match shows "No matching tasks". The shared `Select` gained an opt-in `searchable` prop for this; every other `Select` is unchanged.
- **Grounding 403 refusals name the precondition that failed.** The Grounding write routes (`pull_requests_create`, `pull_requests_merge`, `task_merge`, `task_finish`, `task_abandon` and `task_grounding_attempt_create`) answered their refusals with the bare `{ "error": "forbidden" }`, leaving agents to guess whether the token lacked a scope, the project denied write access, a claim was missing or a merge gate refused. The body keeps `error: "forbidden"` and every reachable refusal except the three bare answers below now carries a `message` naming the precondition: the absent scopes (`Token missing scope: ...`, or `Agent token required` for a non-agent caller), no write access, neither claim held, the review or work claim an approval, request-changes or finish needs, the review approval gate, the transition's project role, the self-merge gate, the missing `allowAgentPrMerge` or `allowAgentPrCreate` consent, a foreign deliverable repository, and an Idempotency-Key or active grounding attempt that belongs to a different caller; the attempt route's error handler now carries the message too, and when that route's claim and scope check refuses and merge eligibility refuses too, or does not apply because the task is in a work state outside review (both run before the request's `intent` is read), the answer is the claim or scope refusal (the exceptions are in the Fixed entry on the attempt route). Three answers stay bare: those that keep task existence unobservable (the legacy handler's own answer on the GitHub create and merge routes, one 403 on the attempt route), a linked task of another project the caller cannot write inside a multi-task merge, and a refusal caused by access, the token or a claim changing while the request is in flight. The MCP layer passes the message through, teaches a team-admin token re-mint when the message names an absent `github:*` scope (existing tokens never gain new scopes), and gives each verb its own precondition list (no list for an unknown verb) when an older backend sends no message. `docs/state-machines.md` and the `task_merge` tool description now state the real self-merge answer: `forbidden` with a message on a task enrolled in Grounding (any Grounding cohort, including admin-migrated tasks), `self_merge_blocked` on a task the legacy handler serves (not enrolled in Grounding and outside the enforced Grounding scope; inside that scope a merge of an unenrolled task answers `409 grounding_enrollment_required`).
- **Home's widget overflow links are one footer row, and its empty-state links carry no text arrows.** The last `&rarr;` text links on `/home` are gone. The "+N more" and "older done" links in a full widget are replaced by one full-width footer row at the bottom of the card (hairline top border, 32px tall, the task row's quiet accent fill on hover, a visible focus ring in both themes): a "N more in Tasks" link with the aria-hidden `arrow-right` Icon and, when the Done widget has tasks beyond the 14-day window, a quieter "N older than 14 days" link in the same row (the day count comes from the same `DONE_RECENT_DAYS` constant the filter uses). In an empty Done widget with older tasks, "Show N older done" is now a ghost Button in the `EmptyState` action slot like the other empty states' actions, and the projects strip's "Go to Projects" is a plain underlined inline link (the settings inline-link style). Accessible names contain the widget title and the visible text (e.g. "Backlog: 2 more in Tasks"), so links that differ in href never share a name. Every href is unchanged (per-widget `moreHref`, `scope=done&recency=older`, the Projects page with `teamId`). The `.widget-link` styles are gone; `.home-widget-footer` is now the footer row itself.
- **Home widget headers carry a quiet "View all" link instead of an accent link with a text arrow.** Each `/home` widget header reads title, count, "View all": the count is plain secondary text (no longer the link itself) and the link is a new `ViewAllLink` primitive (secondary text, quiet accent fill on hover, 28px target, `arrow-right` Icon instead of a text arrow, a visible focus ring in both themes). Its accessible name contains the widget title ("View all Backlog", "View all Done · 14 days"), so no two header links share a name, and "All projects" in the projects strip uses the same component as "View all projects". Every href is unchanged (scope presets, Backlog's `status=backlog`, Done's `recency=recent`, the Projects page). The header count and the "View all" link render at `--text-sm` (12px) where the old count link was `--text-xs`. The `.home-widget-more` and `.home-projects-all` styles are gone.
- **"New team" opens a dialog in the app instead of a separate page.** For a user with at least one team, "+ New team" in the team switcher and "New team" in the account menu open a dialog (name, slug, "Create team" and "Cancel") over the page they are on, with the header still visible; Escape and Cancel close it and put focus back on the button that opened the menu, a failed create shows its error in the dialog and keeps what was typed, and a successful one opens the new team's Home as before. The form is shared with the first-team page, which is unchanged for a user without a team (still in the sign-in frame, with Sign out). `/onboarding?create=team` is gone: a user with a team who opens it lands on `/home`. The onboarding button now reads "Create team" instead of "Create Team".
- **Pages share one centred column: settings, task detail, SSO and the project tabs line up at every width.** On a wide screen the page frame now centres a 1200px column instead of leaving the content at the left edge, and the title band keeps its full-width background and bottom border while its breadcrumb, title and the project tab row align to that column (at 1920 wide the title starts at 360px instead of 24px; under 1248px nothing moves from the page gutter). The board and `/tasks` stay wide and on the gutter, the project band follows the active tab (gutter on the board, column on Members, Workflow and Settings), task detail uses the same column in its loading, error and loaded states, and the SSO page sits on the default column with its form kept at 760px. The `centered` and `narrow` options of the page frame are gone.
- **Home and Projects use the same page frame and title band as the other pages.** `/home` and `/projects` now render through the shared page frame with a title band like `/settings` and `/tasks`, so their title starts on the same centred column as every other page (at 1920 wide at 360px, was 384px; at 390 wide at 12px, was 16px) and the old separate `.page-shell` layout is removed. On Home the team name is the page title and the "Task overview across all your projects." line is gone; on Projects the title is "Projects" with the team and its project count next to it (the team name is no longer a second-level heading; a long team name shortens with an ellipsis instead of widening the page, and one project reads "1 project", not "1 projects"), and Sync GitHub / New Project sit in the band. The Home loading skeleton and the Projects loading state use the same frame, so the page no longer jumps when the data arrives. The Projects cards view sorts with the shared dropdown inside the filter row (it was a native select on its own row at desktop widths), the Projects title has the same weight (600) as every other title, and the Home widget cards keep their own height instead of stretching to the tallest card in the row. No backend change.
- **Home's six stat tiles are one scope strip.** The row of identical boxed tiles on `/home` is now a single navigation (`Task scopes`) with two groups: the filters (Mine, Priority) and the stage flow (Backlog, Active, In Review, Done · 14 days) joined by chevrons, separated by a hairline. Number first, label secondary, no boxes; the six links, their order, their counts and their destinations are unchanged, and each link is announced as "<n> <label>" (e.g. "4 Done · 14 days"). Below 560px the two groups stack as two lines with the stage line spread across the width (it wraps instead of scrolling sideways on narrower phones). The old `.home-stat-tile` and `.home-stat-strip` styles are removed.
- **Task detail reads in plain words, the URL follows the board modal, and every page has a title and a consistent breadcrumb.** "Missing:" lists show field names as labels ("Out Of Scope", not `outOfScope`) in the task detail and the create-confidence panel, and the workflow note is one sentence per status of the default workflow, including backlog ("This task is a draft; promote it to Open to make it pickable."), instead of "in an unknown state". Opening a card on the board adds `?taskId=<id>` and closing it removes it, with `window.history.replaceState` (Next adopts the URL without fetching the route again, so the document head and the tab title stay as they are): open and close add no history entries, so Back leaves the board instead of toggling the modal, a reload after close does not reopen it, other query parameters and the jump bar's `#db-col-...` hash are kept, and a `?taskId` that is not in the project is dropped. The browser tab reads "<Project> · Board - agent-tasks" on the project tabs, "<Task title> - agent-tasks" on a task, and "Home", "Projects", "Tasks", "Settings", "Team settings", "Single sign-on" and "Workflow" followed by " - agent-tasks" elsewhere (set client-side by `DocumentTitle`, with the segment `metadata` as the server-rendered value; the project hub `/projects/<id>/*` renders no server title, so a click on the current tab keeps "<Project> · Board"). The task page breadcrumb is "Projects / <Project> / <Task title>" with the title as `aria-current="page"` (a "Tasks" crumb still leads when the page was opened from the list), and `/projects` has the H1 "Projects" with the team name below it. "Open as full page" from the board modal links to `/tasks/<id>?from=board`, which keeps Projects (not Tasks) highlighted in the header nav. The admin status override moved from an always-visible "Admin" row into the task "More actions" menu: admins pick "Change status..." to open the picker (focus moves to it, Close dismisses it), everyone else sees a disabled "Change status (admins only)" entry with the reason.
- **On `/tasks` a filter that no longer matches its tab says so, the "Mine" toggle is gone, titles get the width, and row actions sit in one menu.** When the status or priority chips, or the `mine` flag, differ from the active scope tab's preset, no tab is shown as selected, the heading reads "Tasks · custom filter", and the tab row carries a "Custom filter" chip with a "Reset to <tab label>" action that returns to the active tab's preset (the tab label in its name keeps it apart from the filter band's "Clear filters"); the state is read from the URL (an explicit chip set equal to the preset is the tab, not a custom filter), so it survives a reload and a shared link, and the tablist keeps a tab in the tab sequence while none is selected. The header "Mine" toggle is removed: the My Tasks tab is its replacement, and because the status chips combine with it, "mine" plus any status set stays reachable (the `mine` URL parameter still resolves, so bookmarks and the Home widget link work). No column of the task table declares a width any more, so the browser's auto layout gives the Project, Due, Updated, Status and Priority columns their content width and the Task column all the rest (at 1440px: 785px versus 126px, 125px, 93px and 102px), and a title wraps to at most two lines instead of truncating to one. Each row now has one "..." button opening a keyboard-operable menu with the same actions as before (Promote and Discard on backlog rows, Move to backlog on open rows, the claim hint shown as a disabled menu item), with menu semantics for screen readers and focus back on the "..." button after an item runs, which frees the width the buttons used to hold.
- **The board reads and works as a list of headed cards: column titles are headings, each card is an article with a titled button, overdue is said in words, column heads stay in view, and an empty project shows one first-run state.** Column titles are `h2` and each card is an `<article>` whose `h3` holds a button named by the task title; priority, spec score, labels, due date and assignee are the button's description, so a screen reader hears the title first (axe reports no heading-order or aria-prohibited-attr finding on the board; the board is a labelled group). A click anywhere on the card, or Enter or Space on the title, still opens it. An overdue due date reads "Overdue" next to the date, in the card and in its description, not by colour alone, and the due date uses the secondary text colour. A "Skip to board" link is the first stop after the header nav on the board tab, ahead of the project header, search, filter, view toggle and buttons, and moves focus to the board, the list or the state message below the toolbar in every state. The column "+", the assignee avatar, the label remove button and the comment Delete/Confirm/Cancel controls are at least 24px square. The five column heads are equally tall (the columns without a "+" keep an empty slot) and stay in view below the sticky toolbar from 1280px and below the jump bar under 640px. A project with no tasks shows one empty state with New task, Import and Connect an agent (the API tokens section of the project's team settings, hidden for users who cannot create agent tokens) in the board and the list view, instead of five "No tasks" boxes; a project whose tasks are all filtered out keeps its columns.
- **At 390px no page scrolls sideways, the narrow-screen padding overrides apply, and the stacked board has a column jump bar.** The `@media (max-width: 420px)` block sat before the base rules it overrides, so it never took effect; it now follows them and keeps its side padding on `--page-gutter`, as do the List view bands (`.db-list-wrap`, filter bar, status summary, access banner, empty-state wrapper) and the narrow header override, so the List view, heading and search share one left edge at 500px too. `/tasks/<id>` no longer scrolls sideways from a long unbroken identifier (markdown and comment bodies wrap anywhere, the single-column detail grids use `minmax(0, 1fr)`), and the `/tasks` scope tabs scroll inside their own strip instead of widening the page. Under 640px the board shows a sticky row of column chips (name and count) that jump to each column; the toolbar stops being sticky there so it does not cover them.
- **A user with a team can create another one, the settings side nav starts on its first section, and project governance reads in plain language.** The team switcher menu ends with "+ New team" and the account menu has "New team" (both open `/onboarding?create=team`): the same create form, without the redirect to `/home` that a user with a team gets from plain `/onboarding`; after creating, the new team is remembered and its Home opens. `/settings` marks Account (not Appearance) as the current section at scroll 0 and sets `aria-current="location"` on the active side-nav link. Project settings governance options lead with a plain sentence and keep API routes and signal names behind a "Details" disclosure, and the project header chip and the settings option share one label per mode (Second reviewer, Human confirmation, Autonomous; the chip said "Dual-control" / "Awaits confirm"). The workflow state flow has a legend saying the number next to an arrow counts the gates that must pass for that transition.
- **Pages share one frame: a project header that no longer sits in a 1200px column, one gutter, one `<main>`.** A new `PageShell` (default 1200px, narrow 760px, wide unbounded) renders each page's `<main>` with a full-width header slot and a left-aligned content slot, and one `--page-gutter` token (24px, 12px under 600px) feeds the app header, page headers, the project hub band and the content slots. On the project hub the crumb, project name, tab row and the tab row's bottom border now span the viewport and start on the toolbar's left edge on every tab (they used to be centred in 1200px, 360px in from the board's toolbar at 1920px), the project pages render exactly one `<main>` (they had none), and Members, Workflow and Settings stay a left-aligned 1200px column. `/tasks` gets a wide header and table on one left edge, and Settings, Team settings, the SSO page and the task detail page lose the doubled gutter that pushed their title 48px in. The active header nav link now uses a theme token, so it shows in light mode (it was a white tint on a near-white header).
- **"Open" (open + in_progress) is "Active" on Home, `/tasks` and `/projects`, with one definition.** The Home tile and widget, the `/tasks` scope tab and heading now read "Active" / "Active Tasks" (the URL scope value stays `scope=open`, the board column stays "Open"). One helper (`isActiveTask`, `ACTIVE_STATUSES` in `home/widgetFilters.ts`) defines active work as open + in_progress; the Home strip and the "N active tasks" on `/projects` both use it, so the same project shows the same number on both (the Projects page counted every non-done task, including review, backlog and abandoned ones). On Home the tiles are the single link to a scope: widget titles are plain text (the "N total" and "+N more" links stay), and "Recently Done" is labelled "Done · 14 days" from the recency constant instead of a literal.
- **UI/IA restructure: Home, Projects and Tasks as the nav sections, with a project hub centred on `/projects/<id>`.** The changes, one per item:
  - **The header nav is Home | Projects | Tasks, with a team switcher and an account menu that holds Settings, Team settings and Logout.** The "Dashboard" link is gone (`/dashboard` still redirects) and Settings left the nav bar for the avatar menu, where "Team settings" (`/settings/team`) appears for users with a team and "Create a team" (`/onboarding`) for users without one. Projects is now current on `/projects` and on every `/projects/<id>/...` route, board included. Between the brand and the nav, a switcher shows the current team: hidden with no team, a static label with one, a dropdown with two or more. Picking a team remembers it (`agent-tasks:lastTeamId`) and goes to the section root with `?teamId=` (`/home`, `/tasks`, `/projects`, `/settings/team`; from a project hub or board to `/projects`; personal `/settings` stays put). The URL names the team: `/home`, `/projects`, `/tasks` and `/settings/team` resolve their team from `?teamId` (then the remembered team, then the first team) and, when `?teamId` is missing or names no team of the user, write the resolved team into the URL (a replace that keeps the other query parameters and adds no history entry). The header's brand, Home, Projects and Tasks links and the account menu's Team settings carry the team the header shows (`?teamId=`; bare while it knows no team; following one also remembers that team), so a page opened from them already names its team and does not write the URL, and a click on another section made while that page loads is no longer cancelled by the write (a URL that names no team, such as a typed URL or a bookmark, is still written). The header resolves from the same `?teamId`, so once one of these pages has loaded its teams, the header and the page show the same team across switches and the browser's back and forward buttons, and a team remembered later by another tab changes neither. `/projects`, `/tasks` and `/settings/team` tag the data they load with its team and show only the current team's: after a switch they show their loading state (or the new team's load error) until the new team's data arrives; `/home` clears the previous team's tasks when its team changes. A late response or an action outcome of the team that was left (a late list, a project delete, create or GitHub sync on `/projects`, a row action on `/tasks`) is dropped. On `/tasks` a switch also closes the New task flow, and until the current team's list has loaded the page shows no task count and keeps New task and its C shortcut disabled, so the flow only ever offers the current team's projects; dismissing that list's load error leaves the list empty instead of showing a loading state. `/settings/team` names the team in its API Tokens section and shows a failed token load with a Retry button. The in-page team selects on `/tasks`, `/projects` and `/settings/team` are removed. The header reads the team list once per shell mount (`getTeams()` in `AppChrome`); if that call fails the header shows no switcher and no team entries. At 390 px Home, Projects and Tasks all stay visible (the old rule hid the first and last link by position): the brand text and the username give way, and the team name truncates.
  - **Home has a "Your projects" jump strip.** Above the task stats, `/home` now lists up to six projects, each opening its board: the projects whose board you opened most recently in this browser (a per-team list under `agent-tasks:recentProjects:<teamId>`, written by the board page, at most eight ids), then the team's other projects in the order the task aggregation returns them, followed by an **All projects** link to that team's Projects page. A project shows how many of its tasks are open or in progress only when that aggregation arrived complete (the backend caps it at 500 rows), so a truncated listing shows no count instead of a wrong one; a team with no projects gets one line linking to the Projects page, and the strip appears only once the tasks loaded (no empty-state flash). Projects shared with you directly are listed like any other; the zero-team Home (shared-projects list only) is unchanged. No backend change.
  - **A user without a team can use Home, Projects and Tasks; onboarding is only forced when they have no team and no shared project.** Landing, sign-in and the three pages used to send every user with an empty team list to `/onboarding`, so a user who only holds per-project shares (for example after accepting a project invite) could not leave it. They now go to `/onboarding` only when both the team list and the shared-project list are empty (`needsOnboarding`, `frontend/src/lib/access.ts`); either one alone sends them to `/home`. With no team, `/home` and `/projects` list the shared projects (each opens its board) with a "Create a team" action, without task widgets, project creation or GitHub sync; `/tasks` explains that cross-project tasks need a team and links to Projects. `/onboarding` still sends users with a team to `/home` and, for a team-less user with shared projects, adds a "Skip for now" link to `/home` next to the create-team form. If the shared-projects lookup fails, the user counts as having none (a failed team list still errors as before). No backend change; agent callers are unchanged.
  - **The Enterprise SSO page moved to `/settings/team/sso`; the old `/settings/sso` URL redirects.** The SSO settings page is now a sub-page of team settings: its breadcrumb reads "Team settings" and goes back to `/settings/team`, and its description links the token instructions to Team settings → API Tokens. `GET /settings/sso` and `GET /settings/sso?<query>` answer `307` with `Location: /settings/team/sso?<query>` (a `redirects()` rule in `next.config.mjs` next to the `/teams` one, query string preserved). Every in-app link follows through `ssoSettingsHref()`. The SSO unlock flow (paste an API token with the `sso:admin` scope) is unchanged.
  - **Accepting an invite now opens the project's board, not its Members page.** After a successful accept the invite landing page auto-redirects to `/projects/<id>/board` (via `boardHref`) and its "go now" link targets the same URL, so a project-only invitee who was previously parked on Members (a dead next click without a team) lands on the board directly. The sign-in redirect back to `/invite/<token>` and the `already_member` (409) screen with its "Back to home" link are unchanged.
  - **The Overview tab is dropped; `/projects/<id>` redirects to the board and project details moved to Settings > General.** The project hub's tab row now reads Board, Members, Workflow, Settings. The hub root redirects to `/projects/<id>/board` with the whole query forwarded (a `?taskId=` still opens the task modal), so any old link to the hub root lands on the board. The Overview page's details card becomes a "General" card at the top of the project Settings page (slug, GitHub repository link, created date; governance was already editable in the Governance card); its status-count row is removed as intentional duplication of what the board shows, and the "Open board", "Settings" and "Members & invites" quick-link buttons disappear with the page.
  - **The board moved to `/projects/<id>/board`, the first tab of the project hub; old `/dashboard` links redirect.** The board is loaded from the project in the URL, so a user who reaches a project only through a per-project share (no team) gets it too instead of being sent to `/onboarding`. `/dashboard?projectId=<id>` (letters, digits, `-` and `_` only) goes to that project's board and keeps `taskId` (the task modal still opens) and any other parameter except `teamId`; a bare `/dashboard` or `/dashboard?teamId=<id>` resumes the last board opened in this browser, or opens the Projects page when there is none. The project picker left the board title and now sits in the hub band's breadcrumb, the hub tab row now reads Board, Overview, Members, Workflow, Settings, and a project that is missing or not accessible (404/403) falls back to the Projects page and is forgotten as the last board, while any other load error (server error, network failure) keeps the user in place: the board shows its retry banner, and the other hub tabs show a project error with a Retry. Task breadcrumbs link the team to its Projects page and the project to its board.
  - **One header band for the project hub and the board, with a project picker.** The crumb now reads `Projects / <project name>` (it said "Dashboard" and linked to the board); the project name is a picker over the current team's projects, or over the projects shared with you when you have no team, and choosing one opens the same tab of that project. The board toolbar no longer repeats the project name and team in a second title row (the page has one H1), shows the task count next to the Board/List toggle, and drops the "Project settings" overflow menu, whose Workflow, Members and Settings links are tabs of the band. At 390 px the band wraps its chips and the tab row scrolls sideways instead of widening the page.
  - **The Projects page moved to `/projects`; the old `/teams` URL redirects.** The team's project list (project management, GitHub sync, `?teamId=<id>` to pre-select a team) now lives on the `/projects` route under its real name. `GET /teams` and `GET /teams?<query>` answer `307` with `Location: /projects?<query>` (a `redirects()` rule in `next.config.mjs`, query string preserved, e.g. `/teams?teamId=t1` -> `/projects?teamId=t1`); `/teams/tokens` keeps its own page. Every in-app link follows through `projectsHref()`; stored preferences (`agent-tasks:teams:viewMode`, `agent-tasks:lastTeamId`) are unchanged.
  - **GitHub and SSO logins land on `/home`.** The GitHub OAuth callback and the SSO callback redirected a fresh login to `/teams`; both now redirect to `/home`, matching email login. The GitHub connect branch (`/settings?github_connected=1`) and the `/auth/error` redirects are unchanged.
  - **`GET /api/projects` and `GET /api/projects/available` list shared projects for a human without a team.** A human with no team membership but one or more per-project grants (for example after accepting a project invite) got `400 no_teams`; they now get `200` with exactly the projects they hold a `ProjectMember` grant on, each marked `accessSource: "project"`, and none of any team's projects. A human with no team and no grant gets `200 {"projects": []}`. Unchanged: one team (that team plus shared), several teams without `teamId` (`400 multiple_teams`), an explicit `teamId` the human is not in (`403`), and every agent caller. `resolveTeamId` itself still answers `no_teams` for all other routes.
  - **A task opened from the `/tasks` list returns to that list.** The task page now reads a `from` parameter that the list puts on its row links (and on the new-task hand-off), so "Close", delete and a new first breadcrumb crumb "Tasks" lead back to the same filtered, sorted and paged view instead of the board. `from` is only honoured when it is `/tasks` or `/tasks?...` without `//`, backslash or control characters (`safeBackHref` in `lib/routes.ts`); anything else, a repeated `from`, or a direct visit keeps the board fallback and shows no "Tasks" crumb. The old bare list query on `/tasks/<id>` is no longer produced or read, and the board modal's "open as full page" link carries no `from`.
  - **"API token" naming and the Projects nav label.** The Settings token-section tooltips, the token modals and the SSO settings page (description and token field label) now say "API token" ("Create API Token", "Rename API Token", "Only team admins can generate/rename/revoke API tokens"), matching the **API Tokens** section heading; the header nav label **Teams** becomes **Projects**, and the "dashboard" wording in the `/tasks` create empty state, the `/tasks` boot-error button, the workflow editor's missing-project state and the dashboard's no-team state now says projects; those three buttons (the `/tasks` create empty state, the `/tasks` boot error and the workflow editor's missing-project state) now open the projects list instead of the board. README, getting-started and the SSO guide use the same noun. Routes are unchanged.
  - **Settings are split into personal settings and team settings.** `/settings` keeps the per-user sections (Account, Appearance, GitHub, Agent Permissions). API tokens (Connect an agent, create, rename, revoke) and the Enterprise SSO entry moved to the new `/settings/team`, which follows the shared current-team rule (`?teamId`, then the remembered team, then the first team). Old links keep working: `/settings#api-tokens` and `/settings#sso` are forwarded client-side to `/settings/team#api-tokens` and `/settings/team#sso`, and `/teams/tokens` redirects to `/settings/team`. The Connect an agent modal links to the new location. Token behaviour and admin gating are unchanged; a failed agent-permissions save is now reported in the Agent Permissions card instead of in the token section.
- **The confidence score is now the "Spec" score: named, explained, and no longer confusable with priority.** The badge reads `Spec 96, complete` instead of `96/100, ready`: a visible short name without the "/100", tier words `complete` (score >= project threshold), `partial`, `thin` (never low/medium/high, the priority words), and a tooltip (`title`, also the accessible description) saying "How complete the task spec is (0-100). Project threshold: N." when the caller knows the threshold, without the threshold sentence when it does not. Tiers are threshold-relative (thin below half the threshold; the global default 60 is the fallback), and the task page now shows a single 0-100 score: the client mirror of the server scorer, the value board cards and the sidebar use. The Improvement panel header reads "Template check" with its threshold verdict instead of a second number, Done-column board cards show no badge, and the sidebar confidence bar and number carry the same tier colour as the badge.
- **Docker smoke covers the backend and migrate images**: `docker-smoke.yml` gains a `backend-prod-images` job (`tools/backend-docker-smoke.sh`) that builds `Dockerfile.migrate` and the `prod` stage of `backend/Dockerfile`, runs db and migrate from `docker-compose.prod.yml` until migrate exits 0, then starts the backend and waits, bounded, for a database-backed `GET /api/health` and for the compose-declared healthcheck to turn healthy. A crash-looping container or a failing migrate fails the job with the service logs, and teardown always runs. The push and pull_request path filters now include `backend/Dockerfile`, `Dockerfile.migrate`, `backend/src/**`, `backend/tsconfig.json`, `backend/prisma/**` and the new script, so a change that breaks only the backend image no longer skips the smoke test. The workflow stays a non-required check. `tools/compose.smoke-override.yml` detaches the smoke backend from the shared `traefik` network as it already did for the frontend.
- **Frontend tests wait for the tab title instead of reading it right after other DOM.** `/tasks/[id]` set its title in a passive effect, so a test that awaited the task body and then read `document.title` could see the loading title under CI load (a red master run). `tests/unit/helpers/documentTitle.ts` adds `expectDocumentTitle` (retries until the title matches) and the frontend ESLint config flags a bare `expect(document.title)` under `tests/**` as an error (a read inside `waitFor` stays allowed); the test-only rule for mock call counts is written at the top of `frontend/tests/setup/vitest.setup.ts`. No product code changes.
- **The `/tasks` workflow-vocabulary test waits for the task request instead of reading the mock's calls right after render.** The first `getTeamTasks` call runs only after the session check and the shell's team list resolve, while the test's `renderAt` gate is the page heading, so under CI load the heading could appear before the request was recorded and an unguarded `.at(-1)` or `[0]` read of `getTeamTasks.mock.calls` crashed on undefined (a red master run). The reads that ran before the request was awaited (the very-first-request case, the All-tab case, and the custom-filter detection case) now assert inside `waitFor`; no behavior change.

## [0.32.0] - 2026-10-25

### Security

- **next 15.5.27** (GHSA-mcj8-r9mp-w47p, GHSA-4jqv-mc3x-m676): the lockfile resolves 15.5.27 with its matching `@next/env` and `@next/swc-*` packages and the `next` dependency floor is now `^15.5.27`.
- **next 15.5.28** (GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r): the lockfile resolves 15.5.28 with its matching `@next/env` and `@next/swc-*` packages and the `next` dependency floor is now `^15.5.28`, superseding the 15.5.27 entry above.
- **ip-address 10.7.4** (GHSA-rxp7-6hxx-x8q5): the lockfile resolves 10.7.4, which fixes quadratic-time matching of a zone identifier in `Address6`, so a long input string can no longer stall a process. It is installed through `express-rate-limit`.
- **body-parser 2.4.0** (GHSA-27r3-jxmh-p828): the lockfile resolves 2.4.0 (with content-type 2.1.0, iconv-lite 0.7.3 and qs 6.16.1, which it requires), so trailing bytes after a compressed request body no longer cause a denial of service.
- **fast-uri 3.1.9** (GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr, GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp): the lockfile resolves 3.1.9, which fixes scheme spoofing, host confusion, path equivalence and scheme injection in URI parsing. It is installed through `ajv`.
- **zod 3 -> 4** (GHSA-mrhx-c7xc-m3w5, vulnerable `<4.6.6`): `backend` and `mcp-server` now require `zod ^4.6.7` (the lockfile resolves 4.6.7, the fix is only in the v4 core), and `@hono/zod-validator` moves 0.4.3 to 0.9.1 (peers zod `^3.25 || ^4`, hono `>=4.11.2`; hono itself is unchanged). Every schema in `backend/src` uses the native v4 API, and all 35 request validators route through one shared wrapper (`backend/src/lib/z-validate.ts`) that builds its 400 through the Hono context, so headers set earlier in the request pipeline survive it, and keeps the base failed-validation wire body: `400 { success:false, error:{ issues, name } }` with top-level keys exactly `success`/`error` and `error` keys exactly `issues`/`name`, `issues` the zod 4 issue array (each keeps `code`, `path`, `message` plus zod 4's own per-issue fields such as `expected`/`values`), so clients reading `body.error.issues` (including `@agent-tasks/mcp-server`) are unaffected by zod 4 making `ZodError.issues` non-enumerable. The accept/reject sets of all request and env schemas are unchanged, except that integers above `Number.MAX_SAFE_INTEGER` are now rejected (including `PORT=Infinity`) and a `__proto__` key inside a record-shaped field (for example `taskTypeThresholds`) is now ignored instead of rejected. The 400 body keeps its shape, but the issues themselves follow zod 4: codes such as `invalid_string` become `invalid_format` and `invalid_enum_value` becomes `invalid_value` (the allowed values move from `options` to `values`), `received` is gone from the issues, messages are reworded, and an unknown `taskTypeThresholds` key now reports the code `unrecognized_keys`. The format fields go through one helper pair per package (`backend/src/lib/zod-formats.ts`, `mcp-server/src/zod-formats.ts`): `isoDatetime()` (the union of `z.iso.datetime()` and `z.iso.datetime({ precision: -1 })`) and `urlString()` (a `URL.canParse` refine that returns the value unchanged) reproduce zod 3's `.datetime()` and `.url()` accept/reject sets and outputs exactly, and `z.guid()`/`z.email()` reproduce the `.uuid()`/`.email()` sets. `@agent-tasks/mcp-server` reads both issue forms of an enum mismatch (`invalid_enum_value` with `options` and `invalid_value` with `values`), so release it together with or before the backend deploy: older mcp-server versions still get structured errors but lose the allowed-values hint on enum errors against the new backend. On `tools/list`, the JSON Schema of the `prUrl` fields (`task_finish`, `tasks_update`) and the `url` field (`task_artifact_create`) drops `format: "uri"` (the nullable `tasks_update` `prUrl` collapses from an `anyOf` pair to `type: ["string", "null"]`), and the `dueAt` fields (`task_create`, `tasks_create`) are now published as an `anyOf` of the seconds and minute patterns (`format: "date-time"` inside the first branch).
- Rejections are pinned to stable codes and messages: a value the `isoDatetime()` union rejects reports code `invalid_union` with message `Invalid datetime` (the zod 3 `.datetime()` gave a single `invalid_string` with that message for a malformed string and `invalid_type` for a non-string), and a string the `urlString()` helper rejects reports code `custom` with message `Invalid url` (a non-string still reports `invalid_type`).
- The backend's own MCP endpoint (`POST /api/mcp`) publishes its `tools/list` through the same SDK zod-to-JSON-Schema converter classes as `@agent-tasks/mcp-server`, so its schemas shift the same way: `additionalProperties: false` is no longer emitted for ordinary input objects (unknown keys are still stripped at runtime, and explicitly strict sub-objects keep the keyword), a `uuid` field gains a `pattern` next to `format: "uuid"`, integer fields gain `maximum`, record fields gain `propertyNames`, one `$ref` is inlined, `format: "uri"` is dropped on the `prUrl` fields (the nullable one becomes `type: ["string", "null"]`), and `dueAt` is published as an `anyOf` of the seconds and minute forms.

### Added

- `templateData` spec fields (`goal`, `acceptanceCriteria`, `context`, `constraints`, `scope`, `outOfScope`, `dependencies`, `risk`, `agentPrompt`) accept a list of strings as well as a string on task create, respec and PATCH. A list is stored as one `- item` line per entry (blank entries dropped), so it scores exactly like the equivalent bullet string; the 50,000-character cap applies to the stored text. Tracker task 8908e2a2.
- The task payload carries a server-computed `inReviewState` boolean on the single-task routes the task view reads (`GET /tasks/:id` and the `start`, `claim`, `release`, `admin-release`, `admin-reassign`, `transition`, `review` and `PATCH` responses). It is derived from the task's own effective workflow (pinned `workflowId`, else the project default, else the built-in one) with the same review-state predicate the release and transition gates use (`isTaskInReviewState`), so a task pinned to a non-default workflow is judged correctly. The task view's `Release` button now reads this flag instead of the project's workflow, which removes the frontend `isReviewState` copy, its cross-package parity test and the per-page effective-workflow fetch for non-admins. The flag and the release, abandon and transition gates resolve the workflow through the same `resolveEffectiveDefinition`, so they agree for pinned tasks (see Fixed). List payloads do not carry the flag. Tracker task 1d3fe7c6.

- Task view: project admins can hand a work or review claim to another actor from the sidebar. A `Reassign` control next to the admin release (on the work claim and on the review claim) loads `GET /projects/:id/eligible-actors`, offers every eligible human and agent except the current holder and calls `POST /tasks/:id/admin-reassign`; a 403, 409 or 400 is shown with the server's message. It is hidden, not disabled, for non-admins, without a signed-in human user and on a finished task. Tracker task 7fc13bcc.

- Project admins can hand a work or review claim to a specific actor: `POST /tasks/:id/admin-reassign` (body `{ claim, target: { type, id }, reason? }`, response `{ task, reassigned }`, audited as `task.claim_reassigned`) is a sibling of `admin-release`, which is unchanged. It is human-project-admin-only, runs inside the grounding wrapper and compare-and-swaps on the holder it observed, answers `409 merge_in_progress` while a merge holds the task, answers `409` for a claim with no holder or a target that already holds it, enforces the agent single-active-claim rule (`409 already_claimed`, humans exempt) and the distinct-reviewer rule in both directions (review claim to the work claimant, work claim to the review holder). New `GET /projects/:id/eligible-actors` (admin-only) lists the candidates: non-viewer project members and team members (`humans`) and the team's non-revoked, non-expired agent tokens (`agents`), which is also the set the reassign target is validated against. Tracker task 8296adcd.

- The `Audit` workflow gates high/critical advisories through `scripts/audit-gate.mjs` (vendored from depsight commit be8c7ea) with an ID-scoped, dated allowlist, `.github/audit-allowlist.json`: the one entry, GHSA-vfj7-8cjw-p6xm (braces 3.0.3, dev-only under the frontend workspace's eslint-config-next, no upstream fix), is excepted by exact advisory id until its `reviewBy` date (2026-11-06; an expired entry fails the gate, and a date more than 90 days out makes the allowlist malformed). Every other HIGH/CRITICAL advisory still fails the gate. `scripts/audit-gate.test.mjs` (`node --test`, no dependencies, fixture captured from this repo's own `npm audit --json`) runs as a step before the gate.

- The `Audit` gate is re-vendored from depsight #172: `scripts/audit-gate.mjs` now treats a report whose `metadata.vulnerabilities` HIGH plus CRITICAL tally disagrees with, or is missing against, its `vulnerabilities` map as UNCLASSIFIED (exit 3), prints npm's stderr itself through a sanitiser (each line behind an `npm stderr| ` prefix, reduced to a safe character set, length and count bounded) instead of the workflow step copying it raw, and the gate step fails (exit 3) when the classifier exits 0 without the `npm audit gate: CLEAN` line. The non-blocking report step prints npm's output between `::stop-commands::` and a per-run random resume token. The allowlist entries are unchanged. Tracker task dbbc4994.

- A persisted, leased merge reservation holds the distinct-reviewer gate across the GitHub merge (task eb08742f, closing the limitation listed under 0.31.0). `POST /tasks/:id/merge`, `POST /api/github/pull-requests/:prNumber/merge` and the autoMerge forms of `POST /tasks/:id/finish` take a reservation on the task (`tasks.mergeReservedByUserId`, `mergeReservedByAgentId`, `mergeReservedAt`, new nullable columns applied by `prisma db push` / `Dockerfile.migrate`) with one conditional write bound to the status, status version, work claim and review lock the gates decided from, at the last point before the GitHub call. A review lock released between the gate and the merge now refuses the merge (`409 conflict`, GitHub is never called) instead of letting it land. The write that records the merge clears the reservation, the end of the request releases whatever is left (a merge GitHub refused, a lost post-merge write; an unknown outcome or a thrown error keeps it until the lease lapses, see Fixed below), and a lease of 120 s with lazy expiry keeps a crashed handler from locking the task: a lapsed reservation counts as absent. The reservation timestamps are bound in UTC, so the lease does not depend on the database session's time zone.
- `409 merge_in_progress` (body `{ error, message, retryAfterSeconds }`, header `Retry-After`) on every claim and status writer while a reservation is live: `/start`, `/claim`, `/release`, `/abandon`, `/creator-abandon`, `/admin-release`, `/review/claim`, `/review/release`, `/review`, `/transition`, `PATCH` (status, demote, unabandon), every `/finish` write, project member removal (the whole removal is refused), `DELETE /tasks/:id` and the Grounding completion write (`{ error }` body). The refusal is the writer's own conditional write (the predicate is in its WHERE), not a read before it. A second merge of a reserved task answers it too. The GitHub webhook writers are not refused: they record a fact that already happened on GitHub. `backend/tests/unit/task-write-sites-merge-reservation.test.ts` keeps the list of task write sites closed.
- The OpenAPI document describes `merge_in_progress` (`MergeInProgressResponse`) on the documented claim and status writers, and `@agent-tasks/mcp-server` maps it to a teaching error that points at `tasks_get` (see its own changelog).
- `GET /projects/:projectId/audit` takes an optional `actionPrefix` query parameter (1 to 100 characters from `A-Z a-z 0-9 . _ : -`, matched literally) that keeps only rows whose `action` starts with it; a malformed value answers `400 bad_request`.
- The CLI `tasks claim` command gains `--force-reason <text>` (at least 10 characters, required with `--force`, checked before any request). Without it `--force` could never succeed under confidence enforcement mode BLOCK.
- The Jira import tool sends `backlog` for every issue when the agent-tasks token is an agent token (`at_...`), so an agent-token import is no longer rejected with `400 backlog_routing_enforced`; human tokens keep the status category map.
- `make db-push` and the backend dev script (`make dev`, `make dev-backend`) load the root `.env` (shell variables still win), so the host quick start no longer needs `set -a; . ./.env; set +a`. The dev script uses `--env-file-if-exists`, so the root `engines.node` is now `>=22.9`.
- `docker-compose.prod.yml` forwards `ANTHROPIC_API_KEY`, `AGENT_TASKS_REWRITE_MODEL`, `WEBHOOK_ALLOWED_PRIVATE_HOSTS`, `ATTACHMENT_MAX_COUNT_PER_TASK`, `ATTACHMENT_MAX_TOTAL_BYTES_PER_TASK`, `ARTIFACT_MAX_COUNT_PER_TASK`, `ARTIFACT_MAX_TOTAL_BYTES_PER_TASK` and `AGENT_TASKS_DISABLE_GROUNDING` to the backend with empty defaults (empty behaves like unset). Check the production environment on the next deploy.
- `docker-compose.prod.yml` also forwards `SSO_ENCRYPTION_KEY`, `BACKEND_URL`, `IDEMPOTENCY_TTL_DAYS` and `REDIS_URL` (empty behaves like unset; the backend config now treats an empty `BACKEND_URL`, `REDIS_URL` or `IDEMPOTENCY_TTL_DAYS` as absent instead of failing validation). The backend service gets a healthcheck on `/api/health`, so Traefik routes it only once it is healthy; `/api/health` answers 503 while the database is unreachable, so a longer database outage takes the API route out until the next successful probe. Every production service gets json-file log rotation (10 MB x 3), and the public host name is configurable through `APP_DOMAIN` (default unchanged).
- Both compose files set an explicit project name: `agent-tasks` for `docker-compose.prod.yml` (the name a checkout directory called `agent-tasks` already produced) and `agent-tasks-dev` for `docker-compose.yml`. Before the next production deploy, check with `docker volume ls` that the production volumes are named `agent-tasks_agent_tasks_postgres` and `agent-tasks_agent_tasks_uploads`; if the checkout directory has another name, the volumes carry that prefix and the deploy would start with new, empty ones. Existing dev volumes keep their old project prefix and are not picked up by the dev stack: re-seed, or remove them with `docker compose -p <old-project> down -v`.
- The dev stack and `.env.example` default `TRUSTED_PROXY_HOPS` to `0`, since no reverse proxy sits in front of the dev backend; a `.env` that still sets `1` keeps it. Production keeps `1`.

### Fixed

- The debug-grounding finish gate (`requireGroundingForDebug: true`) no longer requires a session phase. Nothing in the backend, the MCP server or the CLI advances the persisted session phase, which stays at `scope-resolution`, so the old phase requirement made `POST /tasks/:id/finish` answer `409 grounding_required` for every debug-flavored task on an opted-in project. The gate now requires a `groundingSessionId` on the task and at least one evidence-ledger entry for it. The 409 body drops `claimEvaluationPhase` from `missing` and no longer carries `currentPhase`; `missing` holds `sessionStarted` and/or `ledgerEntries`, and the `message` names the missing session or the missing ledger evidence. The ledger is counted under the backend-minted `groundingSessionId`, while an agent usually files evidence under its own local session id, so `ledgerEntries` can still block until the two ids are bridged (see ADR 0013). `evaluateGroundingGate` takes an optional `requireClaimEvaluationPhase` flag (default `true`); the legacy-cohort completion and migration paths keep the phase check. The unused `getSessionPhase` helper is removed.
- `GET /projects/:projectId/audit` and `GET /projects/:projectId/audit/github-delegation` now reject malformed `limit` and `offset` query parameters with `400 bad_request` instead of letting them reach Prisma: a present value must be a string of decimal digits (empty, negative, fractional, exponent and non-numeric values are refused, and an `offset` above 2147483647, the largest 32-bit integer), an absent parameter keeps its default (limit 50, offset 0) and a valid `limit` stays capped at 200. Project access is still checked first, so an unauthorised caller keeps getting 403 whatever the query string.
- The frontend's fonts are vendored and self-hosted instead of fetched from the Google Fonts CDN at build time, so a Google outage can no longer fail a build or a deploy. `frontend/src/app/layout.tsx` loads Inter and JetBrains Mono through the local `next/font` loader from woff2 files in `frontend/src/fonts` (the variable-weight subset files of `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` 5.3.0 with their OFL licenses; one call per subset sharing one `font-family` per family, so the browser still selects the face by `unicode-range` and only latin is preloaded; see that directory's README). The `--font-inter` and `--font-jetbrains-mono` CSS variables are unchanged. The CI Frontend job gained a step that fails when a source file under `frontend/` imports the Google Fonts module again (the grep exit code is checked explicitly so the guard fails closed, not open).
- `POST /tasks/:id/abandon` now answers with the server-computed `inReviewState`, like `/release` and the other single-task routes, so API and MCP callers (`task_abandon` with `include: ["task"]`) get the same flag after an abandon. A new Postgres-backed integration test (`backend/tests/integration/pinned-workflow-claim-release.test.ts`) pins a task to a non-default workflow and asserts the `/release` and `/abandon` outcomes (409 in the pinned review state, 200 and the reset to the pinned initial state otherwise) against the real Prisma query, so a task load that dropped the pinned workflow would fail it. Tracker task 31faaf27.
- `resolveEffectiveDefinition` now loads the pinned workflow row itself when the task was fetched without the `workflow` relation (`task.workflow` undefined); it used to fall back to the project default silently. `POST /tasks/:id/release` and `POST /tasks/:id/abandon` load the task without the relation, so for a task pinned to a non-default workflow they judged the review state, and `release` chose the initial state to reset to, on the project default instead of the pinned workflow: a pinned task in its own review state could be released (200), and a pinned task in a state that is review-like only under the project default was refused (409). Both routes, the comment route's clarification check and the `inReviewState` flag now resolve the pinned workflow; a pinned workflow whose row is gone (relation loaded as `null`) still falls back to the project default. Tracker task 1d3fe7c6.
- `POST /tasks/pickup` (the MCP `task_pickup` verb) no longer offers an open task whose review lock the caller holds when the project requires a distinct reviewer: `task_start` answers `409` for that caller, so the agent looped pickup -> 409. The work pool uses the same predicate as `/claim` and `/start`; other callers, solo or opted-out projects and `GET /tasks/claimable` are unchanged. Tracker task 164f715c.
- Task view: the self-service `Release` button on your own claim is shown disabled with a reason while the task is in a review state of its effective workflow, instead of failing with `409 bad_state` on click. The disabled state follows the server-computed `inReviewState` flag on the task payload, which uses the same review-state predicate and effective-workflow resolution as the route, so a custom workflow's review-like state is covered (the first version judged it in the frontend from the project workflow; tracker task 1d3fe7c6 replaced that). Tracker task a534d590.
- `POST /tasks/:id/start` (the MCP `task_start` verb) no longer hands the work claim to the review holder. A task can sit in the initial state with no work claim and the review lock still set (the earlier self-service `/release` of a task in review left rows like that, and `admin-reassign` can too), and the work branch of `/start` claimed such a task for the review holder, who ended with both claims. Under a project that requires a distinct reviewer the route now answers `409 { error: "bad_state" }` ("You hold this task's review claim ...", the text `/claim` uses) to the actor that holds the review claim, human or agent, on the pre-lock read ahead of the dependency, confidence and transition-rule gates (so a refusal emits none of their audit events), and repeats the check in the locked revalidate for a review claim that lands between the read and the lock; a solo or opted-out project still allows it. The pre-lock project read now includes `governanceMode`, like `/claim`, so the pre-lock and in-lock checks use the same mode; the review-claim branch of `/start` reads the same select, so its pre-lock distinct-reviewer check now also follows `governanceMode` when it disagrees with the legacy `requireDistinctReviewer`/`soloMode` flags. Tracker task 0b045884.
- `POST /tasks/:id/release` no longer resets a task in review to the initial state with the review lock still set. The self-service release cleared the work claim and wrote the status back to `open` without touching `reviewClaimedBy*`, while `POST /tasks/:id/abandon` already refused to release a work claim in a review state; the stale lock was the enabling cause of the both-claims paths through `/claim` and `/start`. The route now answers `409 bad_state` ("Cannot release a work claim while the task is in review. Wait for the reviewer to approve or request changes.") for a task in any review state of the effective workflow, and leaves the task, the work claim and the review lock unchanged. Unlike `/abandon`, which lets an actor that holds both the work and the review claim drop them, `/release` refuses unconditionally; a caller that also holds the review lock gets a message pointing at `/abandon` (`task_abandon`) instead. It was chosen over clearing the lock atomically with the reset because that would drop the reviewer's lock under them and still send a reviewed task back to the initial state without a verdict. A work holder in a work state (`in_progress`) releases as before. Behaviour change for callers: the task view's `Release` button, the `tasks_release` MCP tool and the deprecated CLI `tasks release` now get the `409` on a task in review (a project admin can still force it with `admin-release`, which is unchanged). The OpenAPI description of the route names the new `409`. Tracker task 8e833e58.
- Task view: the sidebar no longer shows a Claim button on an unassigned task outside the initial state. `POST /tasks/:id/claim` refuses every such state with `409 bad_state`, so the button could never succeed; the header Start button remains the way to claim and start an open task. Tracker task ee4d39aa.
- `POST /tasks/:id/claim` no longer hands the work claim to the review holder of a task in review. After an admin release frees the work claim of a task in review, the status stays `review`; the route accepted any unclaimed row, wrote the status back to `in_progress` (skipping review) and left the review holder with both claims. The route now answers `409 bad_state` before the confidence and transition gates run (so a refusal emits none of their audit events) when the task is not in the workflow's initial state (the rule `POST /tasks/:id/start` applies; the message names the current status and the initial state) and when the project requires a distinct reviewer and the caller holds the review claim (the claim-time distinct-reviewer gate with the review holder as the stand-in claimant, shared with admin reassign). The identity rule is repeated under the project lock for a review claim that lands between the read and the lock. Behaviour change for custom workflows: an unclaimed task in a non-initial state that has an edge into the start target (for example a `blocked` task with a `blocked -> in_progress` edge) can no longer be claimed through `/claim`; move such a task back to the initial state first through a workflow edge into it (the human status write on `PATCH /tasks/:id` or `POST /tasks/:id/transition`; `force` does not add a missing edge, so a workflow without a path back to the initial state needs that edge added in the workflow editor first) and claim it from there; admin reassign does not apply, it needs an existing work claim to move. Tracker task da6e6e67.
- The two routes that grant a review claim, `POST /tasks/:id/review/claim` and `POST /tasks/:id/start` on a task in review (the MCP `task_start` verb), re-check the distinct-reviewer gate inside their locked revalidate (task 7fc13bcc, follow-up to 8296adcd). The gate ran on the route's pre-lock read only, so an admin reassign of the work claim to the same actor that committed between that read and the lock left the actor holding both claims (approval stayed blocked by `review_lock_held_by_claimant`). Both routes now answer `409` in that case; a reassign and a review claim racing on one actor produce exactly one `409` whichever commits first, pinned for both routes against Postgres in `backend/tests/integration/admin-reassign.test.ts`.
- The task search (`?q=` on the team task listing in `backend/src/routes/tasks.ts`) now matches `%` and `_` in the query literally. The `contains` clauses on `title`, `description` and `externalRef` passed the query to Prisma unescaped, and Prisma passes `contains` through to SQL LIKE unescaped, so they acted as wildcards: a search for `50%` also matched `500` and a search for `a_b` also matched `axb`. The escape helper `escapeLikePattern` (already used there for the audit `actionPrefix` filter) is shared from `backend/src/lib/like-pattern.ts` (moved out of `backend/src/services/audit.ts`) and now escapes all three clauses. `backend/tests/integration/task-search-like-escape.test.ts` pins the behaviour against a real database.
- The /home Priority widget and its badge count no longer include abandoned tasks: both now count only HIGH and CRITICAL tasks whose status is open, in_progress or review, the same set the linked `/tasks?scope=priority` list already used (frontend `isPriorityTask`, backend `counts.priority`).
- A GitHub 5xx answer to the merge PUT (a 502 or 504 from a gateway in front of GitHub) is now an unknown outcome like a thrown or timed-out fetch (task 7f0a62f5, closing the residual of 06b06931): `performPrMerge` marks it `outcomeUnknown` and keeps GitHub's status, and all five merge paths (`POST /tasks/:id/merge`, the three autoMerge forms of `POST /tasks/:id/finish`, `POST /api/github/pull-requests/:prNumber/merge`) keep the reservation until its lease lapses instead of releasing it, because the merge may still land. A 4xx answer (for example 405, 409, 422) stays a definite refusal that releases the reservation. The lapse clause of `noLiveMergeReservation` (a lease exactly one TTL old has lapsed) is now pinned against real rows.
- The merge reservation (task 06b06931, follow-up to eb08742f): the GitHub merge PUT now carries `AbortSignal.timeout(45 s)`, below the 120 s lease, so the client stops waiting before the reservation lapses (a merge GitHub still completes after a timeout is unknown to the request; the reservation is kept until its lease lapses and the PR-merge webhook records the merge). A fetch that threw, was reset or timed out (`performPrMerge` answers `502 github_error` with `outcomeUnknown: true`) and a handler that throws after taking the reservation no longer release it at request end: GitHub may still complete the merge, so the reservation lapses with its lease and keeps claim and status writers and other merges refused (`merge_in_progress`) meanwhile. A reservation write refused by the Grounding GitHub repository fence answers `409 grounding_github_fence_conflict` (nothing merged, GitHub not called) instead of 500. A merge refused with `merge_in_progress` now carries `retryAfterSeconds` and the `Retry-After` header on every merge path. Residual (closed by the 7f0a62f5 entry above): a GitHub 5xx answer to the merge PUT was still treated as a refusal and released the reservation.
- A finished task no longer keeps a claim on the paths that end a task through the task and merge routes. These writes now clear the work claim and the review claim together with their timestamps: the legacy GitHub webhook writers (issue closed, PR merged), `POST /github/pull-requests/:prNumber/merge` and the `task_finish` autoMerge recovery write (which used to leave a review claim in place); the finish, approve and `task_merge` paths already did. Two writers still leave a claim on the finished task: the legacy `POST /tasks/:id/review` approve clears the review lock but keeps the work claim, and the Grounding GitHub webhook writes the terminal status without clearing any claim. The repair below is their backstop: the next deploy clears what they left. A claim left on a finished task was read as an active claim again as soon as the task's workflow stopped treating its status as terminal (a project switching to a workflow without `done`), and it blocked the holder's next `task_pickup` and `task_start` with `409 already_claimed`. Existing rows are repaired by `backend/prisma/clear-terminal-claims.sql`, which clears the claims of every task in a terminal state of its own workflow (pinned workflow, else the project default, else the built-in one). It is idempotent, skips with a notice a task a Grounding hold or an active repository fence refuses to write, and runs after the schema sync on every deploy: `Dockerfile.migrate` (the production one-shot `migrate` service) and `npm run db:push` execute it after `grounding-github-fence.sql`. No manual step is needed; the next deploy clears the leftovers. A project that holds more than one default workflow row is now read the same way by the app and by the repair: the oldest row wins, ties broken by id (the workflow lookups used to take whichever row the database returned first).

### Changed

- The merge gate's description (the `task_status_for_merge` entry of the effective-gates answer and the OpenAPI example) and the merge section of `docs/v2-api.md` and the review-deploy sequence diagram name the status rule per route: `pull_requests_merge` accepts a review state or terminal state of the task's workflow (`review` / `done` in the default workflow), `task_merge` still accepts the literal `review` / `done`. Text only; the `Cannot merge: ... expected 'review' or 'done'` rejection message is unchanged. Test: the task search integration test also covers a backslash in the query and a case-insensitive escaped query.
- The merge status gate and the legacy GitHub webhook handlers read review and terminal semantics from the task's effective workflow definition (task-pinned, else project default, else built-in) instead of the literal statuses `review` and `done`. `POST /github/pull-requests/:n/merge` accepts a task in a review-like or terminal state of its workflow, runs the distinct-reviewer gate for every review-like state (so a custom review-like state cannot skip it), and writes the workflow's terminal state after the merge; `checkTaskStatusForMerge` takes the definition as an optional second argument. The webhook's issue-closed, PR-merged (`pickMergeTargetStatus`, optional `definition`) and `changes_requested` decisions pick their targets from the same definition, and their audit payloads report the states actually written. Behaviour for the built-in four-state workflow and for every shipped template is unchanged (a test pins that both accept exactly `review` and `done`). A custom four-state workflow with free edges can behave differently, because a state counts as review-like only if it is neither initial nor terminal, has an edge to a terminal state and is not a direct target of the initial state: where `review` is a direct target of `open` (an `open -> review` edge) or has no edge to a terminal state, the merge route refuses a `review` task, the webhook no longer hands a task over to `review` and `changes_requested` no longer moves it back; where `in_progress` has an edge to a terminal state and `open -> in_progress` is absent, `in_progress` counts as review-like and passes the merge status gate. The built-in workflow and the shipped templates are not of that shape. The workflow API still accepts only the four built-in state names, so the state-name lock stands; the webhook's task lookups now skip the terminal states of each task's own workflow and `backlog` (see the next entry).
- `task_pickup`'s review pool, the single-active-claim check (`task_pickup`, `task_start` and `admin-reassign` of an agent target) and the GitHub webhook lookups (`findTasksByPr` and the issue-closed lookup) read the review-like and terminal states from each task's own effective workflow instead of the literals `review` and `done`. The filters are built per workflow, so a state name that is terminal in one workflow and open in another is judged by each task's own workflow; `backlog` stays excluded from the webhook lookups. Behaviour with the built-in workflow is unchanged. A project with a custom workflow now has its review-like state picked up by reviewers, its terminal state frees an agent's claim, and its terminal state keeps webhooks from re-moving a finished task. The review pickup and the review-claim check use the same review-like predicate as the merge gate, so a workflow with the four built-in names and free edges can behave differently from before: where `review` is a direct target of the initial state (an `open -> review` edge) or has no edge to a terminal state, `review` tasks are no longer offered by `task_pickup` and a review claim on one no longer counts as an active claim; where `in_progress` has an edge to a terminal state and `open -> in_progress` is absent, `in_progress` counts as review-like, so reviewers are offered `in_progress` tasks and a review claim on one counts. The built-in workflow and the shipped templates are not of that shape. A stored workflow definition that cannot be read is judged by the built-in definition's states in these filters, per kind of state: when the stored `states` are not a list, both the terminal states (`done`) and the review-like states (`review`) fall back to the built-in ones; when the `states` are a list but the `transitions` are not, the stored terminal states are kept and only the review-like states fall back to `review`, because they cannot be derived without the transitions. A project with such a definition keeps the claim, pickup and webhook behaviour it had with the literal names.
- The `reason` of a `task.merged_status_conflict` audit event can now be `merge_in_progress` (the status is as it was read and another merge holds the task); the response message says so and that retrying is safe.
- `performPrMerge` takes an optional `beforeGithubMerge` hook that runs after every refusal that needs no GitHub call and right before the fetch; the merge paths take their reservation in it, so a merge that is refused earlier never touches the task row. Taking and releasing a reservation do not change `updatedAt`.
- Error texts and descriptions now match backend behavior: `POST /tasks/:id/creator-abandon` answers `Task must be open or backlog and unclaimed to creator-abandon` (backlog tasks were already accepted), the force-transition 403 reads `Only team admins and project admins can force a transition`, the MCP `task_finish`, `task_creator_abandon`, `task_create` and `task_submit_pr` tool descriptions and the workflow primer's error list describe the real conditions, the OpenAPI document states that it covers a subset of the routes, and the confidence gate is described as running on `task_start` and `/claim` only. `@agent-tasks/mcp-server` matches the new texts by prefix and still maps the older ones.
- The CLI `tasks finish --auto-merge` and `tasks respec` help texts and the Connect Agent modal CLI snippet are corrected: the snippet builds the CLI from a checkout instead of `npx -y @agent-tasks/cli`, which is not on npm.
- The remaining engine paths that compared a task's status with the literals `review` and `done` read the review-like and terminal states of the task's own effective workflow (pinned workflow, else project default, else built-in). Behaviour with the built-in workflow and the shipped templates is unchanged, apart from the claim clearing above. The paths: the signal staleness check of `task_pickup` and the dependency gate of `task_pickup`, `task_start` and `POST /tasks/:id/claim` (a blocker is resolved when it is abandoned or in a terminal state of its own workflow, judged per blocker, so a blocker in `shipped` resolves its dependents and one in a state named `done` that is not terminal in its workflow does not); `task_merge` (it now applies the same status rule as `pull_requests_merge`, runs the distinct-reviewer gate for every review-like state and writes the terminal state its workflow reaches from the current one); `task_finish` (the approve target fallback, the autoMerge target, the autoMerge replay and recovery checks, and the edge looked up for the `prMerged` post-check); the legacy `POST /tasks/:id/review` and `/review/claim` routes; the distinct-reviewer gate and the review signal of `PATCH /tasks/:id` and `POST /tasks/:id/transition`; the next-action hints of `GET /tasks/:id/instructions`; the `done`, `doneRecent`, `doneOlder` and `mine` counters of `GET /teams/:teamId/tasks`; the claims released by project member removal; and the Grounding review-state checks of the standalone task merge and the direct review route. The rejection text of the merge status gate names the review and terminal states of the task's workflow (for the built-in workflow it is unchanged word for word). The `review` bucket, the `open` bucket and the priority count of `GET /teams/:teamId/tasks`, the status vocabulary of the list filters and the PATCH body, and the initial-state literal `open` of the pickup pool are unchanged: they belong to the state-name lock of the workflow API, which this change does not lift. The configured Grounding GitHub webhook service keeps its own observation rules.

### Removed

- The `task_assigned` signal type (declared and filtered, never created) and the unused `evaluateWebhookPolicy` service with its unit test.

## [0.31.0] - 2026-10-05

### Added

- The backend-hosted MCP `tasks_list` tool (`backend/src/routes/mcp.ts`) takes `cursor` and `sort` (`createdAt:asc|desc`) and forwards them to `GET /api/tasks/claimable` (task faba28af), so its callers can page with `nextCursor` like callers of the standalone MCP server's `tasks_list` instead of only raising `limit`. An omitted `sort` keeps the route default (oldest first); the tool description no longer says it takes no cursor.
- Both `tasks_list` tools (the backend-hosted one in `backend/src/routes/mcp.ts` and the standalone one in `mcp-server`) reject a `cursor` longer than 200 characters with a validation error instead of only being bounded by URL and transport limits (task 2bf1b70a). A cursor is a task id (36 characters), so no real cursor is affected. A test now pins that the hosted tool answers a cursor naming no task with an empty page, `nextCursor: null` and `truncated: false`.

### Fixed

- `GET /api/tasks/claimable` clamps an out-of-range `limit` instead of silently falling back to 25 (task dc44794b): above 200 becomes 200, below 1 (0, negative) becomes 1; an absent or non-numeric value still uses 25. The project task route keeps its own cap of 500 and its 400 for 0 or below, now documented as a deliberate difference in OpenAPI and `docs/v2-api.md`.
- `GET /api/tasks/claimable` (the route behind both MCP `tasks_list` tools) no longer hides that its page was capped (task 10e761e2). The 25-row cap is the route's own default page size (`limit` defaults to 25 when omitted; out-of-range values are clamped, see the dc44794b entry), not an MCP-layer limit. The route now fetches one row past `limit` and always returns `truncated` (true exactly when more rows exist after the page) next to `nextCursor`, which is now exact like the project task listing: a page that is exactly full with nothing after it returns `nextCursor: null` instead of the last row's id. Callers that follow `nextCursor` until `null` (the CLI id resolver) are unaffected; callers that relied on the old full-page heuristic get a more accurate stop. OpenAPI, `docs/v2-api.md` and the description of the backend-hosted `tasks_list` tool (`backend/src/routes/mcp.ts`) document the cap and the new fields.
- The remaining status writers compare the status version (task 21446d1a, follow-up of the status-version work). `POST /tasks/:id/start` (work claim), `POST /tasks/:id/claim`, `POST /tasks/:id/release`, `POST /tasks/:id/abandon` (when it holds a work claim), creator-abandon and the `PATCH` unabandon and demote add the status and status version they read to the WHERE of their write, so a status change or a status round trip between their read and write answers `409` instead of writing over the newer state; `/abandon` previously guarded only on the claim holder and could reset a task that had moved on to review. The `409` texts of `/start`, `/claim`, `/release` and `/abandon` now say the status may have changed as well as the claim.
- The legacy GitHub webhook writers (issue closed, PR merged, `changes_requested` review) write only while the task still has the status and status version they read. A write that lost re-reads the row and decides again (up to three attempts) instead of overwriting a concurrent change; for example a PR-merged event no longer moves a task that was approved to `done` in the meantime back to `review`. The audit event and the signal acknowledgement follow what was actually written.
- `POST /api/github/pull-requests/:prNumber/merge` (the route behind MCP `pull_requests_merge`) no longer writes `done` unconditionally after the GitHub merge. It uses the same post-merge compare-and-swap as `POST /tasks/:id/merge`: a task the PR-merge webhook already moved to `done` completes normally (`task.merge_webhook_first`), any other concurrent change answers `409 merged_but_status_changed` with the merge sha and a `task.merged_status_conflict` audit event, and nothing is overwritten. The OpenAPI entries of both merge routes and `docs/v2-api.md` now document that `409`.
- The `409` of creator-abandon, `PATCH` unabandon and `PATCH` demote that comes from a lost write now says the task may have changed before the request completed (the precondition text it carried before can still be true when only the status version moved).

### Known limitations

- The distinct-reviewer gate is still not held across the GitHub merge call of `/merge`, `POST /github/pull-requests/:prNumber/merge` and the autoMerge forms of `/finish`: a review lock released in that window lets the merge land and the task answers `409 merged_but_status_changed`. A reservation needs a schema change and is not part of this change.

## [0.30.0] - 2026-10-04

### Upgrade notes

- The schema step now also installs the grounding fence: `Dockerfile.migrate` and `npm run db:push --workspace=backend` run `prisma db execute --file backend/prisma/grounding-github-fence.sql` after `prisma db push`, which installs triggers on `tasks`, `projects` and the grounding tables on every install, whether or not grounding is configured. A custom migrate pipeline that runs only `prisma db push` must run that file too; a backend started with a configured grounding runtime refuses to start without the fence. Run the migrate step before starting the new backend (the production compose already orders it so).
- `GROUNDING_RUNTIME_CONFIG` stays empty unless grounding is enabled. A configured value is validated strictly at startup and an invalid or inconsistent one refuses startup; an empty value is refused as soon as any grounding history exists. See `docs/grounding-migration.md`.

- The post-merge write of `/merge` and the autoMerge forms of `/finish` (task d3f5266b) reports a lost race accurately and has a stated policy for a writer other than the PR-merge webhook. When the fresh-row retry loses as well, the row is read again before the `409 merged_but_status_changed` body and the `task.merged_status_conflict` audit event are built, so they no longer carry the stale `done`. The 409 message distinguishes "status changed to 'X'" (reconcile by hand) from "a claim moved, retrying the same request is safe", and the audit event gains `reason` (`status_changed` or `claim_moved`). When another writer (not necessarily the webhook) already set the target status, the completed write no longer overwrites that writer's `result`: it is written only while null (the write itself is conditional on `result` still being null, so a result stored just before the retry is not overwritten either), the approval signal then carries the stored result, and `task.merge_webhook_first` carries `priorStatus`, `priorStatusVersion` and `resultKept`. ADR 0010 has an addendum with the policy.
- On a provisioned-grounding project, an admin restore out of `abandoned` that the grounding service itself performs (a restore that races a concurrent abandon) now clears `finalDisposition` after the commit, like the REST restore. Tests also pin that grounded creator-abandon and admin restore write and clear it post-commit and fail-open. Responses are unchanged.
- The respec OpenAPI description and 409 message now reflect that unclaimed tasks in either `open` or `backlog` can be edited. In backlog, an agent with project access and `tasks:update` may respec regardless of creator; in open, the creator rule still applies unless `allowNonCreatorRespec` is enabled. Humans with project write access are not subject to the creator rule.

### Added

- A human with project write access can move an `open` task that holds no work or review claim back to `backlog` with `PATCH /api/tasks/:id { "status": "backlog" }`, the mirror of promote (task 7c64e80c). The write is a compare-and-swap inside the grounding route transaction (row lock, then an update guarded on status `open` and all four claim columns being null), so a `task_start` that claims in between makes the demote answer `409` instead of leaving a claimed backlog task. A task that holds a work or review claim answers `409`; backlog is reachable only by this demote, so a PATCH to `backlog` from any other source status answers `400`, also when the project stores an older workflow definition with an edge into `backlog` or an initial state of `backlog`; agents stay locked out of the `status` field. The action has its own audit event `task.backlog_demoted`, and the task's pending signals (chiefly `task_available`) are acknowledged so they stop waking agents. The UI offers it as "Move to backlog" on open rows of the `/tasks` table and in the task-detail header, disabled with a reason while a claim exists.
- The open to backlog demote also works for a grounding-enrolled task (task bf896c1d). The direct-route adapter applies the REST demote rules: an open, unclaimed task moves to `backlog` through the grounding dispose path with the audit event `task.backlog_demoted` and its pending signals acknowledged in the same transaction; a task that holds a work or review claim answers `409` with the same message as the REST route instead of a bare `bad_state`; any other source status answers `400`, and a status change that wins the race after the route read answers the same `409` message. Before this change the PATCH answered `409 bad_state` without a message and the UI showed "Request failed".
- `ConfidenceTelemetry` gains the additive, nullable `finalDisposition` column (`done` | `abandoned`, null = not terminal or reopened), so the M5 low-score-success and high-score-failure signal can see a non-done outcome. A terminal review-approve writes `done`; a successful `POST /api/tasks/:id/creator-abandon` writes `abandoned` (an existing row is updated; a new row is created only when the task had a gate-scored claim); an admin restore from `abandoned` to the initial state resets it to null and never creates a row. `task_abandon`, `POST /api/tasks/:id/release` and the backlog discard write nothing. The read side uses `finalDisposition ?? finalStatus` as the outcome, so `highScoreFailures` and `doneRateByScoreBand` are no longer structurally constant, and rows written before the column keep counting as done. All writes are post-commit and fail-open. The OpenAPI text drops the old "structurally 0 / 1.0" notes (task ef70cab1).
- `GET /api/projects/:id/telemetry/confidence` now aggregates the fourth M5 calibration signal as `clarificationByScoreBand` (`band`, `taskCount`, `avgClarificationCount`). A clarification is a comment posted through `POST /api/tasks/:id/comments` (`tasks_comment` / `task_note`) by an agent that holds the task's active work claim while the task is in a work state other than review (`in_progress` in the built-in and template workflows); human claim-holders, reviewers, comments in review and system comments do not count. The counter is the new additive `ConfidenceTelemetry.clarificationCount` column (default 0), incremented at comment time and fail-open: a telemetry error is logged and never changes the comment response (task 568d4d74).
- `PATCH /api/projects/:id` accepts `riskModifiers`, the write path for the M3 risk modifiers that were previously readable only (task 05b5eba8). The object takes any subset of `touchesAuth`, `touchesDatabase`, `touchesPersonalData` and `productionImpact`; each value is an integer 0-100 and the values may not sum to more than 100. An unknown key, a negative or non-integer value, a value above 100 or a sum above 100 returns `400` and writes nothing; `null` clears the stored value. A change is audited as `project.updated`. The OpenAPI document describes the field on the Project schema and the PATCH body.
- External grounding integration, opt-in through `GROUNDING_RUNTIME_CONFIG`: offline verification of grounding receipts against an explicit trust anchor and a pinned producer contract, persisted protected attempts and verified receipts, atomic completion with durable merge recovery, guards on direct task writers, indirect workflow and member writers and on GitHub merge and recovery operations, audited grounding migrations with full task holds and a read-only migration inventory, and an exposure of the grounding tools through the backend-hosted MCP route. See `docs/grounding-migration.md` and `docs/grounding-receipt-contract.md`.
- Humans with project write access can add and remove task labels in the task detail sidebar (#496).
- The project settings page in the frontend has a toggle for `allowNonCreatorRespec`, so an admin can enable respec by a non-creator without calling the API.
- Frontend backlog support: a backlog tile in the home stat strip and a backlog widget on the home page (one shared order for strip and widget grid), a task create modal that defaults to backlog. The board's five-column layout with controlled breakpoints and a scroll affordance in the 761-1279px band, and column create affordances only on backlog and open, are layout fixes to the 0.29.0 backlog board.

### Changed

- The publish workflow now installs npm with `npm install -g npm@^11.5.1` (the documented trusted-publishing floor) instead of the floating `npm@11`, and the publish step's two success-on-registry exits (the "already on the registry" idempotency check before the retry loop and the loop's "reached the registry despite a non-zero publish exit" branch) now probe `npm view <pkg>@<version> dist.attestations` and fail with an error when the attestation is empty (or when the probe itself fails), so a partially completed publish is no longer announced green. CI only; no package code change.

- `docker-compose.prod.yml` lets the backend connect as a separate runtime database role through the optional `POSTGRES_APP_USER` and `POSTGRES_APP_PASSWORD` variables, while `migrate` keeps the owner role. A role that is not a superuser and owns no table cannot disable the grounding fence and hold triggers; it can still write the fence and hold tables, so this does not guard against arbitrary SQL run as the backend. Set both variables or neither; unset, the backend connects as before; see "Runtime database role" in `docs/grounding-migration.md` for the grants.
- Enabled grounding configuration now enforces enrollment per scope instead of globally. A fresh remote operation (task merge, finish with `autoMerge`, GitHub PR merge) on an unprovisioned task returns `409 grounding_enrollment_required` from the router only when the task's own project is selected by `creationPolicy`; a PR create for such a task follows the grouped create contract. Outside that scope the request reaches the legacy handler untouched, with or without an operation key, and the legacy handler is functionally unchanged except for a target check at its effect boundary: `performPrMerge` (GitHub PR merge, task merge, and the review, self-approve and work finishes with `autoMerge`) checks the exact repository and PR number immediately before the GitHub merge call, and the legacy PR creator and PR commenter check the repository (and, for comments, the PR number) immediately before their POST. The check returns `409 grounding_enrollment_required` with `{error, message}` when that repository string is not exactly a canonical `owner/repo` identity (surrounding whitespace, a dot segment, a percent-encoded name, an owner containing `/`), belongs to a selected project, or when the PR is a protected, `EXTERNAL_V1`, bound or held task's (including such a task whose own repository string is not canonical and that shares the PR number), and `409 grounding_finalization_pending` for a merge or create when another operation owns the fence of the target repository or of any repository the legacy task write checks for the requesting task (its effective repository, its stored PR URL repository and the repositories its own active PR-create intents fence). A merge or create is also refused with `409 grounding_enrollment_required` when the requesting task is itself protected, `EXTERNAL_V1`, bound or held, whatever PR number it sends. Comments write no task and take no fence check; a create sends no PR number, so the peer check does not apply to it. A comment is refused on an enforced repository and on a peer's PR whoever sends it, including a task commenting on the PR it stores, since an agent can set a task's PR number and repository. As defense in depth, enforced repositories must still not run comment-triggered merge or deploy automation; direct GitHub access outside agent-tasks (tokens, the GitHub UI, other apps) is not governed by this check. With configuration enabled, the legacy merge, PR create and PR comment writes no longer follow a GitHub redirect: renamed or transferred repository writes are refused with `409 github_redirect_refused` and not re-sent to the redirect target, while the unconfigured application keeps following redirects. An unprovisioned task's PR create outside the scope reaches the legacy creator even when it carries a key, and a key with durable grounding create history (or any unfinished grouped create on the task) stays with the grouped create service.
- Enabled startup now refuses when a project outside the enforced scope shares a GitHub repository with a selected project, when a selected project's repository is not a canonical `owner/repo` identity, and, while the selected projects own a repository, when any project's repository is not canonical. Projects created or re-pointed after startup are not re-checked.
- A configured GitHub merge whose reservation fails after a concurrent same-key request already reserved and dispatched the operation now answers from that operation's durable history (`202` pending, or the replayed result) instead of `503 grounding_verification_unavailable`.
- `POST /api/github/pull-requests` (the legacy PR creator) now reads its operation key from the `Idempotency-Key` header as well as from the body `idempotencyKey`, in the same format. When both are present they must be equal; a mismatch or a malformed header returns `400 validation_error` before any GitHub call.
- Every Grounding router now checks the caller's access before it reads or locks any Grounding state and answers a caller without access the same way whatever the task's or project's Grounding state. The configured GitHub create and merge routes look up the task and check project access with the legacy handlers' own rule, so a missing task or a caller without access gets the legacy handler's own `404` or `403`. The grounding attempt routes (issue, direct issue, receipt) and the migration route check write access or the administrator role with a lock-free read before taking the task lock and repeat it under the lock. The creation router checks project access before it looks at the `creationPolicy` selection and answers a caller without access with the legacy creator's own validation and `403`, so whether a project is selected is not observable without access.
- Outside the enforced scope, the configured GitHub create and merge routes read only the task id and any well-formed key for the durable-history lookup before handing the request to the legacy handler unmodified, so key-format, strict-body and path checks of the Grounding contract do not apply there, and the router no longer predicts which repository or PR number the legacy handler will act on. A legacy gate that refuses first answers as in the unconfigured application. The principal differences from the unconfigured application are the effect-boundary refusals above, the refusal of renamed or transferred repository writes (`409 github_redirect_refused`), the router's refusal for an in-scope task, the agent-scope admission check that runs before routing, a transient `503 grounding_verification_unavailable` when the Serializable routing read cannot be serialized, and the retry message a Grounding-path `503` carries on the GitHub merge route. The boundary check is a point-in-time read one database round trip before the GitHub call, so two races remain accepted, narrowed to that window: a change that makes some task a protected, `EXTERNAL_V1` or held peer of the targeted PR after the read is not seen, and a grouped operation that acquires one of the checked fences (the target repository's or one of the requesting task's own repositories') after the read lets the legacy merge land on GitHub while its task write fails and the task stays in review, or leaves an unlinked PR after a legacy create. A change to the requesting task between routing and the legacy handler is checked, since the boundary reads the target actually sent. Before enabling configuration, check with read-only SQL that no project or deliverable repository fails `grounding_github_repo()` or differs from its `grounding_github_trim()` form, and that no GitHub pull-request URL fails `grounding_github_pr_repo()` (see `docs/grounding-migration.md`). Enabling configuration is one-way: an enabled runtime writes grounding history (webhook deliveries, for example), and unconfigured startup refuses that history. To roll back a first enabled deploy, keep an enabled configuration with an empty trust list and an empty `creationPolicy` instead of removing it; that configuration is not equivalent to the unconfigured application.
- Grouped GitHub merge discovery reads its protected, `EXTERNAL_V1`, bound and held peers from the enrollment and hold tables first and then the tasks by id, instead of scanning every task with a per-row repository function.
- Unconfigured (grounding-disabled) backend startup no longer refuses to start over unowned GitHub repository-fence rows. The repository-fence SQL trigger bumps such a row on any ordinary task write that carries a GitHub repo, whether or not grounding is ever configured, so that row alone was never grounding history. An owned fence, any fence-intent row whatever its state, and a row in any other grounding table still refuse unconfigured startup. Self-hosters who install without ever configuring `GROUNDING_RUNTIME_CONFIG` need no action.
- `GET /api/projects/:id/tasks` now fetches `limit + 1` rows so `nextCursor` is exactly `null` only when no rows remain after this page, instead of the previous `tasks.length === limit` heuristic (task e36696d7).
- Docs layout: the root `adr/` directory moved to `docs/adr/` (numbers unchanged) and `diagrams/` to `docs/diagrams/`. The two ADRs that already lived in `docs/adr/` were renumbered to avoid collisions: `0001-webhook-event-model` is now `0014-webhook-event-model`, `0002-grounding-finish-gate` is now `0013-grounding-finish-gate`.
- **Breaking**: the backend-hosted remote MCP route (`POST /api/mcp`) now always sends an operation/idempotency key on `task_finish`, `task_merge`, `task_abandon`, `pull_requests_create` and `pull_requests_merge`: the caller's explicit value when given, otherwise a fresh one generated per call. This mirrors the stdio `mcp-server` package (see its own changelog). The two PR tools send the key in both the `Idempotency-Key` header and the request body; the three task tools send it as the header. Key formats on this route are narrowed: `pull_requests_merge`'s `idempotencyKey` from any string, trimmed, 1-255 chars, to `/^[A-Za-z0-9._:-]{1,128}$/` (breaking); `pull_requests_create`'s `idempotencyKey` from any string, trimmed, 1-255 chars, to printable ASCII without whitespace, 1-255 chars (breaking). A generated key differs on every call, so it does not make a retry idempotent; a caller that wants an idempotent retry passes its own key on both calls. That reuse holds for the two PR tools on every backend: the legacy `/api/github/pull-requests*` routes dedupe on the body `idempotencyKey` (one `tool_invocations` row per successful call, pruned by the idempotency TTL sweep; a same-key retry replays the stored 2xx response with `_idempotent_replay: true`; the same key with a different payload returns `409`), and the Grounding GitHub router keys its durable operation on the same value. For `task_finish`, `task_merge` and `task_abandon` it holds only where the backend enforces operation keys (a provisioned task on a Grounding-configured backend); on an unconfigured backend, or for an unprovisioned task, the request either reaches the legacy `/api/tasks/:id/{finish,merge,abandon}` handler, which ignores the key, or, for a remote merge (`task_merge`, or `task_finish` with `autoMerge`) where grounding enforcement applies to the task, is refused with `409 grounding_enrollment_required` before any effect, so a retry there is not deduplicated. See `docs/okf/auth.md`.
- CI: `release.yml` now passes step values into `run:` scripts through `env:` and shell variables instead of interpolating `${{ }}` expressions into the script text. No behavior change for normal tags and versions.
- The `tasks` CLI now sends an `Idempotency-Key` on `tasks finish`, `tasks abandon`, `github pr create` and `github pr merge`; details in `cli/CHANGELOG.md`.

### Fixed

- A workflow definition stored before the state vocabulary was locked can no longer move a task into `backlog` (task ddb2417e). Such a definition (the retired coding-agent template: `initialState` `backlog`, edges such as `spec` to `backlog`) was read without validation, so `POST /api/tasks/:id/transition` along a stored edge into `backlog` answered `200`, and `/abandon`, `/release` and the grounding writers reset a task to the stored `initialState` `backlog`. Every read of a stored definition now drops edges into `backlog` and a `backlog` state, maps an `initialState` of `backlog` to `open` and, only in that case, remaps an edge out of `backlog` whose target is neither a terminal nor a review state (the legacy start edge, such as `backlog` to `spec`) to leave from `open`; every other edge out of `backlog` (such as `backlog` to `done` or to `review`), and every edge out of `backlog` in a definition whose stored `initialState` is not `backlog`, is dropped, so an open task can never reach a terminal or review state through a remapped edge; a definition that never mentions `backlog` is used exactly as stored, and the stored row is not rewritten (a warning is logged when a read had to sanitize). A task still enters `backlog` only at creation or by demote and leaves it only by promote or discard. For a project that still stores the retired coding-agent template, the start edge `backlog` to `spec` now leaves from `open`: `task_start` on an open task (created, released or abandoned) moves it into `spec`, released and abandoned tasks restart from `open` instead of `backlog`, the edge `spec` to `backlog` and other edges into `backlog` no longer exist, and a task that already sits in `backlog` leaves it only through promote or discard. On a grounding-enrolled task the remapped start edge also works on the direct `/transition` and `PATCH` paths, with its stored gates. Operators can count affected projects with the read-only query in the pull request description.
- `PATCH /api/tasks/:id` with a `status` and `POST /api/tasks/:id/transition` now write only while the task still has the status the handler validated: the write is a compare-and-swap on that status, and a request that lost the race answers `409` and leaves the row unchanged, with no audit event, signal acknowledgement or workflow signal (task e4e27a39). Before, a request that read `open` before a concurrent demote committed could still write `in_progress` over `backlog` with no claim. The same applies to promote, discard and a PATCH that echoes the current status. Non-racing requests answer as before.
- The status writes the generic compare-and-swap left open are closed (task f1c8c7c1). The compare-and-swap of `PATCH /api/tasks/:id` with a `status` and `POST /api/tasks/:id/transition` now also matches the status version and the work claim and review lock the handler read, so a review lock released (or handed to the claimant) between the distinct-reviewer check and the write can no longer let a non-claimant's `review` to `done` through (it answers `409` and writes nothing), and a round trip back to the same status (`review` to `in_progress` to `review`) between the read and the write is rejected instead of passing as unchanged. `POST /api/tasks/:id/finish` (review-finish, self-approve, the autoMerge recovery and work-finish writes), `POST /api/tasks/:id/merge` and `POST /api/tasks/:id/review` used a plain update with no check on what they read; they now write through the same compare-and-swap and answer the same `409` when they lose. `/merge` and the autoMerge forms of `/finish` (Mode A, Mode B, self-approve, and the autoMerge recovery write) write after the PR is already merged on GitHub, and the system's own PR-merge webhook can move the task to `done` in that window; a lost write there no longer answers `409` after an irreversible merge: it re-reads the row and, when the task already has the status being written, completes the write against it (claims cleared, merge sha and result stored, the normal audit events, plus a `task.merge_webhook_first` event) and answers the normal success. Any other change in that window answers `409` with the error code `merged_but_status_changed` (the response carries `mergeSha` and `currentStatus`), writes nothing and records a `task.merged_status_conflict` audit event with the merge sha so an operator can reconcile. `POST /api/tasks/:id/review` now stores its review comment in the same transaction as the guarded write, so a lost race leaves no stale `[Approved]` note on the timeline. Non-racing requests answer as before.
- The additive `Task.statusVersion` integer column (default 0) counts status writes: every write that sets `status` (the routes above, `/start`, `/claim`, `/release`, `/abandon`, `/creator-abandon`, unabandon, demote, the GitHub webhook and merge handlers, the grounding completion write and the Grounding webhook observation writer) adds one, and the compare-and-swap compares it. Existing rows start at 0; `prisma db push` adds the column with its default, no backfill.
- A grounded merge (task merge, GitHub PR merge, finish with `autoMerge`) of a task whose protected binding is `TASK_SPEC` no longer always fails with `409 grounding_receipt_mismatch`. A `TASK_SPEC` receipt attests the task specification and signs no code head, so the reservation now skips the signed-head comparison only when both the binding and the signed context are `TASK_SPEC` and the signed head is null. The PR head observed at reservation is still recorded and sent to GitHub as the expected `sha`, and dispatch re-reads the head, so a head change between reservation and merge fails instead of merging different code. `CODE_HEAD` receipts keep the exact head comparison.
- Grounded merge, finish and merge-recovery checks now compare a task's stored PR URL with its effective repository and PR number canonically, and the required-CI gate compares it with the project repository and PR number the same way: owner and repository case-insensitively, scheme, host, path shape and PR number exactly; a repository name with surrounding whitespace never matches. The grounded PR create route stores the lowercased URL, so a project with a mixed-case repository name previously could not complete a grounded merge of a PR created through that route.
- `pull_requests_create` now reconciles an existing PR for the requested head
  before one bounded retry after a transient GitHub 5xx or GraphQL failure,
  preventing an ambiguous upstream write from being duplicated. Final non-2xx
  GitHub failures preserve their status and decoded body; existing-head errors
  name the PR number and URL. Validation 422 responses are not retried, and
  the retry behavior does not extend to other GitHub verbs.
- The frontend surfaces keystone-blocking warnings regardless of the confidence threshold, renders abandoned blockers as resolved in `TaskDetail`, and no longer clips the `/tasks` backlog actions column. Late-stack tables stack below 720px.

### Security

- Lockfile-only dependency fixes outside the audit sweep below: `ip-address` 10.7.2 (GHSA-2vr4-cq9g-pvrc, GHSA-rpw4-54j3-4h4q) with the override floor raised to `^10.7.2`, `brace-expansion` 1.1.21 and 5.0.12 (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p), `fast-uri` 3.1.8 and 4.1.5 (GHSA-hrr3-gc8f-f4qj), and earlier `fast-uri`, `qs`, `fflate`, `@xmldom/xmldom` and `browserslist` bumps within their semver ranges.

- `mcp-server` and `mcp-bridge` now publish through npm Trusted Publishing (OIDC); the publish workflow no longer references `NPM_TOKEN`. The `NPM_TOKEN` repository secret itself is retired separately.

- **npm audit gate CVE sweep: 7 advisories closed, no major bumps** (lockfile-only, task T-010). `npm audit --audit-level=high` was red on the default branch after advisories published post-last-green-run. All 7 closed within existing semver ranges: `next` 15.5.21 -> 15.5.25 (frontend/package.json; GHSA-p293-qw3h-jr36 unauthenticated RCE on Windows-hosted servers, GHSA-2xp9-vwfh-vxw4 RCE in Image Optimization with AVIF, both critical); `sharp` 0.35.3 -> 0.35.4 (root `overrides`; GHSA-rgj7-g3m4-5g8c libheif, high, also the `next` AVIF path's dependency); `js-yaml` 4.3.1 -> 4.3.2 (transitive dev dependency of `@eslint/eslintrc`, already satisfied by its declared `^4.3.0` range, no `overrides` needed; GHSA-2883-xcg3-v3hh CPU exhaustion via `maxTotalMergeKeys`, high); `hono` 4.13.0 -> 4.13.7 (backend/package.json; three moderate advisories: GHSA-gqvv-2mrq-wpjv, GHSA-g6gw-c38x-mqfc, GHSA-crvj-82cr-hjcx); `vitest`/`@vitest/mocker`/`@vitest/coverage-v8` 4.1.6-4.1.8 -> 4.1.11 across all workspaces (backend, frontend, cli, mcp-server, mcp-bridge; GHSA-82fw-gwwq-j7x9 path traversal via mock redirect, moderate). Unifying the vitest declared ranges to `^4.1.11` made the dedupe of the previously per-workspace nested copies into a single root copy unambiguous (a lockfile-only bump would also have resolved 4.1.11; the raised floors stop a later resolve from sliding back); no dropped nested record is still needed elsewhere (0 new package paths, only nested duplicates and their optional platform binaries removed). Side effect: cli, mcp-bridge and mcp-server previously resolved a nested vite 8.0.16 under vitest and now share the root vite 7.3.5; their suites were re-run green under Node 22, the frontend legs under Node 22 and 26. Nothing deferred; no CVE in this sweep needed a semver-major bump. Lockfile regenerated under npm 11.19.1 (`npx -y npm@11 audit fix --package-lock-only`) after npm 10.9.8 (this repo's pinned CI npm, via `actions/setup-node@v5` `node-version: 22`) hit the pre-existing `Cannot read properties of null (reading 'edgesOut')` Arborist crash on any lockfile-only resolve while `@vitest/coverage-v8` is in the dependency graph (npm10 bug, unrelated to this diff; `npm ci` itself is unaffected). Coherence verified where it matters, under the actual CI npm 10.9.8: clean-checkout `npm ci --dry-run --ignore-scripts` exit 0, then `npm ci --no-audit --no-fund` exit 0, then `npm audit --audit-level=high` exit 0 (0 vulnerabilities), all on npm 10.9.8/node 22.23.2.

**docs/okf quoted-literal drift guard (T-007, tracker 3feb590f).** Batch-43 (PR #509) re-stamped six bundle docs under okf-kit's `sources-fresh` check, which only compares timestamps against last-commit time and so missed two now-fixed claims a reviewer's source read caught: `SERVER_VERSION` quoted at an old value, and a teaching-error `allowedNext` array quoted with the wrong verbs. A new backend test (`backend/tests/unit/docs-okf-literal-guard.test.ts`) now checks every VALUE literal (semver, quoted string, JSON-shaped bracket/brace, `key: value`) that sits within 30 words of a `path:N`/`path:N-M` line citation, in the same markdown block, against the cited source lines; bare identifiers are never checked. The guard's own test titles carry the current counts at head (`docs/okf quoted-literal guard (T-007)` in `backend/tests/unit/docs-okf-literal-guard.test.ts`): one title reports value literals in scope, `log.md`'s historical literals counted separately and never asserted, bare identifiers correctly left unchecked, and allowlisted results against `deploy.md`'s permanent allowlist entries (`test:coverage`, `needs: mcp-server`, both true statements paired by word-proximity with a citation describing a different clause of the same job enumeration) with zero unallowlisted findings; a second title asserts the tokenizer sees every backtick span present in the bundle, matched against an independent raw-text count (`countSpans`) so a parser regression fails loudly instead of under-counting. Historically (round 1, now fixed): the original whitespace tokenizer silently dropped 61 of the bundle's then-1470 backtick spans. Fixed live by the guard while building it: `governance-merge.md`'s `github.ts:352` off-by-one (the `task.status === "review"` check was on line 351 at the time of the fix) and `mcp-server.md`'s `mcp-server/src/server.ts:9` widened to `:8-9` (it was citing only `SERVER_VERSION`, one line below the `SERVER_NAME` literal the same sentence also quotes). Decision record and the two rejected options (an okf-kit rule proposal; process-only re-stamp discipline) in `docs/okf/index.md`'s new Maintenance section. A dedicated blocking workflow (`.github/workflows/okf-literal-guard.yml`) runs the guard test, closing the gap where `ci.yml`'s `paths-ignore` skips the backend job on docs-only PRs (its trigger shape and required-status readiness are covered by the task 5e95e4bd entry below). See `docs/okf/governance-merge.md`, `docs/okf/mcp-server.md`.

**Label changes on a task are now audited (`task.labels_changed`).** Since the label editor (#496) made a task's `labels` human-writable via PATCH `/tasks/:id`, a claim-gating input (labels feed `resolveTriggeredRiskModifiers`'s claim-threshold risk modifiers and the easy-pick/heavy-pick dispatch routing) could be changed without a trail. The human PATCH lane now emits `task.labels_changed` with `{from, to, actorType}` whenever the labels array actually changes, compared order-insensitively (a reorder of the same labels does not fire). Agents still cannot write `labels` via PATCH. See `docs/events.md`.

**docs/okf literal-guard: symlink and directory-citation fixes, guard made always-run and ready to be marked required (task 5e95e4bd).** Two residuals of the T-007 quoted-literal guard (PR #513). (1) `createFileLineReader` (`backend/tests/helpers/okf-literal-guard.ts`) confined a citation path to the repo root with `path.resolve` only, so a citation naming an in-root symlink whose real target sits outside the root would read through it instead of being rejected; it now resolves both the root and every candidate path with `fs.realpathSync` before the containment test and reports an escaping symlink as `unreadable-citation` (a symlink resolving back to an in-root file still reads normally; two fixture tests in `backend/tests/unit/docs-okf-literal-guard.test.ts` cover both directions). The same hardened path also closes a related gap: a citation naming a directory (syntactically valid, since `CITATION_RE` requires no extension) used to throw EISDIR uncaught; it is now caught and reported as `unreadable-citation` like any other unresolvable citation, with its own fixture test. (2) `.github/workflows/okf-literal-guard.yml` ships without a `paths:` filter: it runs the guard test on every `pull_request` and every push to `master` under the stable job name "docs/okf literal guard", so the check is safe to add to branch protection's required-status list as-is. An earlier revision instead kept the workflow's original `paths:` filter and added a skip-shim job that reconstructed "does this PR affect the guard" from a hand-maintained pattern over a git diff, so a required check could still report success when nothing relevant changed; two review rounds each found a new way that shim silently skipped a relevant PR (a SIGPIPE on a large changed-file list under `pipefail`, a rename reported by destination only, a non-ASCII path C-quoted by git) and a new gap in the hand-maintained pattern, so the shim, its dedicated tests (`docs-okf-literal-guard-detect-step.test.ts`, `docs-okf-literal-guard-pattern-coverage.test.ts`), the workflow-yaml test helper, and the ambient `js-yaml` type shim they needed were all removed rather than patched a third time. Both options and who pays for each are recorded in the workflow's header comment and in `docs/okf/index.md`'s Maintenance section; note that the always-run guard turns red on any PR that shifts a cited source line, even without a docs change, which is the drift a path filter would have hidden. The branch-protection edit itself (adding "docs/okf literal guard" to the required-status-checks list for `master`) is an operator action, not made by this task.

**CLI id-prefix resolver now finds backlog tasks (D18 revision).** The 0.29.0 backlog-status-v1 known limitation below is resolved: `/api/tasks/claimable`'s `CLAIMABLE_VALID_STATUSES` now accepts `backlog` as an explicit-search value, so the CLI's id-prefix resolver (used by `tasks get`/`start`/`finish`/`comment` and friends) can resolve a backlog task's id the same way it resolves any other status, instead of only accepting the full UUID. This is discovery only, not a claim grant: the implicit "what can I claim right now?" default is unchanged (still `status=open`, unclaimed), and a backlog task found this way still 403s `backlog_not_promoted` at `/tasks/:id/start`/`claim` until a human promotes it. `tasks list --project --status backlog` is also now accepted client-side (the project-scoped browse endpoint already supported it). See `docs/okf/claim-model.md`.

## [0.29.0] - 2026-08-20

**Backlog status v1.**

**Agent-created tasks now route to a new backlog status, awaiting human operator review before agent pickup is allowed.** The backlog status is invisible to agents during `task_pickup`; humans must explicitly promote backlog tasks to `open` (audit event `task.backlog_promoted`) or discard them to `abandoned` (audit event `task.backlog_discarded`). Human-created tasks continue to default to `open`. Backlog tasks are a draft space: `task_respec` is allowed for any caller (agent or human) until promotion. Backend: agent hard-routes to backlog; `task_start` and legacy `claim` reject backlog tasks with `403 backlog_not_promoted`; human PATCH promotes/discards. MCP: teaching errors guide agents toward the operator UI; `workflow_primer` documents the backlog routing flow. Frontend: backlog column left of Open on the dashboard board with a count badge; backlog filter and promote/discard actions in the task list and detail views. No DB schema change (additive enum); old MCP bridges tolerate the new status. Release order: server before bridge.

**Known limitation (D18), resolved in 0.30.0**: the CLI could not resolve backlog-task IDs by prefix; the id-prefix resolver used `/api/tasks/claimable` which intentionally excluded backlog from search results, so only full UUIDs worked. See the 0.30.0 entry above and `docs/okf/claim-model.md` for the fix.

**Also in this release (since 0.28.0):** Response Contract v1 across the MCP surface (receipts by default, `include` valves, legacy re-registration; mcp-server 0.13.0 line), the confidence milestones M3 (risk modifiers, read side), M4 (optional advisory LLM rewrite helper, opt-in) and M5 telemetry slices, agent creator-abandon with admin unabandon recovery, abandoned blockers resolved in the blockedBy gate, per-type confidence thresholds on badges and discovery endpoints, enforcement-mode-aware claim wording in the create panel, and CI hardening (test-file typecheck steps, frontend prod-image smoke). Details live in the merged PR history (#371 to #477) and the per-package changelogs.

## [0.28.0] - 2026-06-27

**Full remediation of the 2026-06-10 security audit: all 9 MEDIUM findings and 3 LOW findings addressed, alongside per-task attachment caps and a teams-page table/cards overhaul.** The `vX.Y.Z` tag is deploy provenance for the whole app; the individual workspace packages carry their own versions.

### Security

- **Atomic compare-and-swap for review-lock claim and release (M1, TOCTOU)** (#370). The review-lock claim, release, and abandon paths previously read `isCurrentReviewer` then wrote unconditionally, so two concurrent reviewers could both pass the check (last-writer-wins, no error to the loser). All four write sites now use a guarded `updateMany` matching the existing work-claim pattern; a lost race returns 409.
- **GitHub delivery-id idempotency on webhook events (M2)** (#372). GitHub redelivers webhook events on non-2xx responses, producing duplicate timeline comments and repeated transitions. A `WebhookDelivery` table keyed on `X-GitHub-Delivery` claims before dispatch; a duplicate id is short-circuited without re-dispatching (at-most-once semantics).
- **Custom-workflow projects respect governance on webhook PR merge (M3)** (#373). Non-autonomous projects with a custom workflow previously auto-transitioned to `done` on a PR-merge event, bypassing the review gate. Custom workflows now follow the same governance logic as the default workflow; per-workflow merge-target overrides are a deferred follow-up.
- **Constant-time HMAC comparison in webhook signature verification (L1)** (#373). `verifyWebhookSignature` now re-HMACs both sides under an ephemeral per-process key before `timingSafeEqual`, eliminating the early length-return that made verification non-constant-time on mismatched candidates.
- **Login timing equalized to prevent email enumeration (M4)** (#369). The no-user branch returned 401 before paying the scrypt cost, leaking whether an email was registered via response time. A `fakeVerifyPassword` call on the no-user branch equalizes KDF work on both paths.
- **HTTP(S)-scheme allowlist on all agent- and user-writable URL fields (M6, CSP sweep)** (#369, #378). The `prUrl`, artifact `url`, `notificationWebhookUrl`, and SSO `issuer` fields previously accepted `javascript:` and `data:` URLs via bare `z.string().url()`, enabling stored-XSS via rendered `<a href>` elements. All writable URL fields now use a shared `httpUrl()` Zod builder (allowlisting `http:` and `https:` only). A regression guard test scanning all of `backend/src` fails if a bare `z.string().url()` is reintroduced in a route.
- **SSRF egress guard on outbound notification webhook delivery (M8)** (#371). The webhook delivery previously fetched the operator-configured URL with no egress controls. Delivery now resolves the target hostname and rejects private, loopback, link-local, and cloud-metadata addresses (including IPv4-mapped and NAT64 forms); redirects are disabled so a public URL cannot 3xx-bounce to an internal host. An opt-in `WEBHOOK_ALLOWED_PRIVATE_HOSTS` env var permits specific internal targets for self-hosters.
- **CLI warns on token config file lax permissions (M7)** (#375). `loadConfigFile` now emits a warning (POSIX only) when `~/.agent-tasks.json` is accessible by other users (mode broader than `0600`), directing the user to `chmod 600`.
- **Predictable dev `SESSION_SECRET` default removed (L3)** (#377). The dev `docker-compose.yml` and `.env.example` shipped a predictable literal `SESSION_SECRET`; the default is removed so an unset secret fails loudly via the backend's `>=32`-char validation. Dev quick-start docs now include an `openssl rand -hex 32` generation step.
- **`AuditLog` foreign keys annotated `onDelete: SetNull` explicitly (M5)** (#374). The annotation was already the Prisma effective default for optional relations (audit rows survive project/task/user deletion with a null reference); it is now explicit to pin the audit-retention guarantee and future-proof it against Prisma default changes. No migration required.

### Added

- **Per-task aggregate attachment count and bytes cap** (#368). A per-task count cap (default 20, `ATTACHMENT_MAX_COUNT_PER_TASK`) and aggregate bytes cap (default 50 MiB, `ATTACHMENT_MAX_TOTAL_BYTES_PER_TASK`), each overridable per project via nullable `Project.attachmentCountCap` and `attachmentBytesCap`, prevents runaway accumulation of task file attachments. The multipart upload route returns 429 on count overage and 413 on bytes overage without writing the file.
- **Teams: Table/Cards view switch, auto-defaulted by project count** (#367). The project card grid is available as a Cards alternative to the dense table, behind a Tabs switch. The view auto-defaults based on project count (cards for few projects, table for many); an explicit toggle persists to localStorage. The auto-default re-resolves per team, so navigating to a differently sized team picks the right default without freezing the stored preference.
- **Teams: dense sortable project table** (#366). The `/teams` project card grid is replaced with the shared `ui/Table` primitive: sortable Name, Repo, Active tasks, Created, and Synced columns with a row-actions overflow menu, controlled sort with per-column comparators, page size 25, and existing search, GitHub-only filter, and pagination retained.

### Changed

- **`task_finish` result field documented as free-text in the MCP tool schema (L2)** (#377). The tool description now states the result is free-text prose/markdown, not a structured or XML payload, addressing a pattern of agents appending fake XML.
- **CI: CLI workspace job added (M9)** (#376). A dedicated CI job now runs typecheck, build, and test for `@agent-tasks/cli`; CLI regressions previously shipped without CI verification. The CLI test suite gains a `pretest` build step and hermetic env injection so tests are clean-checkout-safe.

### Docs

- **README hero screenshot** (#365).

## [0.27.0] - 2026-06-25

**The `reclassify` flag is exposed on the `task_start`/`task_pickup` MCP tools, a review-claim leak on non-terminal exit from review is fixed, plus a settings-UI de-slop and a dependency security pass.** The `vX.Y.Z` tag is deploy provenance for the whole app; the individual workspace packages carry their own versions.

### Added

- **`reclassify` declared on the `task_start` and `task_pickup` MCP tool input schemas** (#359). The opt-in debugFlavor-reclassify flag (shipped in 0.26.0) is now a first-class, discoverable parameter in the MCP tool definitions: `task_pickup` forwards it as the literal query string `?reclassify=true`, and `task_start` forwards it as a JSON-body boolean. Callers no longer have to know the wire detail to use it.

### Fixed

- **Review-claim released on a non-terminal exit from review** (#360). Leaving a task's review without a terminal transition now clears the review claim instead of stranding it on the task, so the next reviewer is not blocked by a phantom claim.
- **Settings side-nav active item drops its accent border** (#362). The active item in the settings side navigation no longer carries the templated-looking accent border.

### Security

- **Cleared a runtime `hono` advisory and dev-only CVEs** (#363) via `npm audit fix`.

### Docs

- **README, docs, and the MCP reference reconciled with the code** (#361).

## [0.26.0] - 2026-06-16

**Per-task artifact cap, two new self-service claim paths, and a state-management + UI fix batch.** The backend now enforces a configurable aggregate count and byte cap on per-task artifacts to bound runaway loops (#350). Two opt-in claim shortcuts reduce operator friction: a self-approve path clears review-state work claims on non-DR projects (#356), and `task_start`/`task_pickup` accept a `debugFlavor` reclassify flag without a separate update call (#357). Transition into a terminal state now atomically clears both work claims (#348) and review-claim fields (#354). Escape-layering in modals is fixed so a Select or DropdownMenu popover closes before its parent Modal (#349), and `table-layout: fixed` is now applied consistently so declared column widths are honored across all Table consumers (#347, #346).

### Added

- **Per-task aggregate artifact count and bytes cap** (#350). A configurable cap on the total artifact count and total bytes per task prevents runaway agent loops from accumulating unbounded artifact storage.
- **Self-approve path for review-state work claim on non-DR projects** (#356). On projects without a double-review gate, an agent holding a work claim in review state can self-approve its own claim without waiting for a separate reviewer.
- **Opt-in `debugFlavor` reclassify on `task_start` and `task_pickup`** (#357). Callers can pass an opt-in flag to reclassify a task's debug flavor at start or pickup time, enabling debug-mode pipelines without a separate update call.

### Fixed

- **Transition into a terminal state clears work claims** (#348). `POST /tasks/:id/transition` into a terminal state now atomically clears any outstanding work claims, preventing phantom claimed tasks after completion.
- **Transition into a terminal state also clears review-claim fields** (#354). Completes the fix from #348 by clearing `reviewClaim` and `reviewClaimExpiresAt` on terminal transition.
- **Escape closes a nested Select or DropdownMenu popover before the parent Modal** (#349). The first Escape press now closes the innermost open overlay; the Modal only receives the event once all popovers inside it are closed.
- **Table fixed-layout column widths honored across all consumers** (#347). All Table usages now apply `table-layout: fixed` so declared column widths are respected rather than overridden by cell content.
- **Long titles clamped in list views** (#346). Task titles that exceed column width in the task list and dashboard table are now truncated with an ellipsis via the fixed table layout.

### Tests

- **Parallel claim-race regression test and agent-credentials doc** (#355). Adds an integration test asserting that the compare-and-swap claim guard holds under concurrent requests; adds `docs/testing/agent-credentials.md` describing how to obtain test tokens.
- **Notification-webhook e2e wire-format test against a real HTTP server** (#352). Validates the outgoing webhook payload against a live HTTP listener rather than a mock, catching serialization regressions before deploy.
- **`CreateTaskRequest` to Zod `createTaskSchema` key parity check** (#351). A pinned test asserts that the OpenAPI `CreateTaskRequest` schema and the Zod validation schema expose the same top-level keys, preventing silent schema divergence.

### Changed

- **MCP bridge reconciled to the published v0.7.1** (#353). Aligns the master branch to the already-released `@agent-tasks/mcp-bridge@0.7.1` and pins `@agent-tasks/mcp-server@0.9.0`; no behavior changes.

## [0.25.1] - 2026-06-14

A security and fixes release on top of the Quiet Precision overhaul. No schema changes.

### Security

- **Enforce write-tier on the boards and workflows routers** (#344, audit 2026-06-10 H1+H2). `hasProjectAccess` admitted the read-only `PROJECT_VIEWER` role, but board create/update and workflow create gated on it, so a user invited as a viewer could still write. Board create and update now require `requireProjectWrite`; workflow create now requires `isProjectAdmin`, consistent with workflow update and reset. Every remaining `hasProjectAccess` call in both routers guards a read-only handler.
- **Clear the esbuild advisories** (#342, #343; GHSA-gv7w-rqvm-qjhr, GHSA-g7r4-m6w7-qqqr). Bumped `tsx` to `^4.22.4` and forced `esbuild >= 0.28.1` so the dev toolchain no longer resolves the vulnerable range.

### Fixed

- **Humans can complete the task workflow from the UI** (#341). The web UI did not expose the final workflow-completion action for human actors; a human reviewer can now finish a task's workflow directly from the task surface.

## [0.25.0] - 2026-06-12

**Headline: the Quiet Precision UI overhaul.** Every surface of the web app (dashboard, home, tasks browser, task detail, projects hub, workflow editor, settings, teams, auth, onboarding) was rebuilt on a shared design system: design tokens v2, a component library, a de-inlined app shell, and a full accessibility, responsive and light-theme pass. Plus the first round of overhaul fallout fixes reported from live use, including an in-place task-create flow on the /tasks browser. One additive backend route; no schema changes.

Operator note: no breaking changes, no migrations. Per the convention since v0.9.0, workspace `package.json` versions are not bumped; `@agent-tasks/mcp-server` (0.9.0) and `@agent-tasks/mcp-bridge` (0.7.1) are unchanged since their last tags. The web UI is visually new throughout and all URLs are preserved; two deliberate behavior changes are listed below (the agent-token modal mints only on explicit request, and the New-task button on /tasks creates in place instead of navigating to the dashboard). All changes were verified against the production deployment before this tag (checklist in the release PR).

### Added

- **In-place new-task flow on /tasks with a project-select step** (PR #336). The New-task button (and the empty-state CTA) no longer navigates away to the dashboard: step 1 picks the project, then the regular create form opens with that project's template fields; exactly one accessible project skips the picker. The advertised "C" shortcut is actually wired now, and an in-flight project load is invalidated on re-pick or close, so the form can never open for the wrong project.
- **Breadcrumb back to the dashboard on project hub pages** (PR #339). Overview, settings, members and workflow show "Dashboard / {project}" above the title; the link restores the same team and project on the dashboard.
- **Read-only `GET /projects/:id/members`** (PR #332). Any project member can list accepted members; powers the rebuilt members page. Write endpoints keep their admin guards.

### Changed

- **Quiet Precision UI overhaul** (PRs #328-#334; design direction, mockups and the audit digest in `docs/design/`):
  - Foundation (PR #329): design tokens v2, shared component library (Button, Table, Modal, Select, Tabs, Badge, PageHeader, EmptyState, Skeleton and friends), AppChrome shell with the header de-inlined from pages, `/dev/ui` component gallery.
  - Dashboard + home (PR #330): kanban board and list view rebuilt on the new cards/table, filter toolbar, project picker in the page header.
  - Tasks browser + task detail (PR #331): shared Table with server-side sort, GFM markdown rendering for descriptions and comments, rebuilt detail view with checklist progress, review panel and meta sidebar.
  - Projects hub + workflow editor (PR #332): per-project hub layout with subnav (overview, settings, members, workflow), rebuilt workflow and gates editor.
  - Settings, teams, auth + onboarding (PR #333): rebuilt settings surfaces, AuthShell, and the ConnectAgentModal now mints a token only on explicit request instead of on open.
  - Polish (PR #334): accessibility sweep (focus rings, aria encodings, keyboard menus), responsive pass, light-theme QA.

### Fixed

- **Task-detail checklists no longer shred into columns** (PR #335). GFM task-list items rendered every text run between inline code spans as its own narrow flex column and overflowed horizontally on mobile. Items are back in normal inline flow, the selectors only match real task lists (nested regular lists keep their bullets), and long inline-code tokens may wrap on narrow screens.
- **Dashboard board cards show the confidence score again** (PR #337). The overhaul had dropped the per-card badge; it is back next to the priority label, computing the same score the task detail shows.
- **The "0 of X" next to the task description is labeled now** (PR #338). It is the checklist progress over the description's checkboxes and reads "0 of 9 checked" with an icon and tooltip; the counter also counts nested and `*`/`+` checklist items, which it previously missed.

## [0.24.0] - 2026-06-09

**Headline: agents can discover a project's task-template requirements before composing a task.** The project discovery surface now reports whether task-template mode is on, the required fields, the enforcement mode, and the confidence threshold, so an agent can compose a task that will clear the create-time confidence gate on the first try. Plus the 2026-05-30 audit fixes. No schema changes; deployed from `master`, so this tag is deploy provenance.

### Added

- **`taskCreation` discovery block on the project surface** (PR #324). `GET /projects/:id`, `GET /projects/:id/effective-gates`, and the by-slug lookup now return a read-only `taskCreation` block (`enforcementMode`, `confidenceThreshold`, `templateModeEnabled`, `requiredFields[]`). Previously `projects_get_effective_gates` returned only the merge/review gate map, so an agent could not learn a project's task-template requirements before composing via `task_create`.

### Security

- **MEDIUM: auth rate limiting no longer trusts the client-controlled `X-Forwarded-For`** (PR #326, finding #21). The key IP is derived from the socket peer via `getConnInfo`, or from the right of `X-Forwarded-For` when the new `TRUSTED_PROXY_HOPS` config is set, closing the spoofable-XFF bypass.
- **MEDIUM: claim and start writes are now atomic compare-and-swap** (PR #326, finding #22). `POST /tasks/:id/claim` and the open-branch of `POST /tasks/:id/start` use a guarded `updateMany`, closing a claim race.
- **hono bumped to `^4.12.21`** (4 MEDIUM CVEs: CVE-2026-47673 / 47674 / 47675 / 47676, PR #325).

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
