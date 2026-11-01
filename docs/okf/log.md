- 2026-11-01T07:04:50Z: the legacy webhook's `githubRepoFilter` (`backend/src/services/github-webhook.ts`) now delegates to `githubRepoEqualsInsensitive` (`backend/src/lib/github-repo-match.ts`), which LIKE-escapes the repo name before the case-insensitive match, so `_` and `%` match literally. `governance-merge.md`: the unmatched-merge sentence names the helper and the escaping; the three handlers' lookups and the exact `push` sync lookup re-read at source. Re-stamped. Checks: `npx okf-kit check docs/okf`.
- 2026-10-31T16:21:33Z: re-stamp after today's squash merges that re-dated sources: root `package.json` engines floor now `^22.13.0 || >=24` (`architecture.md` cites `package.json` for the workspaces list only, unchanged), the legacy `issues`, `pull_request` and `pull_request_review` webhook handlers match `project.githubRepo` case-insensitively with the `push` sync lookup still exact (`backend/src/services/github-webhook.ts` `githubRepoFilter`; `governance-merge.md` already states this and the `pr_merged_unmatched` audit row, re-read against the code and `grounding-github-webhook.ts` `unmatchedMerge` and `routes/webhooks.ts`, true), and the `github:pr_merge` re-mint recipe in `mcp-server/src/errors.ts` is shortened (`mcp-server.md` calls it the admin re-mint recipe with the `MERGED_OUTSIDE_HINT`, still true; its anchored citations into that file resolve). `backend.md`, `claim-model.md`, `signals-and-notification-delivery.md` and `workflow-gates.md` cite the changed sources but make no claim about handler repo matching or the recipe wording; re-read, unchanged. All seven re-stamped. `auth.md` and `confidence-scorer.md` keep the staleness they already carry on master. Checks: `npx okf-kit check docs/okf`.
- 2026-10-31T14:49:08Z: `frontend/src/components/TaskDetail.tsx` (reset on a new task id) and `frontend/src/components/dashboard/NewTaskModal.tsx` (reset when it opens or its resolved initial status changes) now reset their form state during render instead of in an effect, and both files leave the `react-hooks/set-state-in-effect` warn list in `frontend/eslint.config.mjs`. `frontend.md` names both files as sources; re-verified its claims against the changed files: the create modal's two-value Status dropdown (`backlog` first, `open`), the `DEFAULT_CREATE_STATUS` default and clamp of any other `initialStatus`, the disabled `me` assignee while the status is `backlog` (`aria-disabled` via `Select`) and the live confidence badge in `NewTaskModal` are unchanged by the move. The doc cites no line number of either file. Re-stamped. Checks: `npx okf-kit check docs/okf`.
- 2026-10-31T08:02:31Z: merge of master (dev compose loopback ports, squash-merged) into the prod env forwarding branch. `deploy.md` cites `docker-compose.yml` for the dev project name, the dev `TRUSTED_PROXY_HOPS` default 0 and that the prod file needs `-f`, and the prod compose for the forwarding claims: all re-read against the merged files, still true. Re-stamped. Checks: `npx okf-kit check docs/okf`.
- 2026-10-31T07:31:15Z: `docker-compose.prod.yml` forwards `LOG_LEVEL` (default `info`) and `REDIS_KEY_PREFIX` (default `agent-tasks:`) to the backend, pinned by `backend/tests/unit/prod-compose-env-forwarding.test.ts`; `.env.example` gains a commented production block. `deploy.md`: the forwarding claim now names both keys and their non-empty defaults (re-verified with `docker compose config` for unset, empty and set values); its `backend/package.json` source changed only in ESLint devDependencies, no claim affected. `architecture.md` cites the prod compose for the service topology (db, migrate, backend, frontend), unchanged; re-read. Both re-stamped. Checks: `npx okf-kit check docs/okf`.
- 2026-10-31T07:25:44Z: the dev compose binds every published port to `127.0.0.1` (`docker-compose.yml`, guard `backend/tests/unit/docker-compose-loopback-ports.test.ts`; README quickstart and `docs/development.md` say it is a local dev stack, not a self-hosting path). `deploy.md` cites `docker-compose.yml` for the dev project name, the dev `TRUSTED_PROXY_HOPS` default 0 and that the prod file needs `-f`: all still true, it makes no claim about published ports; re-read, unchanged, re-stamped. Checks: `npx okf-kit check docs/okf`.
- 2026-10-31T07:14:32Z: a merged `pull_request` delivery that matches no project or no open task now logs a warn (`repo`, `prNumber`, `reason`) and writes a `task.reviewed` audit row with `event: pr_merged_unmatched` in `backend/src/services/github-webhook.ts` (`reportUnmatchedMerge`, `hasUnopenedTaskForPr`) and `backend/src/services/grounding-github-webhook.ts` (`unmatchedMerge`); `backend/src/routes/webhooks.ts` logs the repo with a dispatch error; `mcp-server/src/errors.ts` (`MERGED_OUTSIDE_HINT` on the missing-`github:pr_merge` recipe) and `mcp-server/src/primer.ts` ("Merged outside agent-tasks" section) teach the recovery. `governance-merge.md` (legacy webhook ingest paragraph) and `mcp-server.md` (primer and teaching-error paragraph) rewritten and re-verified against the code; `backend.md` (route mounting and services), `claim-model.md` (webhook writers clear claims), `workflow-gates.md` (legacy webhook CAS writers), `reconcile-done-but-open.md` (configured webhooks are pending observations) and `signals-and-notification-delivery.md` (acknowledgement on a webhook-written terminal state) re-read against the changed files, no claim touched, unchanged. All re-stamped. Checks: `npx okf-kit check docs/okf`.
- 2026-10-31T07:10:22Z: `/auth/error` reads `?reason=` and maps each code to a message (`frontend/src/app/auth/error/page.tsx`, new `messages.ts`), and the GitHub OAuth callback (`backend/src/routes/auth.ts`) redirects its failures there with a reason instead of JSON 400. `frontend.md` re-read: it lists the `auth` route segment and the `auth/github` redirect routes only, neither changed (the new file is a sibling of the error page, not a route); `permissions-model.md` cites `backend/src/routes/sso.ts` for the SSO admin routes only and `sso.ts` is unchanged. Re-stamped `frontend.md`. Checks: `npx okf-kit check docs/okf` (no new finding besides the `frontend.md` STALE this edit cleared).
- 2026-10-30T22:40:08Z: comment-only edit in `frontend/src/app/tasks/page.tsx` (team-change reset comment); `frontend.md` makes no claim about it, re-read, unchanged. Re-stamped. Checks: `npx okf-kit check docs/okf`.
- 2026-10-30T22:16:24Z: lint toolchain moved to ESLint 10 (`backend/package.json`, `frontend/package.json`, root `package.json`, both `eslint.config.mjs`), two dead initializers dropped in `backend/src/routes/tasks.ts` and `backend/src/services/grounding-completion.ts` (no line shift), and frontend effects that only reset state on a key change now adjust it during render (`frontend/src/app/tasks/page.tsx`, `frontend/src/app/projects/page.tsx`, `frontend/src/app/projects/[id]/board/page.tsx`, `frontend/src/app/home/page.tsx` and components). All 23 anchored citations into changed files resolve unchanged; `architecture.md`, `backend.md`, `claim-model.md`, `cli.md`, `deploy.md`, `frontend.md`, `governance-merge.md`, `permissions-model.md`, `reconcile-done-but-open.md`, `signals-and-notification-delivery.md`, `task-lifecycle.md`, `workflow-gates.md` make no claim about the lint setup or effect timing, re-read, unchanged. All 12 re-stamped. `auth.md` and `confidence-scorer.md` keep the staleness they already carry on master. Checks: `npx okf-kit check docs/okf`.
- 2026-10-30T11:17:32Z: the GitHub webhook merge hand-off (`pickMergeTargetStatus` in `backend/src/services/github-webhook.ts`, used by `handlePullRequestEvent` and the grounding `pr_merged` path in `backend/src/services/grounding-github-webhook.ts`) targets the first review-like state with a direct edge from the task's current state, else the unchanged workflow-wide first review-like state; the shared predicate is `reachableReviewState` in `backend/src/services/default-workflow.ts`, which `finishTargetFrom` now also uses. `governance-merge.md`, `workflow-gates.md` and `claim-model.md`: the webhook target sentences rewritten and re-verified by the implementer against the code. `backend.md`, `deploy.md`, `reconcile-done-but-open.md` and `signals-and-notification-delivery.md` cite the changed sources but make no claim about the hand-off target; re-read, unchanged. All seven re-stamped; this also clears the squash-date staleness `claim-model.md`, `governance-merge.md` and `workflow-gates.md` carried on master for `backend/src/routes/tasks.ts` and `backend/src/services/grounding-context.ts` (the finish-target change logged at 2026-10-30T06:21:22Z). `auth.md` and `confidence-scorer.md` keep the staleness they already carry on master. Checks: `npx okf-kit check docs/okf`.
- 2026-10-30T10:34:32Z: column heads of a `.db-board--scroll` board are static at 1280px and up (`frontend/src/app/globals.css`), and `frontend/src/lib/boardColumns.ts` added to `frontend.md` sources (the doc describes it). `frontend.md` makes no claim about head stickiness; board paragraph re-read, unchanged. Re-stamped. Checks: `npx okf-kit check docs/okf`.
- 2026-10-30T10:15:28Z: board fix round (`frontend/src/lib/boardColumns.ts`: abandoned tasks get no column and are not counted, extra columns of a built-in state name use the board label; `frontend/src/components/dashboard/BoardView.tsx` and `frontend/src/app/globals.css`: `.db-board--scroll` from six columns keeps a 240px minimum at 1280px and up, custom columns get the `--status-open` dot; `frontend/src/app/projects/[id]/board/page.tsx`: comment only). `frontend.md`: board paragraph corrected (invisibility claim excludes abandoned, extra-column titles, wide scroll rule, custom dot, `+` gating citation moved to `BoardView.tsx:344`), re-verified by the implementer against the code. Re-stamped. Checks: `npx okf-kit check docs/okf`.
- 2026-10-30T09:24:05Z: the project board builds its columns from the project's workflows (`frontend/src/lib/boardColumns.ts` `buildBoardColumns`: backlog first, default workflow states in graph order with initial first and terminal last, pinned-only states after, an extra column per unknown status; `frontend/src/app/projects/[id]/board/page.tsx` reads `getWorkflows` failure tolerant; `frontend/src/components/dashboard/BoardView.tsx` takes the columns and sets `--db-cols`; `frontend/src/app/globals.css` grid count). `frontend.md`: the board-view paragraph rewritten (five-column claims generalised, `+` gating citation moved to `BoardView.tsx:335`), re-verified by the implementer against the code. Re-stamped. Checks: `npx okf-kit check docs/okf`.
- 2026-10-30T06:21:22Z: a work-claim task_finish targets the first review-like state with a direct edge from the task's current state, else the previous global first review-like state (`finishTargetFrom` in `backend/src/services/default-workflow.ts`; used by the work finish and the task_start preview in `backend/src/routes/tasks.ts` and by the grounded finish target in `backend/src/services/grounding-context.ts`). `task-lifecycle.md`: the work-finish target sentence rewritten (re-verified against the code; an unreachable finish answers 400). `workflow-gates.md`, `permissions-model.md`, `signals-and-notification-delivery.md`, `cli.md`: anchored `tasks.ts` citations still resolve (the change keeps the line count after the task_start preview). `backend.md`, `claim-model.md`, `deploy.md`, `governance-merge.md` (its webhook merge hand-off sentence is unchanged on purpose) and `reconcile-done-but-open.md` cite the changed sources but make no claim about the work-finish target; re-read, unchanged. All ten re-stamped. `auth.md` and `confidence-scorer.md` keep the staleness they already carry on master. Checks: `npx okf-kit check docs/okf`.
- 2026-10-29T15:10:56Z: workflow state names are bounded to 64 characters (`STATE_NAME_MAX_LENGTH` in `backend/src/routes/workflows.ts`); a task_finish approve into any terminal state of the effective workflow records the `done` disposition without a second lookup (`recordTerminalSnapshot` `reachedTerminal` in `backend/src/services/confidence-telemetry.ts`, passed by the two approve branches of `backend/src/routes/tasks.ts`); the workflow editor hint no longer calls the vocabulary fixed (`StatesTable.tsx`). `claim-model.md` and `workflow-gates.md`: the save-time name rule now names the bound. `permissions-model.md`, `signals-and-notification-delivery.md` and `workflow-gates.md`: anchored `tasks.ts` citations re-pointed by the added lines (claims unchanged). `backend.md`, `cli.md`, `deploy.md`, `frontend.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` cite the changed sources but make no claim about name length, the disposition write or the editor hint; re-read by the delta reviewer, unchanged. All eleven re-stamped. `confidence-scorer.md` makes no claim about when the disposition is written and keeps the staleness it already carries on master; `auth.md` likewise (`backend/src/routes/mcp.ts`). Checks: `npx okf-kit check docs/okf`.
- 2026-10-29T14:42:50Z: the workflow API accepts custom state names (`backend/src/routes/workflows.ts` `workflowDefinitionSchema`: any `[a-z0-9_]+` name and terminal flags; `initialState` stays `open` and non-terminal, `backlog` and `abandoned` are reserved as state names and edge ends, at least one terminal state; `FIXED_STATE_NAMES` removed). `workflow-gates.md` (save-time rules in the stored-legacy-definitions paragraph), `claim-model.md` (the workflow API sentence in the `status` paragraph) and `deploy.md` (deploy and verify are not states by default, the API would accept them, the editor cannot author them) corrected against the code and `docs/deploy-verify-strategy.md`. Re-verified with no claim change and re-stamped: `backend.md`, `permissions-model.md`, `signals-and-notification-delivery.md` (sources include `backend/prisma/schema.prisma`, comment-only edit), `cli.md`, `governance-merge.md`, `reconcile-done-but-open.md`, `task-lifecycle.md` (source `backend/src/routes/tasks.ts`, comment-only edit). Not re-stamped: `auth.md` and `confidence-scorer.md`, stale before this change for other sources (`backend/src/routes/mcp.ts`, earlier `tasks.ts` and `schema.prisma` commits). Checks: `npx okf-kit check docs/okf`, no error and no new warning over the base count after the re-stamp.
- 2026-10-29T13:30:35Z: `/tasks` status chips skip malformed stored states (`frontend/src/app/tasks/page.tsx` `statusChipsFor`); `frontend.md` corrected: the team task list does not check status names, an unknown name lists no tasks; the review-like rule sentence split. Re-verified against `backend/src/routes/tasks.ts` (team list route filters `status in` without a vocabulary check) and re-stamped.
- 2026-10-29T13:17:10Z: list views read stored workflows the way the backend does (`frontend/src/lib/workflow-vocabulary.ts`: sanitized definition, review-like and terminal names, built-in fallback for an unreadable definition; shared fixtures with backend-generated expected values, pinned by a backend parity test) and `/tasks` keeps URL status names that are not loaded yet. `frontend.md` re-verified by the implementer against the code (status vocabulary paragraph, server-side name filtering caveat, the new source) and re-stamped.
- 2026-10-29T12:46:52Z: /tasks presets and Home widgets follow the workflow vocabulary (`frontend/src/app/home/widgetFilters.ts`: review-like port of `isReviewState`, `workflowStatusNames`, `widgetRequest`, `isActionableTask`; `frontend/src/app/home/projectWorkflows.ts`: 403 remembered per team; `frontend/src/app/home/page.tsx`: mine, review and done widgets and the per-widget second request; `frontend/src/app/tasks/page.tsx` and `frontend/src/app/tasks/_components/useProjectWorkflows.ts`: resolved presets, custom state chips, `status` parameter vocabulary). `frontend.md` re-verified: the new paragraph "Status vocabulary of the scope presets and Home widgets" states the behaviour, and its sidebar sentence no longer claims there is no frontend copy of the review-state predicate. Re-stamped.
- 2026-10-29T12:42:56Z: both GitHub `issues.opened` creators start the task in the project default workflow's initial state and send `task_available` (`backend/src/services/grounding-github-webhook.ts`: `createInitialStatus` on the delivery transaction, signal rows from the new `createTaskAvailableSignalsInTx` in `backend/src/services/task-signal.ts` written in the same transaction, notification webhooks after the commit; `backend/src/services/github-webhook.ts`: `createInitialStatus` per linked project, `emitTaskAvailableSignal` best effort). `governance-merge.md` (legacy ingest paragraph and the configured issue-open paragraph), `claim-model.md` (the issue-open sentence: no longer "no availability signal"), `workflow-gates.md` (runtime creation policy paragraph), `signals-and-notification-delivery.md` (task_available recipients and the grounding-configured paths) and `task-lifecycle.md` (one sentence on webhook-created tasks) rewritten and re-read against the code. `backend.md` and `reconcile-done-but-open.md` cite the changed sources but make no claim about issue-open creation or the signal (the runtime-configuration line says only that the policy enrolls signed issue-open creations atomically, which still holds); re-read, unchanged. All seven re-stamped; this also clears the staleness they carried at the base for `backend/src/routes/tasks.ts`, `backend/src/routes/grounding-creation.ts` and `backend/src/services/task-status-input.ts`, whose claims about those files were not edited here.
- 2026-10-29T08:07:09Z: created and imported tasks start in the effective workflow's initial state (`backend/src/services/task-status-input.ts` `createInitialStatus`: pinned workflow of the project, else the project default, else built-in; used by create and import in `backend/src/routes/tasks.ts` and by `backend/src/routes/grounding-creation.ts`), and task_available fires when the created status equals that state. `task-lifecycle.md`: the human default and the grounding creation paragraph rewritten (re-verified against the code). `workflow-gates.md`, `signals-and-notification-delivery.md`, `cli.md` and `permissions-model.md`: anchored citations into `routes/tasks.ts` re-pointed by the inserted lines (each anchor read at the new line), claims unchanged. `architecture.md`, `backend.md`, `claim-model.md`, `governance-merge.md` and `reconcile-done-but-open.md` cite the changed sources but make no claim about the create default or the signal; re-read, unchanged. All ten re-stamped. `auth.md` and `confidence-scorer.md` keep the staleness they already carry on master; the `docs.ts:2090` citation in `architecture.md` is pre-existing.
- 2026-10-29T06:28:32Z: client status lists follow the workflow vocabulary (`mcp-server/src/tools.ts`: bounded state-name strings for `tasks_transition`, `tasks_list` and `project_tasks`; `cli/src/api.ts`, `cli/src/index.ts`, `cli/src/resolve.ts`: `--status` shape check and a second id-prefix pass over custom workflow states; `frontend/src/app/home/`: the Priority widget uses each task's workflow terminal states, an unreadable definition reads as built-in). `cli.md`: the prefix-search pool and `tasks list --status` claims rewritten, citation moved to `api.ts:250-251`; its `backend/src/routes/tasks.ts:1680` and `:1089` anchors still hold. `mcp-server.md`: one citation moved to `tools.ts:836`; the `errors.ts:794/:810` anchors still hold. `architecture.md`, `claim-model.md` and `task-lifecycle.md` cite the changed sources but make no status-list claim; re-read, unchanged. `frontend.md` names `home` as a route segment only; unchanged. All six re-stamped. `auth.md` and `confidence-scorer.md` keep the staleness they already carry on master.
- 2026-10-28T13:00:10Z: merge of master into the team-name branch: `frontend.md` re-verified after both sides re-stamped it (its Team rename paragraph names U+FFFC in the blank class, from this branch; the Select and board claims from master hold). Re-stamped.
- 2026-10-28T12:38:26Z: searchable mode of the shared Select (`frontend/src/components/ui/Select.tsx`, opt-in `searchable`, title substring and id-prefix filter, chosen option as the field's description) used by the task detail dependency picker (`frontend/src/components/TaskDetail.tsx`), styles in `frontend/src/app/globals.css`. `frontend.md` re-verified: its Select claim (aria-disabled pattern) still holds and it makes no claim about the dependency picker. Re-stamped.
- 2026-10-28T12:07:57Z: /projects row menu semantics (`frontend/src/app/projects/page.tsx`), truncated summary title (`frontend/src/components/ui/PageHeader.tsx`), board jump bar focus and 760 px breakpoint (`frontend/src/components/dashboard/BoardView.tsx`, `frontend/src/app/globals.css`), card top row wrap and the Spec badge `role="img"` (`frontend/src/components/ConfidenceBadge.tsx`). `frontend.md`: the column-gated `+` guard citation moved from `BoardView.tsx:293` to `:314`; no other claim describes these elements. Re-stamped.
- 2026-10-28T12:06:26Z: the engine derives the task states it writes or accepts from the task's workflow (`backend/src/services/grounding-github-webhook.ts` and `grounding-github-observation-context.ts`: terminal and request-changes targets from the definition, claims cleared in the same write, no write for a target the workflow lacks; the new `backend/src/services/task-status-input.ts` judges the status inputs of create, import, PATCH, the Grounding creation router (`backend/src/routes/grounding-creation.ts`) and the browse and claimable filters; MCP `tasks_transition`/`tasks_list` take free strings in `backend/src/routes/mcp.ts`; comments in `cli/src/api.ts` and `cli/src/index.ts`). `claim-model.md` drops the Grounding webhook exception and states the workflow-derived vocabulary (re-verified against the code). `architecture.md`: the creation router's access check is now `routes/grounding-creation.ts:37`. `workflow-gates.md`, `cli.md`, `permissions-model.md` and `signals-and-notification-delivery.md`: citations into `backend/src/routes/tasks.ts` re-pointed, claims unchanged. `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` cite the changed sources but make no claim about status vocabularies or the Grounding webhook writes; re-read, unchanged. All ten re-stamped. `auth.md` and `confidence-scorer.md` keep the staleness they already carry on master.
- 2026-10-28T11:43:56Z: team names also refuse tag characters, the implicit direction marks, interlinear annotation, invisible operators and unassigned code points, cap combining marks at 4 per character, and treat U+FFFC alone as blank (`backend/src/lib/team-name.ts`, mirrored blank class in `frontend/src/lib/teamName.ts`). `frontend.md`: the Team rename paragraph's blank-class list now names U+FFFC; the rest still holds. `permissions-model.md` makes no claim about the name characters and no cited line moved. Re-stamped `frontend.md`.
- 2026-10-28T11:31:35Z: unstorable client text answers 400 on every route (`backend/src/lib/error-handler.ts`: 22021, 22P05 and the Prisma unpaired-surrogate error map to `validation_error` through the exported `unstorableTextResponse`; `backend/src/routes/grounding.ts` and `backend/src/routes/grounding-migration.ts` run it first in their `onError`, every other error keeps its status). `backend.md` re-verified: its grounding route claim (lock-free admission read before the task lock, line 50) is unchanged, no cited line moved. Re-stamped.
- 2026-10-28T08:14:56Z: project hub title and Retry (`frontend/src/components/DocumentTitle.tsx`: the hook removes the head `<title>` it created when the document had none; `frontend/src/app/projects/[id]/_components/ProjectHubLayout.tsx`: Retry keeps the error shown and is busy until the reload settles). `frontend.md` re-verified: it names `ProjectHubLayout.tsx` only for the PageShell frame, which is unchanged, and makes no claim about the title mechanism or the hub Retry; the route segment list is unchanged. Re-stamped.
- 2026-10-28T07:55:01Z: team names also refuse separators, bidi controls, private-use and noncharacter code points, and the blank check covers combining marks, variation selectors, Hangul fillers and U+2800 (`backend/src/lib/team-name.ts`, mirrored in `frontend/src/lib/teamName.ts`); the "Team name" card input lost `maxLength` (`TeamNameSection.tsx`). `frontend.md`: the Team rename paragraph now names the blank class and the missing `maxLength`; the rest still holds. `permissions-model.md` makes no claim about the name characters and no cited line moved. Re-stamped `frontend.md`.
- 2026-10-28T06:16:29Z: dark-mode text colours (#684: `--primary-fg` token in `frontend/src/app/globals.css`, nine text rules use it, dark-only underline on `.prose-markdown a`). `frontend.md` re-verified: it cites `frontend/src/app` by path and makes no claim about colour tokens, link decoration or `globals.css` rules; the route segment list and page-frame claims are unchanged. Re-stamped.
- 2026-10-28T05:53:27Z: grounding attempt route precedence (`authorizeRouteIssue` in `backend/src/services/grounding-attempts.ts`: a merge-only token gets merge eligibility's own refusal; the claim check is the shared `holdsAnyClaim`; the docblock states the rule). `architecture.md:134` and `backend.md:50` cite `grounding-attempts.ts:78`, which is still the `admit` method after the added helper lines; neither doc makes a claim about admission precedence. Both re-stamped.
- 2026-10-28T05:50:41Z: team names follow one rule on create and rename (`teamNameSchema` in `backend/src/lib/team-name.ts`, used by `backend/src/routes/teams.ts`; control characters, unpaired surrogates and format-or-whitespace-only names are 400; the two team routes add a top-level `message` through `zValidate(..., { message: true })` in `backend/src/lib/z-validate.ts`), and the create and rename forms share the blank check (`frontend/src/lib/teamName.ts`, `TeamNameSection.tsx`). `permissions-model.md`: the team-rename claim (team `ADMIN` only, writes the name, never the slug, 400/403/404 ladder) still holds and no cited line moved. `frontend.md`: the Team rename paragraph (Save disabled for an empty, whitespace-only or unchanged name, server error shown in the card) still holds. Both re-stamped.
- 2026-10-27T16:58:24Z: Home links and test guards (#673 modal header padding in `frontend/src/app/globals.css`, #676 `ViewAllLink` in the Home widget headers, #678 Home widget footer row and empty-state actions in `frontend/src/app/home/page.tsx`, #675 team rename card, #677 test-only title helper and lint rule): `frontend.md` re-verified against `frontend/src/app`; the route segment list is unchanged (no segment added or removed), the Team rename paragraph and the Page frame list still hold, no claim describes Home widget links, the modal header or test helpers. Re-stamped.
- 2026-10-27T15:55:44Z: team rename: `PATCH /api/teams/:id` in `backend/src/routes/teams.ts` (team `ADMIN` only; writes the name, never the slug) and the "Team name" card on `/settings/team` (`frontend/src/components/settings/TeamNameSection.tsx`, `renameTeam` in `frontend/src/lib/api.ts`). `permissions-model.md` lists team rename among the human-only routes and names `teams.ts` as a source; `frontend.md` gains a "Team rename" paragraph and names the new component as a source, and its page-frame claim for `/settings/team` was re-read against the page and still holds. Both re-stamped; `backend.md`, `architecture.md` and `auth.md` make no claim about the team routes.
- 2026-10-27T11:11:31Z: Team and auth fixes (#663 dark `--muted` token, #662 workflow editor gated on the project access role, #664 page-held one-time token reveals in `frontend/src/app/settings/team/page.tsx`, #665 `/tasks` inline Retry after a dismissed load error, #666 onboarding shared-projects hint via `retrySharedProjects` in `frontend/src/lib/access.ts`, #667 a 401 on project load in the hub and `frontend/src/app/projects/[id]/board/page.tsx` goes to `/auth` with a validated way back, #668 one shell team list in `frontend/src/lib/teamList.tsx` read by the four team-scoped pages, and the in-app links that now carry `?teamId`): `frontend.md` re-verified against `frontend/src/app`, `tasks/page.tsx` and `board/page.tsx`; the route segment list, the two list views, the board view and the page frame list still hold, no claim describes team loading, sign-in redirects or link targets. Checked with `okf-kit check --require-anchors docs/okf`. Re-stamped.
- 2026-10-27T07:32:29Z: Layout consistency wave (#656 New team as an in-app dialog, `/onboarding` first-team only; #657 PageShell centres the 1200px column and the header bands align their inner content to it, `narrow` and `centered` removed, task detail and SSO on the default column; #658 `/home` and `/projects` on PageShell with a PageHeader band, shell loader on the same frame, `.page-shell` removed; #659 Home scope strip; #660 workflow redirect and settings loading frames, section-heading tokens). `frontend.md` re-verified against the merged code: the Page frame paragraph (variants `default`/`wide` in `PageShell.tsx`, `--page-column` on `.pshell--default`/`.pshell--wide`, PageShell on `/home`, `/projects`, `/tasks/[id]`, `/settings`, `/settings/team`, `/settings/team/sso` with `sso-content`, `/projects/workflow`, the `FullPageLoader` shell variant, no `.page-shell` left) and the route-segment list hold. Re-stamped.
- 2026-10-26T21:42:32Z: UX polish wave (#647 Home scoped widget requests and Active label, #648 PageShell frame, #649 team creation and governance labels, #650 Spec score badge, #651 narrow-screen overrides and board jump bar, #652 board card semantics, skip link and first-run state, #653 /tasks custom filter, row-action menu and the Table row guard for portaled events, #654 task copy, board ?taskId sync and page titles). `frontend.md` re-verified against the merged code: route segments unchanged; the `BoardView.tsx:293` citation is the column-gated `+` guard; the Page frame paragraph names `ProjectHubLayout.tsx` rendered by the segment layout; the two-list-views, create-modal, confidence-mirror (1290 lines), release and reassign claims hold. Corrected one claim that was already false before this wave: board cards never had promote/discard buttons, those live in the task detail header and the `/tasks` row-actions menu. Re-stamped.
- 2026-10-26T14:34:59Z: UI/IA waves 4 to 6 (#642 SSO page at `/settings/team/sso`; #643 team-less users on `/home`, `/projects` and `/tasks` via `frontend/src/lib/access.ts`, `getProjects(teamId?)` in `frontend/src/lib/api.ts`; #644 Home "Your projects" strip and board visit records in `frontend/src/app/projects/[id]/board/page.tsx`; #645 header nav Home | Projects | Tasks with team switcher, pages derive their team from `?teamId` including `frontend/src/app/tasks/page.tsx`). Re-verified `frontend.md` in the T17 sweep: route-segment list, the board-view gate in `BoardView.tsx`, the two independent list views and the source list hold. Re-stamped `frontend.md`.
- 2026-10-26T10:53:42Z: UI/IA wave 3 (#636 one header band with a project picker in `frontend/src/app/projects/[id]/layout.tsx` and `getProjects(teamId?)` in `frontend/src/lib/api.ts`; #637 personal `/settings` and `/settings/team`; #638 the projects list at `frontend/src/app/projects/page.tsx` with a `/teams` redirect in `next.config.mjs`, comments in `frontend/src/app/tasks/_components/columns.tsx`; #639 Overview tab dropped, `/projects/<id>` redirects to the board; #640 invite accept opens the board). Re-verified `frontend.md`: the route-segment sentence updated in #638 matches the tree after fixing two claims (`/teams/tokens` now redirects to `/settings/team`, and `settings` holds `team`), the two list views are still independent components, the board page still uses the `db-*` vocabulary and gates the effective-workflow fetch by `isProjectAdminRole`. Re-stamped `frontend.md`.
- 2026-10-26T09:54:19Z: UI/IA wave 2 (#632 current-team rule in `frontend/src/lib/currentTeam.ts` for `/home`, `/tasks`, `/teams`; #633 "API token" copy and the Projects nav label; #631 `/tasks/[id]` return path via `safeBackHref` in `frontend/src/lib/routes.ts`, touching `frontend/src/components/TaskDetail.tsx`; #634 the board moved to `frontend/src/app/projects/[id]/board/page.tsx`, `/dashboard` is a client redirect). Re-verified `frontend.md`: the two list views are still independent components (no shared list markup added), the effective-workflow fetch is still gated by `isProjectAdminRole` in the board page, and the source list and segment claims updated in #634 match the tree. Re-stamped `frontend.md`.
- 2026-10-26T07:36:06Z: UI/IA wave 1 (#627 login callbacks land on `/home` in `backend/src/routes/auth.ts` and `backend/src/routes/sso.ts`; #628 `GET /projects` and `/projects/available` in `backend/src/routes/projects.ts` list shared projects for humans without a team, OpenAPI `teamId` text in `backend/src/routes/docs.ts`; #629 `frontend/src/lib/routes.ts` URL builders replacing hand-built links across `frontend/src/app`). Re-verified: `permissions-model.md`, `backend.md` and `confidence-scorer.md` make no claim about the listing, `no_teams` or the login landing; `signals-and-notification-delivery.md` citation range into `projects.ts` was shifted in #628 and still matches (its older `tasks.ts` STALE line is the squash of #624, covered by the 2026-10-25T19:07:44Z entry); `architecture.md` makes no claim about the `teamId` parameter text; `frontend.md` claims hold (no shared list component introduced), its exact line counts for the two list pages were dropped because the restructure keeps changing them. Re-stamped all six.
- 2026-10-25T19:17:18Z: the workflow routes' default-row lookups (customize, apply-template, reset and their task selection, plus the effective-workflow reader) share one helper, `findFirstDefaultRow` in `backend/src/routes/workflows.ts` (oldest row by `createdAt`, then `id`, `FIRST_DEFAULT_ROW_ORDER`). `workflow-gates.md` gained one sentence saying customize, template application and reset act on that row. `claim-model.md` and `deploy.md` cite `FIXED_STATE_NAMES` and `workflowDefinitionSchema` in the same file, both unchanged; re-read and re-stamped all three.
- 2026-10-25T19:07:44Z: the legacy `POST /tasks/:id/review` approve in `backend/src/routes/tasks.ts` now clears the work and review claims in its compare-and-swap write when the target is terminal (`request_changes` clears the review lock only), and the header comment of `backend/prisma/clear-terminal-claims.sql` no longer names it as a writer the repair backs up. `claim-model.md` describes the new rule (one remaining exception, the Grounding webhook); the `signals-and-notification-delivery.md` anchor moved from line 8046 to 8047. Re-verified that `backend.md`, `cli.md`, `confidence-scorer.md`, `deploy.md`, `governance-merge.md`, `permissions-model.md`, `reconcile-done-but-open.md`, `task-lifecycle.md` and `workflow-gates.md` make no claim about the legacy approve's claim handling and cite no `tasks.ts` line after the edit; re-stamped all eleven. The older STALE entries on `claim-model.md` and `signals-and-notification-delivery.md` (sources dated 2026-10-24T11:12:58Z) are the squash merge of the zod 4 migration (#619), whose content the 2026-10-24T10:24:25Z entry covers.
- 2026-10-24T11:30:53Z: release cut, mcp-server 0.18.0 and mcp-bridge 0.11.0. `mcp-server.md` (both `SERVER_VERSION` and `package.json` literals, the release-entry sentence now names the zod 4 move) and `mcp-bridge.md` (`PACKAGE_VERSION` and the exact mcp-server pin) updated; `architecture.md`, `auth.md` and `release-flow.md` list the bumped files as sources but make no version claim, re-read and re-stamped with the other two.
- 2026-10-24T11:08:34Z: `mcp-server/CHANGELOG.md` zod bullets reworded (non-string URL inputs still report `invalid_type`; the inlined `$ref` is the priority list). `mcp-server.md` makes no claim about those bullets; re-read and re-stamped.
- 2026-10-24T11:01:11Z: `mcp-server/src/tools.ts` changed three comments only (the helper path now reads `src/zod-formats.ts`); no line count changed, the `project_tasks` description citation in `mcp-server.md` (:824) still resolves. `mcp-server/CHANGELOG.md` gained detail on the zod 4 issue codes. `mcp-server.md` and `task-lifecycle.md` make no claim about either change; both re-read for their tool-description claims and re-stamped.
- 2026-10-24T10:24:25Z: a review fix on the zod 4 migration (`backend/src/lib/zod-formats.ts`, `mcp-server/src/zod-formats.ts`) replaced `z.iso.datetime()` and `z.url()` at the `dueAt`, `expiresAt`, `prUrl`, webhook URL and env URL sites with the shared `isoDatetime` (zod 3 accept set, minute precision restored) and `urlString` (`URL.canParse`, value returned unchanged) helpers, built the `zValidate` 400 through the Hono context (`c.json`) so earlier response headers survive, and exported `createTokenSchema`. The 400 body is unchanged. Re-verified against the changed sources (`backend/src/routes/tasks.ts`, `backend/src/routes/mcp.ts`, `backend/src/routes/agent-tokens.ts`, `backend/src/config/index.ts`, `backend/src/lib/url-guard.ts`, `backend/src/lib/z-validate.ts`, `backend/src/services/grounding-route-effects.ts`, `backend/src/services/grounding-direct-input.ts`, `mcp-server/src/tools.ts`) and re-stamped: `architecture.md`, `auth.md`, `backend.md`, `claim-model.md`, `cli.md`, `confidence-scorer.md`, `deploy.md`, `governance-merge.md`, `mcp-server.md`, `permissions-model.md`, `reconcile-done-but-open.md`, `signals-and-notification-delivery.md`, `task-lifecycle.md`, `workflow-gates.md`. Citations into `backend/src/routes/tasks.ts` moved by one line (the new import) in `cli.md`, `permissions-model.md`, `signals-and-notification-delivery.md` and `workflow-gates.md`, and the `mcp-server/src/tools.ts` citation in `mcp-server.md` moved by three lines. `signals-and-notification-delivery.md` now says the webhook URL shape check is `URL.canParse` through `urlString` and the stored value is the unchanged input.
- 2026-10-24T09:11:35Z: the zod 3 to 4 migration (`backend/package.json`, `mcp-server/package.json`) changed schema code in the backend and in `mcp-server/src/tools.ts` and `mcp-server/src/errors.ts`: UUID, URL, datetime and email fields use the zod 4 format builders, records take two arguments, every route validates through the new shared wrapper `backend/src/lib/z-validate.ts` instead of calling `zValidator` itself, the `templateData` string-or-list union keeps its message through the `error` parameter and its 200-entry cap through a refinement, the workflow update schema keeps `isDefault` a plain optional, two grounding bodies are parsed per branch, and the MCP generic issue summary reads enum options from both the zod 3 and the zod 4 issue shape. The 400 body of a failed validation is unchanged (`success: false`, `error` with `issues` and `name: "ZodError"`). Re-verified against the changed sources and re-stamped: `architecture.md`, `auth.md`, `backend.md`, `claim-model.md`, `cli.md`, `confidence-scorer.md`, `deploy.md`, `governance-merge.md`, `mcp-server.md`, `permissions-model.md`, `reconcile-done-but-open.md`, `signals-and-notification-delivery.md`, `task-lifecycle.md` and `workflow-gates.md`. None of them states a validation mechanism, a zod version or the validation error body, so no sentence changed for the migration itself; their claims about the touched routes and services (route behaviour, scopes, URL scheme check in `httpUrl`, config fail-fast, `workflowDefinitionSchema`, the claim gate call sites) were read against the new code and hold. Two citations moved: `confidence-scorer.md` cites the `SECTION_ALIASES` table of `backend/src/lib/confidence.ts` at 243-264 (was 226-247; the inserted union code shifted it, the table still equals the frontend range 297-318) and its line count is 1657; `mcp-server.md` cites the `project_tasks` description at `mcp-server/src/tools.ts:821` (was 811). `confidence-scorer.md` and `reconcile-done-but-open.md` also carried older staleness findings (`backend/src/routes/tasks.ts`, `backend/src/services/default-workflow.ts`, `backend/src/services/grounding-completion.ts`, `backend/src/services/grounding-context.ts`); for them the commits since their last stamp were read: the claim gate is still called only from the `start` and `claim` routes after the dependency check, the standalone task merge still requires a review-like state of the task's workflow (`isReviewState` in `resolveTaskMergeTarget`), the claim-clearing constants moved to `backend/src/services/task-claim-fields.ts` without changing, and the default-row order only affects projects holding several defaults. Both are re-stamped and no longer stale. The `docs.ts` closing-brace citations in this log keep their earlier findings.
- 2026-10-23T11:10:53Z: the default-workflow readers now share one order for a project that holds more than one default row (`FIRST_DEFAULT_ROW_ORDER` in `backend/src/services/default-workflow.ts`: oldest first, ties by id), matching the claim repair `backend/prisma/clear-terminal-claims.sql`: `resolveEffectiveDefinition`, `resolveProjectEffectiveDefinition`, `loadWorkflowRows` in `backend/src/services/workflow-status-filter.ts` and `GET /projects/:projectId/effective-workflow` in `backend/src/routes/workflows.ts`. `claim-model.md` and `workflow-gates.md` state the order. `claim-model.md` also names the two writers that still leave a claim on a finished task (the legacy review approve keeps the work claim; the Grounding GitHub webhook writes the terminal status without clearing), and the header of the repair names the deploy repair as their backstop. In `backend/src/routes/tasks.ts` only the comment above the creator-abandon schema changed, with the same number of lines, so no citation moved. `backend.md`, `cli.md`, `deploy.md`, `governance-merge.md`, `permissions-model.md`, `signals-and-notification-delivery.md` and `task-lifecycle.md` were re-read for claims about the changed files (their claims about the lookups name the project default without an order, and the repair appears only by its place in the migrate command and `db:push`) and need no wording change. All nine docs were re-stamped after the last source commit; `confidence-scorer.md` and `reconcile-done-but-open.md` keep their earlier staleness findings.
- 2026-10-23T10:29:43Z: the remaining engine paths that compared a task's status with the literals `review` and `done` now read the review-like and terminal states of the task's own workflow, and every write that ends a task clears the work claim and the review claim (`backend/src/routes/tasks.ts`, `backend/src/routes/github.ts`, `backend/src/routes/invites.ts`, `backend/src/services/github-webhook.ts`, `backend/src/services/default-workflow.ts`, `backend/src/services/workflow-status-filter.ts`, the new `backend/src/services/task-claim-fields.ts`, the merge status gate, the Grounding review-state checks and the new data repair `backend/prisma/clear-terminal-claims.sql`, run by `Dockerfile.migrate` and `backend/package.json`). `claim-model.md` (signal staleness, review pool, dependency gate, member removal, a new paragraph on finished tasks carrying no claim; two sources added), `task-lifecycle.md` (`task_merge` status rule and written state, the finish names), `governance-merge.md` (legacy webhook claim clearing, task-merge and GitHub merge routes, standalone merge review state), `workflow-gates.md` (the GitHub merge route no longer leaves claims in place), `signals-and-notification-delivery.md` (signal staleness and acknowledgement), `deploy.md` (the second SQL file in the migrate command and in `db:push`; one source added) and `backend.md` (review state of the standalone merge) were edited against the changed code. `architecture.md`, `cli.md` and `permissions-model.md` were re-read for claims about the changed files and need no wording change. The inserted imports and the new code moved later lines: the citations into `backend/src/routes/tasks.ts` that no longer resolved in `cli.md`, `permissions-model.md`, `signals-and-notification-delivery.md` and `workflow-gates.md` were re-pointed after reading the target lines (ranges moved with their start line), and the plain `routes/github.ts:N` line references in `architecture.md`, `backend.md`, `governance-merge.md` and `workflow-gates.md` moved by one or two lines (the later ones by one, because the merge route lost a line). All ten docs were re-stamped. `confidence-scorer.md` and `reconcile-done-but-open.md` also list changed sources; they already carried a staleness finding from earlier changes and were not re-read or re-stamped.
- 2026-10-23T05:27:33Z: `backend/src/routes/mcp.ts` changed only in the JSDoc of the per-request server factory (the tool count now says 26, matching the registered tools and the count `backend/tests/unit/mcp-route.test.ts` pins). `architecture.md`, `auth.md` and `claim-model.md` list it as a source; their claims about the route (in-process `callSelf` dispatch, `resolveOperationKey`, the `tasks_list` cursor and sort forwarding) were re-read and are unchanged, no citation line moved. All three re-stamped.
- 2026-10-23T05:21:20Z: `deploy.md` describes the prod compose hardening: explicit project names (`agent-tasks` for the prod file, `agent-tasks-dev` for the dev file), a backend healthcheck on `/api/health`, `json-file` log rotation per service, the `APP_DOMAIN` override, four more forwarded backend settings, and the `TRUSTED_PROXY_HOPS` dev default of 0. `backend/src/config/index.ts` now maps an empty `BACKEND_URL`, `REDIS_URL` or `IDEMPOTENCY_TTL_DAYS` to unset; `docker-compose.yml` and that file were added to the `deploy.md` sources. `backend.md` (config sentence: Zod schema, fail-fast on invalid values, still true), `governance-merge.md` (lists the file as a source, makes no claim the change touches) and `architecture.md` (prod topology sentence unchanged) were re-verified against the changed sources and re-stamped.
- 2026-10-23T04:59:17Z: `architecture.md` and `frontend.md` re-verified and re-stamped after the `next` floor in `frontend/package.json` rose from `^15.5.27` to `^15.5.28`. Both name the dependency as `next@^15`, which the new floor still satisfies; no other claim touches the changed line.
- 2026-10-21T05:22:00Z: `workflow-status-filter.ts` now judges a workflow row whose stored definition cannot be read by the built-in definition's states (it used to yield no states, which dropped the review branch and let a finished task bind again). `claim-model.md` (review-pickup and hard-limit paragraphs) and `governance-merge.md` (webhook lookups) were re-read against the changed helper and state this fallback; `claim-model.md` also names which free-edge workflow shapes stop offering `review` and which start offering `in_progress`. Both were re-stamped; no citation line moved.
- 2026-10-21T04:59:16Z: the review pickup, the single-active-claim check and the GitHub webhook lookups read review-like and terminal states per task workflow (new `backend/src/services/workflow-status-filter.ts`). `claim-model.md` names the helper and the per-workflow rule in its review-pickup and hard-limit paragraphs (and is re-stamped); `governance-merge.md` states that the webhook lookups skip the terminal states of the task's own workflow and `backlog`, and is re-stamped; `signals-and-notification-delivery.md`, `task-lifecycle.md`, `workflow-gates.md`, `cli.md` and `permissions-model.md` were re-verified against the changed pickup and start code (their pickup, start, webhook-writer and signal claims are unchanged: the stale-signal filter still reads `done`, and the single-active-claim rule is unchanged in outcome) and re-stamped. For the three docs that were already stale for `routes/tasks.ts` (`claim-model.md`, `cli.md`, `permissions-model.md`) the only commits since their last stamp that touch it are the task-search LIKE escape on the team listing, the debug finish gate without a session phase, and this change; none of them is a claim of those docs. Line citations into `backend/src/routes/tasks.ts` in `cli.md`, `permissions-model.md`, `signals-and-notification-delivery.md` and `workflow-gates.md` were re-pointed to the shifted lines; the two `Requires write access` citations in `permissions-model.md` were also off by ten lines before this change and now cite the right blocks.
- 2026-10-18T05:43:39Z: `architecture.md` re-stamped after the merge status gate's describe text and its OpenAPI copy in `backend/src/routes/docs.ts` were reworded to name the status rule per route (`pull_requests_merge`: review or terminal state of the task's workflow; `task_merge`: literal `review` / `done`). The doc cites `docs.ts` only for the Swagger UI route; that claim was re-checked and is unchanged.
- 2026-10-18T05:35:08Z: the merge status gate's describe text (`backend/src/services/gates/task-status-for-merge.ts`, copied in the OpenAPI effective-gates example in `backend/src/routes/docs.ts`) and the `task_merge` tool description in `mcp-server/src/tools.ts` changed wording only: the gate now says a review state or terminal state of the task's workflow (`review` / `done` in the default workflow), and `task_merge` names `governanceMode` AUTONOMOUS (legacy `soloMode` only a fallback) as the self-merge switch. The comment above the tool gained one line, so the `mcp-server.md` citation of the `project_tasks` description moved from :810 to :811 (re-pointed after reading the target line). `mcp-server.md`, `task-lifecycle.md` and `architecture.md` were re-read for claims about the changed text and the new `mcp-server/CHANGELOG.md` line: `task-lifecycle.md` says `task_merge` requires `review` or `done`, which still matches the task route (it compares the literals); `architecture.md` cites only the `/docs` route line in `docs.ts`, which did not move; `mcp-server.md` makes no claim about `task_merge` wording. All three were re-stamped. `backend.md` already carried staleness findings from earlier changes and was not re-read or re-stamped.
- 2026-10-17T10:17:27Z: the merge status gate, the distinct-reviewer branch of `POST /github/pull-requests/:n/merge` and the legacy webhook decisions now read review-like and terminal states from the task's effective workflow definition instead of the literals `review` and `done` (`backend/src/services/gates/task-status-for-merge.ts`, `backend/src/routes/github.ts`, `backend/src/services/github-webhook.ts`). The inserted import block and the post-merge status variable moved the later `backend/src/routes/github.ts` lines: the six citations in `architecture.md`, `backend.md`, `governance-merge.md` and `workflow-gates.md` (the grounding-guard condition, the manual-redirect option and the redirect refusal in the create and merge handlers) were re-pointed after reading each target line at the new position. `workflow-gates.md` and `governance-merge.md` now say the webhook targets and the merge route's written status come from the effective workflow (`done`, `review` and `in_progress` for the built-in one), `signals-and-notification-delivery.md` names a terminal state instead of `done` for the webhook acknowledgement. `backend.md` got only the four re-pointed citations and keeps its earlier timestamp: it was not re-read against `backend/src/routes/tasks.ts` and `backend/src/services`, so its staleness warnings stand. `architecture.md`, `governance-merge.md`, `signals-and-notification-delivery.md` and `workflow-gates.md` were re-read for the claims about the three changed source files and re-stamped. Three of them also list `backend/src/routes/tasks.ts` as a source; for it, the diff since their previous stamp (the `%` and `_` escaping of the task search, and the debug finish gate that no longer requires a session phase) was read and none of the three makes a claim about either, so the stamp covers that source too. The prose line references of `workflow-gates.md` into `backend/src/routes/tasks.ts` (the call sites of `evaluateV2TransitionGates`, the `PATCH`, `/transition` and force lines, and the cross-repo guard sites) had drifted by three to six lines; each target was read at its new position and the references are now anchored backtick citations that `okf-kit check --require-anchors` verifies. `claim-model.md`, `permissions-model.md` and `reconcile-done-but-open.md` list the changed files as sources but make no claim about the changed behaviour and were not re-stamped.
- 2026-10-17T09:48:42Z: `backend.md` body edit without a re-stamp: the gate-registry paragraph now says the debug finish gate requires a session and a ledger entry and no phase, and that the phase allowlist applies only to LEGACY_LOCAL cohort completion and migration (checked against `backend/src/services/gates/grounding-gate.ts` and the finish route in `backend/src/routes/tasks.ts`). The rest of the doc was not re-verified, so its timestamp and its staleness against `routes/tasks.ts` stay.
- 2026-10-16T08:15:42Z: `frontend.md` re-verified after `frontend/src/app/layout.tsx` switched to self-hosted fonts; the doc makes no claim about fonts or the root layout. Re-stamped.
- 2026-10-16T08:15:04Z: `deploy.md` lists the frontend job's new vendored-fonts guard step (the frontend now loads self-hosted fonts); re-verified against `.github/workflows/ci.yml`, the cited matrix lines still resolve. `release-flow.md` re-verified: its only `ci.yml` claim (the root release runs the shared `ci.yml` via `workflow_call`) is unchanged. Both re-stamped.
- 2026-10-12T09:04:00Z, release cut mcp-server 0.17.0 and mcp-bridge 0.10.0: `mcp-server.md` names `SERVER_VERSION` and `mcp-server/package.json#version` as `"0.17.0"` (anchor re-pointed to the new literal) and points at the `## 0.17.0` CHANGELOG entry, with the reason for the minor bump rewritten (no breaking change this time); `mcp-bridge.md` names `PACKAGE_VERSION` `"0.10.0"` and the exact pin `"0.17.0"`; `release-flow.md`, `auth.md` and `architecture.md` were re-verified against the moved pin and version constant (no claim names either value) and re-stamped together with `mcp-server.md` and `mcp-bridge.md` (`architecture.md` in a follow-up commit).
- 2026-10-11T18:50:22Z, task 8908e2a2: `templateData` spec fields accept a string or a list of strings (`templateDataStringField` in `backend/src/lib/confidence.ts`), and the OpenAPI document splits the request-side `TemplateDataInput` from the string-only response `TemplateData` (`backend/src/routes/docs.ts`). `confidence-scorer.md` states the list form and the 200-entry cap, and its `SECTION_ALIASES` citation and line count moved with the inserted code (re-pointed after reading the target lines). `architecture.md`'s Swagger UI citation moved from :2063 to :2090 (the `/docs` route line, read after the edit). `task-lifecycle.md` states the list form for `task_create` and `task_respec`. `mcp-server.md` was re-verified against `mcp-server/src/tools.ts` and `mcp-server/CHANGELOG.md`: only the `templateData` tool descriptions and one `Unreleased` line changed, and no claim in the doc names them. All four were re-stamped.
- 2026-10-11T17:28:18Z, documentation drift audit, `deploy.md` re-verified against `docs/deploy-verify-strategy.md`, which now says that only `POST /api/projects/:projectId/workflows` and `PUT /api/workflows/:id` validate state names and that `customize` and `apply-template` copy a four-state definition, and against `backend/src/routes/workflows.ts` and `backend/src/services/workflow-templates.ts` (joined its sources; only the two four-state templates are registered): its fixed-state sentence now says the same, and its design-decision, `done` and tracking-outside-status claims still match. Body edits without a re-stamp (their sources did not change; the edited sentences were checked against the code): `permissions-model.md` says that an agent token never satisfies a concrete role (`hasProjectRole` in `backend/src/services/team-access.ts`) and that `requireScope` (`backend/src/middleware/auth.ts`) refuses humans; `signals-and-notification-delivery.md` says that a backlog promote sends no `task_available` (`backend/src/routes/tasks.ts`, `backend/src/services/grounding-route-effects.ts`) and lists `task_force_transitioned` on the grounding route plan; `index.md` says that the literal guard fails when a quoted literal no longer occurs in its cited range and never reads timestamps (`backend/tests/unit/docs-okf-literal-guard.test.ts`). Re-stamped: `deploy.md`. Checks: `okf-kit check --json --require-anchors docs/okf`, no errors and no STALE doc; `npm run test --workspace=backend -- tests/unit/docs-okf-literal-guard.test.ts`, passed.
- 2026-10-11T17:28:18Z, the tracker, PR and task references that the earlier bundle upkeep removed from doc bodies, kept here per doc. `auth.md` and `mcp-bridge.md`: the keychain `MultiSourceStore` that replaced the one-time startup probe came with #403 (2026-07-14), and the bridge's `legacy` option with #440 (rc-v1-C007). `claim-model.md`: `abandoned` counts as a resolved blocker since task 5200f326, `POST /tasks/:id/creator-abandon` came with task 7a1360da (also named in `task-lifecycle.md`), and the CLI id-prefix resolver change with the matching `CLAIMABLE_VALID_STATUSES` change was the D18 revision. `confidence-scorer.md`: the per-task-type thresholds and risk modifiers came with #462, #463, #465 and #471, the frontend Improvement panel with #470, the keystone-blocking warning helper with #494, and the scorer parity test with #450 (task 79621590). `deploy.md`: the `docker-smoke.yml` frontend smoke came with PR #456, and it and the frontend container healthcheck followed the 2026-08-17 outage, a green backend with a crash-looping frontend. `mcp-server.md`: the read-verb projection layer is task 3653962f, the `truncated` flag task e36696d7, rc-v1-C002 through C007 landed without a version or CHANGELOG bump and rc-v1-C008 bumped both version constants to 0.13.0 and wrote the series' CHANGELOG, 0.14.0 was cut by commit a1a4b9a (PR #478, 2026-08-20), and 0.15.0 is task f82bdbcc. `release-flow.md`: the `SERVER_VERSION` equality test exists since #396 (2026-07-04). `workflow-gates.md`: the status compare-and-swap came with agent-tasks e4e27a39 and f1c8c7c1, the claim-guarded and legacy writers with 21446d1a, the merge reservation with eb08742f and the no-PR task classes with 5107416c; the citation-audit mechanism it pointed to is agent-dx task 2e7680f6. `index.md`: its earlier Maintenance text is kept in the `index.md` entry below.
- 2026-10-11T16:44:20Z, documentation drift audit, `deploy.md` re-verified against `docs/deploy-verify-strategy.md`, `backend/src/routes/workflows.ts` and `backend/src/services/default-workflow.ts`: the workflow API accepts only the states `open`, `in_progress`, `review` and `done` (`FIXED_STATE_NAMES`, `workflowDefinitionSchema`), so the custom deploy-state workflow example and the advice to create one through `POST /api/projects/:projectId/workflows` were removed; the doc now says deploy and verify are tracked outside task status. The meaning of `done` now names review approval, the PR merge paths and the `in_progress → done` edge of the default workflow. The two code files joined its sources. Re-stamped. Checks: `okf-kit check --json --require-anchors docs/okf`, no error, no STALE doc and no warning added over the previous commit; `npx vitest run tests/unit/docs-okf-literal-guard.test.ts` in `backend/`, passed.
- 2026-10-11T16:23:50Z, documentation drift audit, new bundle docs: `signals-and-notification-delivery.md` (signal types and recipients, the pull inbox, acknowledgement before outcome signals on done, webhook push delivery with the egress guard), `permissions-model.md` (team and per-project roles, the `hasProjectAccess`, `requireProjectWrite` and `hasProjectRole` tiers, where each token scope is checked, agent-only and human-only routes) and `cli.md` (v2 verbs and deprecated aliases, task-id prefix resolution, operation keys, the two `tasks list` modes, config precedence, no publish workflow). Each claim was read against the cited code; the proposed claim-gate doc and the proposed GitHub webhook ingest doc were not created, because the bundle upkeep already added those topics to `confidence-scorer.md` and `governance-merge.md`. `index.md` lists the three docs, and `architecture.md` now points to `cli.md` for the fifth workspace. Checks on the committed tree: `okf-kit check --json docs/okf` is clean, `okf-kit check --json --require-anchors docs/okf` adds no warning over the previous commit, and the backend `docs-okf-literal-guard.test.ts` passes.
- 2026-10-11T16:10:03Z, documentation drift audit, bundle upkeep: `architecture.md` gained a client-path paragraph and flowchart (the CLI, mcp-bridge, mcp-server and the remote `/api/mcp` route all pass one `authMiddleware`) and lists the client and auth files it names as sources. `confidence-scorer.md` gained a claim-time enforcement section (`enforcementMode` OFF/WARN/BLOCK with WARN as the default, layered threshold plus risk modifiers, the evals keystone, the `confidence:override` force path, the BLOCK flip acknowledgement) with the gate, evaluator, mode, scope, error, projects and tasks files as sources; its frontend `SECTION_ALIASES` citation now points at the table's current lines (the backend range was re-read and the two tables compared with `diff`, identical), and its `confidence.test.ts` quote now matches the file. `governance-merge.md` gained the legacy webhook ingest paragraph (`routes/webhooks.ts`, `idempotency-sweep.ts`, `server.ts` and `config/index.ts` joined its sources). `release-flow.md` states that the `cli` workspace has no publish tag axis (`cli/package.json` joined its sources). `claim-model.md` and `task-lifecycle.md` say that `POST /tasks/pickup` serves a human caller its own oldest pending signal before the `400`. `deploy.md` names `POST /api/projects/:projectId/workflows` for a custom workflow and the `review` step outside `AUTONOMOUS`, re-checked against `docs/deploy-verify-strategy.md`. `backend.md`, `claim-model.md`, `governance-merge.md` and `workflow-gates.md` list `backend/src/services/github-webhook.ts` or `docs/grounding-receipt-contract.md`, which changed in the same branch (a header comment, the direct attempt route row); none of their claims or line citations depended on the changed lines, and `backend.md`'s `routes/tasks.ts` size note was updated. Tracker and task ids, PR numbers, dates and milestone labels were removed from the bodies of these docs and of `auth.md` and `mcp-server.md`. `auth.md` was re-read in full against its sources (token store, bridge CLI, client headers and keyed tools, auth middleware, `AgentToken` model, which the merge-reservation schema change did not touch); `mcp-server.md` was not re-verified and keeps its timestamp. Re-stamped: `architecture.md`, `auth.md`, `backend.md`, `claim-model.md`, `confidence-scorer.md`, `deploy.md`, `governance-merge.md`, `mcp-bridge.md`, `release-flow.md`, `task-lifecycle.md`, `workflow-gates.md`. Checks: `okf-kit check --json docs/okf`, no errors and no STALE doc; `npx vitest run tests/unit/docs-okf-literal-guard.test.ts` in `backend/`, passed.
- 2026-10-11T16:10:03Z, `index.md` Maintenance trimmed to the guard rule; the decision history it carried is kept here as it stood:

  **Quoted-literal drift guard (T-007, agent-tasks tracker 3feb590f)**: okf-kit's `sources-fresh` check compares a doc's frontmatter `timestamp` to its sources' last-commit time; a green run after a re-stamp proves the doc was touched, not that its claims are still true. Batch-43 (task 8a1c4c52, PR #509) shipped two now-fixed claims a re-stamp missed this way: `SERVER_VERSION` quoted as an old value after the source moved on, and a teaching-error `allowedNext` array quoted with the wrong verbs. Three options were weighed for closing that gap:

  - **(a) In-repo test, adopted** (`backend/tests/unit/docs-okf-literal-guard.test.ts`, helper in `backend/tests/helpers/okf-literal-guard.ts`): for every markdown block (a blank-line-delimited run of lines) carrying at least one backtick line citation (`path:N`/`path:N-M`, with or without a `#"anchor"`), every VALUE literal in that block (a semver, a quoted string, a JSON-shaped bracket/brace literal, or a `key: value` pair; a bare identifier such as `fooBar`/`foo()`/`Foo.bar` is never checked) must occur, verbatim modulo whitespace, in the source lines of a citation within a word-proximity window of it (`WORD_WINDOW` in `backend/tests/helpers/okf-literal-guard.ts`, currently 30 words, tunable there) on either side, inside the same block. Who pays: doc authors get flagged when an unallowlisted literal drifts from its cited source; readers get a guard that fails on real drift instead of a green `sources-fresh` run that only proves a timestamp moved. False-positive risk: a block that states several literals in one long sentence but cites only one of them can pair a literal with an unrelated nearby citation purely by word proximity; each such case is covered by an allowlist entry (doc, paragraph anchor, literal, reason). More than ten allowlist entries would mean the heuristic no longer fits this bundle, and the decision falls back to (c). `log.md` narrates history (now-superseded values); its literal count is measured but never asserted, the same exemption the bare-citation guard already gives it. Matching is substring-based (`includes()`), which also has a false-negative direction: a short literal (say a two-word `key: value` pair) inside a wide citation window can be silently "verified" by an unrelated in-window line that happens to contain that exact substring. A bare semver is the one kind this guard closes with a boundary check (`0.14.0` no longer matches inside a cited `0.14.0-rc1`); the same substring risk for quoted strings, JSON-shaped literals, and `key: value` pairs is accepted, not fixed.
  - **(b) okf-kit rule proposal**: file the same semantics as an opt-in okf-kit check. Who pays: okf-kit maintainers would own and version the rule for every consuming bundle; not filed for this task (scope: agent-tasks docs/okf only).
  - **(c) Process only**: re-stamp briefs require every quoted literal to be diffed against its cited line, plus a reviewer read of the sources (already the batch-43 practice). Who pays: every future re-stamp author and reviewer, by discipline rather than a mechanical check; this is the fallback if (a)'s allowlist ever needs more than ten entries.

  **Required-status decision**: `.github/workflows/okf-literal-guard.yml` carries no `paths:` filter and runs the guard test on every `pull_request` and every push to `master` under the stable job name "docs/okf literal guard", so it is safe to add to branch protection's required-status list -- a required check that never triggers on some PRs would block them forever, which an always-running trigger cannot do. Who pays: one repo-root `npm ci` (all workspaces) plus a sub-second test run on every PR; and, because the guard checks the whole bundle on every run, any PR that shifts a cited source line, even with no docs change, turns the check red and, once it is required, must re-verify and re-stamp the citation before it can merge (the guard working as designed; a path filter is what would hide that drift). A path-filtered revision with a skip-shim was tried and rejected; the CHANGELOG entry for task 5e95e4bd carries that history. The branch-protection edit itself (adding "docs/okf literal guard" to the required-status-checks list for `master`) is a separate operator action, not made by this task.

- 2026-10-10T17:44:12Z, task 31faaf27: `POST /tasks/:id/abandon` (`routes/tasks.ts`) now answers with `inReviewState` like `/release`; the edit swaps one response line, so no `routes/tasks.ts` line moved and the `workflow-gates.md` citations still hold. `claim-model.md` lists `abandon` among the routes that carry the flag and names the new Postgres test `tests/integration/pinned-workflow-claim-release.test.ts`; `task-lifecycle.md` states the flag on the `task_abandon` 200. `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `workflow-gates.md` list `routes/tasks.ts` as a source, were re-read against the change and make no claim it touches; re-stamped.
- 2026-10-10T14:46:00Z, `frontend.md` (re-verify): every claim re-read against the frontend sources at head. Route segments, the two route handlers, the `BoardView.tsx:197` create-button gate, the create-modal defaults, the 845/739/1290 line counts, the mirror comments and the reassign-picker claims all still hold. Added a paragraph on the sidebar `Release` control (disabled with a reason in a review state, driven by the server-computed `inReviewState` with a `status === "review"` fallback) and on the effective-workflow fetch, which now runs for project admins only; `TaskDetail.tsx` is named by its path (`components/TaskDetail.tsx`); `status.ts`, `TaskDetail.tsx`, `tasks/_components/columns.tsx` and `tasks/[id]/page.tsx` added to `sources`. Re-stamped.
- 2026-10-10T14:31:02Z, task 1d3fe7c6 (fix round): `resolveEffectiveDefinition` (`services/default-workflow.ts`) now loads the pinned workflow row by id when the task was fetched without the `workflow` relation, so `/release` and `/abandon` judge a pinned task on its own workflow like the `inReviewState` flag does; `claim-model.md` says so next to the flag sentence. The comment route lost its own lookup, which moved the later `routes/tasks.ts` lines up by 6, so the four affected `workflow-gates.md` citations (the `/claim` gate call, the `/transition` route, its force check and its forced audit action) were re-pointed by reading each target line at head. `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` list the edited files as sources, cite no moved line and make no claim the change touches; re-read and re-stamped.
- 2026-10-10T13:15:00Z, `workflow-gates.md`: four `routes/tasks.ts` citations in the 422-shape paragraph corrected after the pickup comment grew by two lines (`evaluateV2TransitionGates` ~2806, the `/transition` route ~7591, the `isProjectAdmin` force check ~7622, the `task.transitioned.forced` audit action ~7842); each target line read at head. Re-stamped.
- 2026-10-10T14:14:31Z, task 1d3fe7c6: the single-task responses the task view reads (`routes/tasks.ts`: `GET /tasks/:id` and the `start`, `claim`, `release`, `admin-release`, `admin-reassign`, `transition`, `review` and `PATCH` responses) now carry a server-computed `inReviewState`, resolved from the task's effective workflow by `isTaskInReviewState` (`services/default-workflow.ts`). `claim-model.md` gained a sentence on it next to the `/release` review-state refusal. `workflow-gates.md`, `task-lifecycle.md`, `backend.md`, `governance-merge.md` and `reconcile-done-but-open.md` list the edited files as sources and were re-read against the change: the edit swaps single response lines and one import entry inside `routes/tasks.ts` (no line moved, so the `workflow-gates.md` line citations still hold) and appends one function pair to `default-workflow.ts` (no cited line sits below it), and none of them describes the task response shape. Re-stamped.
- 2026-10-10T11:53:19Z, task 164f715c (fix round): `claim-model.md` now calls `/tasks/claimable` the listing behind the web UI, the CLI and the deprecated MCP `tasks_list` instead of only the human and CLI listing. The block comment above `POST /tasks/pickup` (`routes/tasks.ts`) gained the review-holder skip in its item 3, which moves every later `routes/tasks.ts` line by 2, so the `workflow-gates.md` citations (the `evaluateV2TransitionGates` definition and its callers, the `/transition` route, its force check and forced audit action, the `PATCH` route and its rule call, and the cross-repo guard calls) were re-pointed by reading each target line at head. `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` list `routes/tasks.ts` as a source, cite no line of it and make no claim the change touches, so they were re-read and re-stamped without content change.
- 2026-10-10T11:04:35Z, task 0b045884 (re-point): `workflow-gates.md` cited `routes/tasks.ts` by line, and the `/start` select change plus the merge of the `/release` fix moved every cited line. All fifteen citations were re-read at their new positions and re-pointed (the `/transition` route citation was already off before this task and now names the `taskRouter.post(` line). Re-stamped.
- 2026-10-10T11:39:06Z, task 164f715c: `POST /tasks/pickup` (`routes/tasks.ts`) no longer offers an open task whose review lock the caller holds when the project requires a distinct reviewer, using the predicate (`reviewHolderBlockedFromWorkClaim`) that `/claim` and `/start` share; `claim-model.md` step 3 says so. `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md`, `task-lifecycle.md` and `workflow-gates.md` list `backend/src/routes/tasks.ts` as a source and were re-read against the change, with no content change beyond `workflow-gates.md`, whose cited `routes/tasks.ts` line numbers were re-pointed after the added lines.
- 2026-10-10T10:28:07Z, task 0b045884 (fix round): `POST /tasks/:id/start` selects `governanceMode` in its pre-lock project read (`routes/tasks.ts`), like `/claim`, so the pre-lock and in-lock review-holder checks resolve the same mode. `claim-model.md` now describes the earlier `/release` of a task in review as the past source of the stale rows (initial state, no work claim, review lock set) instead of a current path, and names the `governanceMode` read and the directly seeded test; `workflow-gates.md` (claim-guarded writers) says `/release` is the example that does not depend on the other claim while the work branch of `/start` and `/claim` do and re-check the review holder in the locked revalidate; `task-lifecycle.md` re-read, its `task_start` line matches the route and the `mcp-server/src/tools.ts` description. `backend.md`, `governance-merge.md` and `reconcile-done-but-open.md` list `routes/tasks.ts` as a source, cite no line of it and describe nothing this change touches. No citation moved. `mcp-server.md` lists `mcp-server/src/tools.ts` and `errors.ts` but was already stale before this change and is not re-stamped here.
- 2026-10-10T10:16:56Z, task 8e833e58 (re-stamp): `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md`, `task-lifecycle.md` and `workflow-gates.md` list `backend/src/routes/tasks.ts` as a source and were re-read after the fix round added a second `409` message to `/release` (a caller who also holds the review claim is pointed to `/abandon`). The added lines sit inside the `/release` handler; none of these docs cites that handler or a line after it, so no citation moved. Re-stamped.
- 2026-10-10T10:11:11Z, task 8e833e58 (fix round): `POST /tasks/:id/release` classifies review states through the effective workflow definition (a custom review-like state name is refused too) and refuses unconditionally, unlike `/abandon`, which lets an actor holding both claims drop them; a caller that also holds the review lock gets a 409 message naming `/abandon` (`task_abandon`). `claim-model.md` reworded accordingly. `architecture.md` re-verified against `backend/src/routes/docs.ts` (the OpenAPI description of the route changed): its Swagger-page citation is `docs.ts:2063` (the `/docs` handler; 2061 is the `/api/docs` redirect), corrected; the rest of its claims match.
- 2026-10-10T10:00:42Z, task 8e833e58: `POST /tasks/:id/release` (`routes/tasks.ts`) now refuses a work claim while the task is in a review state with a `409 bad_state`, like `/abandon`, instead of resetting the status and leaving the review lock behind. `claim-model.md` gained a paragraph on the refusal and `task-lifecycle.md` and `workflow-gates.md` one sentence each; `backend.md`, `governance-merge.md` and `reconcile-done-but-open.md` list `routes/tasks.ts` as a source, cite no line of the release route and make no claim the change touches, so they were re-read and re-stamped without content change. `architecture.md` (source `routes/docs.ts`, whose `/release` description gained a sentence) and `mcp-server.md` were not re-stamped: both already carried STALE findings from other sources that this change does not verify.
- 2026-10-10T09:57:46Z, task 0b045884: the work branch of `POST /tasks/:id/start` (`routes/tasks.ts`, reason `task_start_work_claim`, used by the MCP `task_start` verb) now refuses the review holder as work claimant under a distinct-reviewer project, on the pre-lock read ahead of the dependency, confidence and transition-rule gates (a specific `409 bad_state`, the text `/claim` uses, now one constant) and again in the locked revalidate; the same review-holder stand-in helper serves `/claim`, `/start` and `admin-reassign`. `claim-model.md` gained a paragraph on it, `task-lifecycle.md` notes the refusal on the open-task branch of `task_start`, and `workflow-gates.md` says that `/start` reaches its lost-race text only for a lost race and has its `routes/tasks.ts` line citations (the `evaluateV2TransitionGates` definition and its `/start`, `/finish` and `/claim` callers, the `/transition` route, its `isProjectAdmin` force check and forced audit action, the `PATCH` route and its rule call, and the cross-repo guard calls) re-pointed by reading each target line at head (the new `/start` code moves the citations before `/claim` by 13 lines, the `/claim` caller by 7 and the later ones by 12 or 13). `backend.md`, `governance-merge.md` and `reconcile-done-but-open.md` list `routes/tasks.ts` as a source, cite no line of it and make no claim about the `/start` work branch's checks, so they were re-read and re-stamped without content change.
- 2026-10-10T06:36:28Z, task da6e6e67: `POST /tasks/:id/claim` (`routes/tasks.ts`) now refuses a status outside the workflow's initial state and the review holder as work claimant, both on the pre-lock read right after the backlog guard (a specific `409 bad_state`, ahead of the dependency, confidence and transition-rule gates) and, for the identity rule, again in the locked revalidate; the review-holder stand-in is one helper shared with `admin-reassign`. `claim-model.md` gained a paragraph on both rules and the race; `workflow-gates.md` says that `/claim` reaches its lost-race `409` text only for a lost race, and its `routes/tasks.ts` line citations (the `evaluateV2TransitionGates` definition and its `/start`, `/finish` and `/claim` callers, the `/transition` route, its `isProjectAdmin` force check and forced audit action, the `PATCH` route and its rule call, and the cross-repo guard calls) were re-pointed by reading each target line at head (they sat 4 lines off before this change and the new `/claim` code moves everything after it by about 35). `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` list `routes/tasks.ts` as a source, cite no line of it and make no claim about the `/claim` route's checks (`reconcile-done-but-open.md` and `task-lifecycle.md` describe `task_start`, not `/claim`), so they were re-read and re-stamped without content change.
- 2026-10-10T05:22:00Z, task 7fc13bcc (fix round): the review-claim branch of `POST /tasks/:id/start` (reason `task_start_review_claim`, used by the MCP `task_start` verb) re-runs `checkDistinctReviewerGate` in its revalidate against the locked row, like `POST /tasks/:id/review/claim` (`routes/tasks.ts`); both are the only routes besides `admin-reassign` that grant a review claim. `claim-model.md` now names both routes in its paragraph (renamed from the `/review/claim`-only wording) and `workflow-gates.md` names both in the lock-only writers sentence. `frontend.md` records the accessible names of the reassign button and the now required `onClaimReassigned` prop of `TaskMetaSidebar`. `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` were re-read against the changed code and re-stamped without content change.
- 2026-10-10T04:56:51Z, task 7fc13bcc: `POST /tasks/:id/review/claim` now re-runs `checkDistinctReviewerGate` in its revalidate against the locked row (`routes/tasks.ts`), and the task view gained the admin reassign picker (`ClaimReassignPicker.tsx`, `TaskMetaSidebar.tsx`, two api helpers, `.td-reassign*` styles). `claim-model.md` gained a paragraph on the review-claim re-check and `workflow-gates.md` names it in the lock-only writers sentence; `frontend.md` gained a paragraph on the picker and lists its sources. `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` list `routes/tasks.ts` as a source, cite no line of it and make no claim about the review-claim revalidate, so they were re-read and re-stamped without content change. `frontend.md` was re-checked against its `frontend/package.json` claim (`next@^15` still holds), so only `architecture.md` (on `frontend/package.json`) and `mcp-server.md` (on `mcp-server` files) remain STALE; both predate this change and are not part of it.
- 2026-10-09T20:47:30Z, task 8296adcd (follow-up): `claim-model.md` was also re-read against `mcp-server/src/errors.ts` and `task-lifecycle.md` against `mcp-server/src/tools.ts`, with no content change. The distinct-reviewer rule was extended to the work claim (a project that requires a distinct reviewer refuses handing the work claim to the current review holder, checked before the transaction and again under the lock), so `claim-model.md` no longer lists that as not covered.
- 2026-10-09T20:23:19Z, task 8296adcd: `POST /tasks/:id/admin-reassign` (a sibling of `admin-release`) and `GET /projects/:id/eligible-actors` were added (`routes/tasks.ts`, `routes/projects.ts`, new `services/eligible-actors.ts`, new audit action `task.claim_reassigned`). `claim-model.md` gained a paragraph on the reassignment (authz, the eligible set, the single-active-claim and distinct-reviewer rules it mirrors, the holder-pinned write, the audit event) and names it in the grounding-context sentence; `backend.md` gained a paragraph on the eligible-actors route; `workflow-gates.md` lists `/admin-reassign` among the lock-only compare-and-swap writers and the writers that answer `merge_in_progress`. `workflow-gates.md` also carried 15 `routes/tasks.ts` line citations that no longer matched the file (they were off by up to about 150 lines before this change, and the new import and route move them further): each was re-pointed by reading the target line at head (the `evaluateV2TransitionGates` definition and its `/start`, `/finish` and `/claim` callers, the `/transition` route, its `isProjectAdmin` force check and forced audit action, the `PATCH` route and its rule call, and the four cross-repo guard calls). `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` list `routes/tasks.ts` as a source, cite no line of it and make no claim about the claim-release writers, so they were re-read and re-stamped without content change.
- 2026-10-07T04:24:51Z, task 7f0a62f5: a GitHub 5xx answer to the merge PUT is now an unknown outcome (`github-merge.ts` sets `outcomeUnknown` on a status of 500 or above and keeps GitHub's status; the source change is four lines after the 405 and failure audit, so no citation of `github-merge.ts` moved: the cited lines 143, 162, 195 and 220 are all above it) and the `performReservedMerge` doc comment in `routes/tasks.ts` says so (line count unchanged). `workflow-gates.md` now states the 5xx rule and the lapse boundary of `noLiveMergeReservation` (a lease exactly one TTL old has lapsed). `architecture.md`, `backend.md`, `claim-model.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` list the changed files as sources, make no claim about the merge PUT's error classification, were re-read against the changed code and re-stamped without content change.
- 2026-10-06T09:48:48Z, task 06b06931 (follow-up): the source changes were comments on the merge reservation release in `routes/tasks.ts` and `routes/github.ts` and the `grounding_github_fence_conflict` 409 sentence on the finish and GitHub merge operations in `routes/docs.ts`; `routes/github.ts` gained one line, so the citations `routes/github.ts:840`, `:851` and `:863` in `architecture.md`, `backend.md`, `governance-merge.md` and `workflow-gates.md` moved to `:841`, `:851` and `:864`. `workflow-gates.md` now says the client stops waiting after 45 s and that GitHub completing the merge after the lease falls back to `merged_but_status_changed`. `claim-model.md`, `task-lifecycle.md` and `reconcile-done-but-open.md` make no claim about the changed text and were re-stamped without content change.
- 2026-10-06T09:35:00Z, task 06b06931 (follow-up): `claim-model.md` and `task-lifecycle.md` list `backend/src/routes/tasks.ts` as a source; they make no claim about the merge reservation release or the merge PUT, were re-read against the changed handlers and re-stamped without content change.
- 2026-10-06T09:28:57Z, task 06b06931: the merge PUT is bounded by `AbortSignal.timeout` (`GITHUB_MERGE_TIMEOUT_MS`, 45 s), a fetch that ends with an unknown outcome or a handler that throws after taking the reservation keeps it until the lease lapses, a reservation write refused by the repository fence answers `409 grounding_github_fence_conflict`, and a `merge_in_progress` refusal of a merge path carries `Retry-After`. `workflow-gates.md` describes all four and lists `grounding-github-fence.ts` as a source; `governance-merge.md`, `backend.md`, `architecture.md` and `reconcile-done-but-open.md` cite lines of `github-merge.ts` and `routes/github.ts` that moved (the merge fetch and its redirect check, the comment guard at `routes/github.ts:840`); the citations were re-pointed and the docs re-stamped.
- 2026-10-06T08:17:15Z, audit gate rollout (depsight be8c7ea): `.github/workflows/audit.yml` now runs `scripts/audit-gate.mjs` with `.github/audit-allowlist.json`. `deploy.md` lists the workflow as a source but makes no claim about the audit job's gate, so it was re-stamped without content change.
- 2026-10-06T05:33:07Z, task eb08742f (review fixes, composition helper): `task-merge-reservation.ts` changed once more (`andWhere` splices an AND-only clause into one flat list, so the WHERE the writers send keeps its shape). `workflow-gates.md` says the predicate is appended to a writer's own `AND`, which still holds, and `backend.md` lists `backend/src/services` as a source and makes no claim about the helper; both were re-read against the file and re-stamped without content change.
- 2026-10-06T05:53:41Z, merge-reservation doc comments in `backend/src/services/task-merge-reservation.ts` now name the composing form (`withNoLiveMergeReservation(where)`) instead of an object spread; line counts unchanged, no citation moved (task eb08742f). `workflow-gates.md` and `backend.md` re-checked against it and re-stamped.

- 2026-10-06T05:10:53Z, task eb08742f (review fixes): `workflow-gates.md` now says that `DELETE /tasks/:id` is refused during a live reservation (it left the exempt writers), names `withNoLiveMergeReservation` as the form that appends the predicate to a writer's own `AND`, and records the UTC binding of the reservation timestamps (`utcTimestampSql`); its `routes/tasks.ts` line citations after the DELETE route (the claim gate call, the transition route, its admin check and the forced-transition audit) were re-pointed by content, six lines further down. `backend.md`, `claim-model.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` list the edited files as sources: their claims touching the changed code (the writer set, member removal, the grounding completion write, the merge path) were re-read against it and hold, so they were re-stamped without content change. `okf-kit check --json --require-anchors docs/okf`: 0 errors, 109 warnings (all anchor-required, the same count as before), no sources-fresh finding.
- 2026-10-06T04:42:30Z, task eb08742f: the merge reservation. `workflow-gates.md` replaces its distinct-reviewer residual paragraph with the reservation (columns, conditional take bound to status, status version and claims, release by the post-merge write and the request end, 120 s lease with lazy expiry, the writers that answer `409 merge_in_progress`, the writers that are deliberately exempt, fence-trigger coverage) and re-points its `tasks.ts` line numbers; `task-merge-reservation.ts` joined its sources. `task-lifecycle.md`, `claim-model.md` (member removal) and `mcp-server.md` (the `merge_in_progress` teaching error) gained one sentence each. `architecture.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `backend.md` were read for claims about the merge path: their `github-merge.ts` and `routes/github.ts` line citations were re-pointed by content (the hook and imports shifted them), the reservation is named where they describe the check right before the GitHub call, and the done-but-open window in `reconcile-done-but-open.md` now starts at the reservation write. `auth.md` and `deploy.md` were re-checked for the changed `schema.prisma` and fence SQL (a new nullable Task column and one SQL comment; none of their claims concern them) and re-stamped. The other claims of the documents that were already stale from earlier merges were not re-verified line by line: only the claims touching the changed sources were. All ten re-stamped.
- 2026-10-05T07:23:35Z, task 2bf1b70a: both `tasks_list` tools now cap `cursor` at 200 characters (`backend/src/routes/mcp.ts` and `mcp-server/src/tools.ts`). `claim-model.md` gained the cap and the unknown-cursor behaviour in its hosted-tool sentence, checked against the two input schemas and the claimable route's `cursor` handling in `backend/src/routes/tasks.ts`. `auth.md`, `mcp-server.md` and `task-lifecycle.md` list the edited files as sources; `mcp-server.md`'s one `tools.ts` line citation (:803) sits above the edit and did not move, and the other two make no claim about `cursor`, so they were re-stamped unchanged.
- 2026-10-05T06:07:55Z, task faba28af: the backend-hosted `tasks_list` tool (`backend/src/routes/mcp.ts`) now takes `cursor` and `sort` and forwards them to `GET /tasks/claimable`. `claim-model.md` gained a sentence on it (and `backend/src/routes/mcp.ts` as a source), checked against the tool's input schema and query forwarding in `mcp.ts` and the route's `cursor`/`sort` parsing in `backend/src/routes/tasks.ts`. `auth.md` lists `backend/src/routes/mcp.ts` as a source: its only citation of that file names `resolveOperationKey` and the keyed tools, both untouched by the edit (no `mcp.ts` line numbers are cited), so its claims are unchanged and it was re-stamped.
- 2026-10-05T04:35:07Z, task 10e761e2: `claim-model.md` gained a paragraph on the paging of `GET /tasks/claimable` (25-row default page, `limit + 1` look-ahead, always-present `truncated`, exact `nextCursor`), checked against the route in `backend/src/routes/tasks.ts` and the cursor loop in `cli/src/api.ts`. `architecture.md`'s Swagger UI citation into `backend/src/routes/docs.ts` moved from :2031 to :2035 (read the line after the edit). `backend.md`, `governance-merge.md`, `mcp-server.md`, `reconcile-done-but-open.md`, `task-lifecycle.md` and `workflow-gates.md` were re-verified (they make no claim about the claimable listing or the `tasks_list` description) and re-stamped. `architecture.md` also lists `backend/src/routes/github.ts`; its citations (:268, :283, :298, :782, :792, :805) were re-verified against the file at head (each line still holds the `groundingGuard` check, the `redirect: "manual"` option or the `isGithubRedirect` refusal the doc names). `workflow-gates.md`'s 15 `backend/src/routes/tasks.ts` line citations moved by +5 (the look-ahead change adds five net lines near line 1568) and were each re-checked against the target line at head: `evaluateV2TransitionGates` definition and its callers in `/start`, `/finish` (three) and `/claim`, the `/transition` route, its `isProjectAdmin` force check and forced audit action, the `PATCH` route and its rule call, and the five cross-repo guard calls. No other bundle doc carries a `tasks.ts` line citation. `auth.md` lists `backend/src/routes/mcp.ts` as a source (a sentence was added to the backend-hosted `tasks_list` tool description); it makes no claim about that tool and was re-stamped.
- 2026-10-04T17:52:22Z, `architecture.md` and `workflow-gates.md` re-verified. architecture.md: the Swagger UI citation into `backend/src/routes/docs.ts` moved from :2027 to :2031 after the merge-route 409 entries were added above it (re-pointed after reading the line); the 409 schemas are now a oneOf of the merged_but_status_changed object and ErrorResponse, which no claim in the doc names. workflow-gates.md: the per-handler sentence on what the webhook-first completed write stores was rewritten after reading each handler's write data in `backend/src/routes/tasks.ts` (`/merge`, Mode B review-finish, self-approve, Mode A work-finish, the autoMerge recovery write) and `backend/src/routes/github.ts`; only Mode B review-finish and self-approve send the approval signal. Re-stamped both.
- 2026-10-04T17:29:44Z, task 21446d1a (review fixes): `workflow-gates.md` now limits the claim-clearing, `autoMergeSha`, `result` and approval-signal clauses of the post-merge webhook-first completion to `/merge` and the autoMerge forms of `/finish` (the GitHub merge route writes only `{ status: "done" }`), and lists the review-claim-only branch of `POST /tasks/:id/abandon` among the lock-only writers; its `routes/tasks.ts` line citations (+6 lines after the new creator-abandon message constant) were re-pointed. `architecture.md`, `backend.md`, `claim-model.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` were re-verified against the changed `routes/tasks.ts` and `routes/docs.ts` (the change adds 409 message text and an OpenAPI 409 entry; their claims are unchanged). All re-stamped.
- 2026-10-04T16:57:21Z, task 21446d1a: `workflow-gates.md` documents the status-version compare of the claim-guarded writers, the legacy webhook writers and `POST /github/pull-requests/:n/merge`, plus the distinct-reviewer residual; its `sources` gain `github-webhook.ts`, `task-status-cas.ts` and `task-merge-status-write.ts`, and its `tasks.ts` and `github.ts` line citations were re-pointed after the edit. `governance-merge.md` and `task-lifecycle.md` gained one sentence each; `architecture.md`, `backend.md` and `governance-merge.md` had their `routes/github.ts` line citations re-pointed; `claim-model.md` and `reconcile-done-but-open.md` were re-verified (claims unchanged). All re-stamped.
- 2026-10-04T06:08:30Z, task d3f5266b: `workflow-gates.md` CAS paragraph: the webhook and `POST /github/merge` leave both claims unchanged (they never write them). Re-stamped.
- 2026-10-04T06:03:23Z, task d3f5266b: `workflow-gates.md` CAS paragraph now states which writers clear which claims after a merge race (webhook and `POST /github/merge` leave both, `/finish` approval clears both, `/review` approval clears only the review lock), checked against `backend/src/routes/tasks.ts` and `backend/src/services/github-webhook.ts`. Re-stamped.
- 2026-10-03T12:12:29Z, okf-staleness workflow re-synced from the okf-kit
  workflow template (fleet convergence ticket fdc01728): the workflow header
  now names the template as its source instead of calling the file a pattern
  to keep in sync, the pin moved from okf-kit@0.10.0 to okf-kit@0.16.0,
  `--require-anchors` joined the invocation, and the job stays warn-only.
  Measured on the tree before the change with `okf-kit check --json <bundle>`:
  at okf-kit@0.10.0, 0 errors, 0 warnings, 0 notices (exit 0) plain and 0
  errors, 108 warnings, 0 notices (exit 0) with `--require-anchors`; at
  okf-kit@0.16.0, 0 errors, 0 warnings, 0 notices (exit 0) plain and 0 errors,
  108 warnings, 0 notices (exit 0) with `--require-anchors`. Of the
  anchored-run warnings, 108 are anchor-required findings (full citations
  without an anchor); anchoring them is separate work and none of them blocks
  anything. `deploy.md` lists the workflow among its sources: re-verified (it
  never describes the OKF job, so its claims are unchanged) and re-stamped.

- 2026-10-02T07:54:24Z, task 7c64e80c: re-stamped after merging master; `architecture.md`, `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md`, `task-lifecycle.md`, `workflow-gates.md` list sources that master changed in the meantime. The merged changes come from separately reviewed tasks and none contradicts these docs' claims, so no body text changed.

# Change log

## 2026-10-03 (mcp-server 0.16.0, mcp-bridge 0.9.0)

`mcp-server.md` names `SERVER_VERSION` and `mcp-server/package.json#version`
as `"0.16.0"` and points at the `## 0.16.0` CHANGELOG entry; `mcp-bridge.md`
names `PACKAGE_VERSION` `"0.9.0"` and the exact pin `"0.16.0"`;
`release-flow.md` was re-verified (the pin-with-server-bump steps still hold,
`mcp-bridge/package.json` is one of its sources) and re-stamped, and so was `auth.md`: its source `mcp-bridge/src/cli.ts` changed only
in `PACKAGE_VERSION`, and its `serve`-path sentence was re-checked against the
current file. All four re-stamped.

## 2026-10-03 (deploy.md re-stamp after the staleness-template re-sync)

`deploy.md` lists `okf-staleness.yml` as a source; the comment-only re-sync
of that workflow made it stale again. Claims unchanged (the doc never
describes the OKF job); re-stamped.

## 2026-10-03 (merge of master: release.yml env change)

Merged master (release.yml passes its step values through `env:`) into the
publish-floor branch. `release-flow.md` keeps this branch's publish text and
master's release.yml description, both still accurate; `deploy.md` lists both
workflows only as sources. Both re-stamped after the merge.

## 2026-10-03 (release-flow.md quotes the workflow's literal)

`release-flow.md` now quotes the attestation probe as
`npm view "${pkg}@${version}" dist.attestations`, the literal at the cited
`publish-npm.yml:93-110`, instead of a `<pkg>@<version>` placeholder the
literal guard cannot match. Claims unchanged; re-stamped (2026-10-03T12:52:10Z).

## 2026-10-03 (release.yml: step values via env)

`release.yml` now passes the release version into its `run:` scripts through
`env:` instead of interpolating `${{ }}` expressions into the script text, and
the changelog `awk` extraction reads it from `ENVIRON`. Re-verified
`release-flow.md` (its description of the tag-derived version and the `awk`
section extraction still holds) and `deploy.md` (lists `release.yml` only as
a source, no claim about it). Both were re-stamped; no body text changed.

## 2026-10-02 (merge of master: generic status compare-and-swap)

Merged master (the generic status write compare-and-swap) into the branch for
stored legacy workflow definitions. `workflow-gates.md` keeps the master text
of its 422 paragraph with the `tasks.ts` line citations after the `PATCH`
backlog guard comment re-pointed by two lines; `task-lifecycle.md` keeps the
sanitizer sentence of this branch and the compare-and-swap sentence of
master. The claims of `backend.md`, `claim-model.md`, `governance-merge.md`
and `reconcile-done-but-open.md` did not change. All six were re-stamped.

## 2026-10-02 (stored legacy workflow definitions, start edge only)

Re-verified `workflow-gates.md` and `reconcile-done-but-open.md` against the
sanitizer in `default-workflow.ts`, which now remaps from `backlog` only an
edge whose target is neither a terminal nor a review state.
`workflow-gates.md` now states that rule, the invariant that an open task can
never reach a terminal or review state through a remapped edge, that a task
enters `backlog` at creation or by demote and leaves it only by promote or
discard, and names `GET /projects/:projectId/effective-workflow` and
`POST /workflows/:id/validate-transition` as readers that still answer from
the stored definition. The claims of `reconcile-done-but-open.md` did not
change, nor did those of `backend.md`, which lists `backend/src/services` as
a source (its services summary still names `default-workflow.ts` as part of
the workflow engine). All three were re-stamped.

## 2026-10-02 (stored legacy workflow definitions, remap rule)

Re-verified `workflow-gates.md`, `backend.md`, `governance-merge.md` and
`reconcile-done-but-open.md` against the narrowed sanitizer in
`default-workflow.ts`, the comment in `grounding-context.ts` and the edge
lookup in `grounding-completion-gates.ts`. `workflow-gates.md` now states that
edges out of `backlog` are remapped to leave from `open` only when the stored
initial state is `backlog` and are dropped otherwise, that the grounded direct
paths find the remapped start edge with its stored gates, and that a task in
`backlog` leaves it through promote or discard; it lists
`grounding-completion-gates.ts` as a source, and its `tasks.ts` line
citations were re-pointed in the merge of master. The claims of the other three
did not change. All four were re-stamped, and so was `claim-model.md`: it lists
`tasks.ts`, which the merged master change touched (a moved demote message
constant and its import); none of its claims depends on that.

## 2026-10-02 (stored legacy workflow definitions)

Re-verified `workflow-gates.md`, `task-lifecycle.md`, `backend.md`,
`governance-merge.md`, `reconcile-done-but-open.md` and `claim-model.md` against the
sanitizing read of stored workflow definitions in `default-workflow.ts` and
`grounding-context.ts`. `workflow-gates.md` now states that a stored
definition with `backlog` as its initial state or as an edge endpoint is
sanitized on every read (edges into `backlog` are dropped, edges out of it
leave from `open` instead), which writers that covers, and the two readers
that keep their own behaviour; its `tasks.ts` line citations after the
`PATCH` guard comment were re-pointed. `task-lifecycle.md` points to it from
the abandon and demote text. The claims of `backend.md`,
`governance-merge.md`, `reconcile-done-but-open.md` and `claim-model.md` did
not change (the `tasks.ts` edit is a comment only). All six were re-stamped.

## 2026-10-03 (status write compare-and-swap residuals)

Re-verified `workflow-gates.md`, `task-lifecycle.md`, `backend.md`, `claim-model.md`, `governance-merge.md`, `reconcile-done-but-open.md`, `architecture.md` and `auth.md` against the change to `backend/src/routes/tasks.ts`, `backend/src/routes/github.ts`, `backend/src/services/github-webhook.ts`, `backend/src/services/grounding-completion.ts` and `backend/prisma/schema.prisma`: the status compare-and-swap now also matches a new `Task.statusVersion` counter and the work claim and review lock the handler read, and `/finish`, `/merge` and `/review` write through it. `workflow-gates.md` has the rewritten compare-and-swap paragraph and its `tasks.ts` line citations re-pointed to the shifted code; `task-lifecycle.md` gained a sentence each on the `task_finish` and `task_merge` writes. The claims of the other six did not change, and the `routes/github.ts` line citations still hold (the file's line count is unchanged). All eight were re-stamped.

## 2026-10-02 (generic status write compare-and-swap)

Re-verified `workflow-gates.md`, `task-lifecycle.md`, `backend.md`, `claim-model.md`, `governance-merge.md` and `reconcile-done-but-open.md` against the change to `backend/src/routes/tasks.ts`: `POST /tasks/:id/transition` and the human `PATCH /tasks/:id` status lane now write with an `updateMany` guarded on the status the handler read and answer `409` when no row matched. `workflow-gates.md` gained a paragraph on it and its `tasks.ts` line citations were re-pointed to the shifted code; `task-lifecycle.md` now says promote and discard use the same guarded write. The claims of `backend.md`, `claim-model.md`, `governance-merge.md` and `reconcile-done-but-open.md` did not change. All six were re-stamped.

## 2026-10-02 (grounded demote, concurrent demote)

Re-verified `task-lifecycle.md` and `workflow-gates.md` against the resolver change: a grounded demote whose locked row is already `backlog` (a concurrent demote won) now refuses with the claim-refusal `409` message; `task-lifecycle.md` names that race. `task-lifecycle.md`, `workflow-gates.md` and `backend.md` (its direct-adapter demote sentence still holds) re-stamped.

## 2026-10-02 (grounded demote, status race)

Re-verified the docs that list `grounding-direct-context.ts` and
`grounding-direct-tasks.ts` against the resolver change: a demote whose locked
row is no longer `open` now answers the REST demote's claim-refusal `409` message, also when a concurrent demote already moved it to `backlog`.
`task-lifecycle.md` now attributes the `400` for a non-open source to the
route's pre-lock check and names the race answer; the other claims did not
change. All docs of the grounded demote entry below were re-stamped.

## 2026-10-02 (grounded demote)

Re-verified `task-lifecycle.md`, `backend.md`, `workflow-gates.md`,
`claim-model.md`, `architecture.md`, `governance-merge.md` and
`reconcile-done-but-open.md` against the grounded open to backlog demote: the
direct-route resolver now has a demote case, the route plan acknowledges the
task's signals and may record `task.backlog_demoted`, and the refusal texts
moved to `services/task-demote.ts`. `task-lifecycle.md` no longer says an
enrolled task cannot be demoted, `backend.md` and `workflow-gates.md` mention
the grounded lane, and the `tasks.ts` line citations in `workflow-gates.md`
were re-pointed after the moved constant and the added import. The claims of
`claim-model.md`, `architecture.md`, `governance-merge.md` and
`reconcile-done-but-open.md` did not change. All of them were re-stamped.

## 2026-10-02 (backlog demote)

Re-verified `task-lifecycle.md`, `claim-model.md`, `workflow-gates.md`,
`frontend.md`, `architecture.md`, `backend.md`, `governance-merge.md` and
`reconcile-done-but-open.md` against the new open to backlog demote in
`PATCH /tasks/:id`, its audit event and signal acknowledgement, the
"Move to backlog" row action and header action, and the OpenAPI text.
`task-lifecycle.md`, `claim-model.md`, `workflow-gates.md` and `frontend.md`
now describe the demote; every `tasks.ts` line citation in
`workflow-gates.md` and the `docs.ts` citation in `architecture.md` were
re-pointed after the inserted lines, and the `tasks/page.tsx` line count in
`frontend.md` was corrected. The claims of `backend.md`, `governance-merge.md`
and `reconcile-done-but-open.md` did not change. All of them were re-stamped.

Fix round: the guard that answers `400` for a PATCH to `backlog` from any
status other than `open` (also under a stored legacy workflow definition) and
the pinned `409` for a grounding-enrolled task are now stated in
`task-lifecycle.md`; the `tasks.ts` line citations in `workflow-gates.md` were
re-pointed again after the inserted guard, and the seven docs whose sources
changed were re-stamped.

## 2026-10-02 (grounded finalDisposition)

Re-verified `backend.md`, `reconcile-done-but-open.md`, `governance-merge.md`,
`task-lifecycle.md`, `workflow-gates.md` and `architecture.md` against the
changed grounding sources. `task-lifecycle.md` now states that the grounded
creator-abandon and admin restore reuse the REST handlers and their
post-commit `finalDisposition` write and clear, and that a restore the
grounding service performs after the middleware's pre-lock read went stale
clears it through an after-commit observer on `dispose()`. The other docs'
claims remain unchanged.

## 2026-10-01 (respec descriptions and teaching error)

Re-verified `workflow-gates.md`, `reconcile-done-but-open.md`,
`architecture.md`, `task-lifecycle.md`, `mcp-server.md`,
`governance-merge.md`, `backend.md` and `claim-model.md` against their
changed sources. The respec lifecycle text now states the backlog agent
exception, open creator rule and human write-access rule; `mcp-server.md`
citations follow the shifted teaching-error lines. The other docs' claims
remain unchanged.

## 2026-10-01 (finalDisposition)

`workflow-gates.md`: every `tasks.ts` line citation (transition-gate helper,
start, finish, claim, transition route, force `isProjectAdmin`, forced audit,
`PATCH` route and gate call, and the four cross-repo `prUrl` guard sites) was
re-checked with `rg` against the current file and corrected to its actual
position; the stale file-size footnote was reworded without a line count or
date. `backend.md`, `claim-model.md`, `auth.md`, `governance-merge.md`,
`reconcile-done-but-open.md`, `task-lifecycle.md` and `architecture.md` were
re-verified against the new `ConfidenceTelemetry.finalDisposition` column, the
disposition writers (including the claim-snapshot refresh in the abandon
writer), the telemetry select in `projects.ts` and the reworded OpenAPI
telemetry text in `docs.ts`; none of their claims changed. All eight were
re-stamped.

## 2026-10-01 (clarification signal, per-task workflow)

The comment route in `tasks.ts` now loads the task's own workflow before
classifying the task's state, and the clarification wording in `docs.ts`, the
`schema.prisma` comment and `confidence-telemetry.ts` was made precise. The
same eight docs as in the previous entry were re-verified against these
changes; none of their claims changed. All were re-stamped.

## 2026-10-01 (clarification signal)

`architecture.md` was re-verified against `docs.ts` (the `/docs` Swagger UI
route moved down by the new OpenAPI schema and its citation was re-pointed).
`backend.md`, `claim-model.md`, `workflow-gates.md`, `auth.md`,
`governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md`
were re-verified against the new clarification counter in the comment route
of `tasks.ts`, the telemetry select in `projects.ts` and the new
`ConfidenceTelemetry.clarificationCount` column; none of their claims changed.
All were re-stamped.

## 2026-10-01 (riskModifiers write path)

`confidence-scorer.md` was re-verified against `confidence.ts` and updated: the
file gained `riskModifiersSchema`, the validator for the new `riskModifiers`
field on `PATCH /projects/:id`, and its line count changed. `backend.md` was
re-verified against `projects.ts` and gained a short description of that PATCH
field and its audit handling. `architecture.md` was re-verified against
`docs.ts` and its Swagger UI route line anchor was re-pointed. All three were
re-stamped.

After review, `backend.md`, `confidence-scorer.md`, `claim-model.md` and
`workflow-gates.md` were re-verified against comment-only edits in
`confidence.ts` and `schema.prisma` (the riskModifiers comments now name the
write path) and re-stamped, as were `architecture.md` and `auth.md`, which list
`docs.ts` and `schema.prisma`; `backend.md` now says the PATCH needs the ADMIN
role on the project or its team.

## 2026-09-29 (PR URL identity and required-CI wording)

`governance-merge.md` and `workflow-gates.md` were re-verified against
`grounding-github-fence.ts`, whose PR URL identity check now refuses a
repository name with surrounding whitespace, and against the updated receipt
contract, and updated: the required-CI gate compares the stored PR URL with the
project repository, and a repository name with surrounding whitespace never
matches. `backend.md`, `claim-model.md` and `reconcile-done-but-open.md` were
re-verified against the same sources without content changes. All five were
re-stamped.

## 2026-09-29 (grounded merge of TASK_SPEC tasks)

`backend.md`, `governance-merge.md` and `workflow-gates.md` were re-verified
against the grounded merge change in `grounding-completion.ts`,
`grounding-github-merge.ts`, `grounding-github-fence.ts`,
`grounding-context.ts`, `grounding-completion-gates.ts`,
`grounding-finalization.ts` and `grounding-route-effects.ts`, and updated: a
`TASK_SPEC` receipt signs no head, so the reservation skips the signed-head
comparison for it while still reserving the observed head and sending it as
the expected `sha`; stored PR URLs are compared with the effective repository
case-insensitively and with the exact PR number. `reconcile-done-but-open.md`
and `claim-model.md` were re-verified against the same sources and the updated
receipt contract without content changes. All five were re-stamped.

## 2026-09-28 (runtime database role)

`deploy.md` was re-verified against `docker-compose.prod.yml`, whose backend
`DATABASE_URL` now comes from the optional `POSTGRES_APP_USER` and
`POSTGRES_APP_PASSWORD` with the owner role as fallback, and re-stamped.
`architecture.md` was re-verified against the same file (its topology claim
is unchanged) and re-stamped.

## 2026-09-28 (re-stamp after the operation-key merges)

`task-lifecycle.md` and `claim-model.md` were re-stamped without content
changes. Their sources `mcp-server/src/tools.ts` and `cli/src/api.ts` did not
change against the state both documents were verified against; only the
squash-merge commits that landed them on master carry later dates, which made
the staleness check report both documents as stale.

## 2026-09-28 (scoped grounding enforcement)

Grounding enforcement was project-scoped: an enabled configuration's
`409 grounding_enrollment_required` gate on a fresh remote operation (task
merge, GitHub merge, finish with `autoMerge`) on an unprovisioned task now
fires only when the task's project is inside the configured `creationPolicy`
scope, or when any repository or PR number the legacy handler could act on
(request, task and PR URL targets) belongs to a selected project or is shared
with a protected/`EXTERNAL_V1`/held peer. That replaced the previous global
enforcement, in `backend/src/routes/grounding-task-completion.ts`,
`backend/src/routes/grounding-github.ts`, `backend/src/services/grounding-runtime.ts`
and a new `backend/src/services/grounding-scope.ts` (which also lifted the
merge service's peer-discovery SQL into a shared, exported helper). An
unprovisioned task's PR create outside that scope now reaches the legacy
creator even with an operation key. Startup now also refuses when a project
outside the enforced scope shares a GitHub repository with an enforced one.
A repository string among those targets that is not a canonical `owner/repo`
identity is guarded too, and a legacy fall-through whose candidate repository
fence another operation owns is refused with `409
grounding_finalization_pending` before any GitHub call. Outside the scope the
GitHub create and merge routes read only the task id, body owner/repo, a
well-formed history key and the legacy-parsed path number, then hand the
request to the legacy handler unmodified (the legacy creator now also reads the
`Idempotency-Key` header); the principal differences from the unconfigured
app are those refusals, the agent-scope admission check, a transient routing
`503` and the GitHub merge route's retry message. Enabling configuration
writes grounding history and is therefore one-way; the
docs no longer call an enabled, empty configuration equivalent to the
unconfigured app. `architecture.md`, `workflow-gates.md`,
`governance-merge.md`, `reconcile-done-but-open.md`, `backend.md` and
`deploy.md` each stated or implied the old behavior and were re-verified
against the changed routes/service and re-stamped;
`docs/grounding-migration.md` and `docs/grounding-receipt-contract.md` (both
outside this bundle) were corrected the same way.

The configured GitHub create and merge routes then moved their project-access
check ahead of every Grounding read, so a caller without project access gets
the legacy handler's own `403` whatever the task's Grounding state; the GitHub
merge route stopped counting the body owner/repo as a candidate (the legacy
merger never sends it to GitHub); and `grounding-scope.ts` gained a
fail-closed check for a protected/`EXTERNAL_V1`/bound/held peer whose own
repository string is not canonical and that shares a candidate PR number. The
fence-acquisition race was described as an accepted residual with its
consequence. `architecture.md`, `workflow-gates.md`, `governance-merge.md`,
`reconcile-done-but-open.md` and `backend.md` were re-verified against the
changed routes and scope service and re-stamped; `claim-model.md` was
re-verified against the edited receipt contract (its claims did not change) and
re-stamped.

The target checks then moved from the routers to the effect boundary. The
routers keep only exact decisions (admission, task lookup, access, durable
history, enrollment mode, and whether the task's own project is in scope) and
no longer derive candidate repositories and PR numbers from the request and
the task. Instead, with configuration enabled, `performPrMerge` checks the
exact repository and PR number right before the GitHub merge call, and the
legacy PR creator and commenter check the repository (and PR) they post to;
the check refuses a non-canonical repository string, an enforced repository,
a protected/`EXTERNAL_V1`/bound/held peer's PR (alias peers included) and, for
merges and creates, an owned repository fence, reading peer and fence in one
statement. `createApp` hands the check to every request and the unconfigured
app hands none. The grouped merge peer lookup now reads peer ids from the
enrollment and hold tables first. The attempt and migration routes now check
access before the task lock, and the creation router before its
`creationPolicy` selection. `architecture.md`, `backend.md`,
`governance-merge.md`, `reconcile-done-but-open.md` and `workflow-gates.md`
were rewritten for the effect-boundary design and re-verified against the
changed routes, services and wiring; `deploy.md` and `task-lifecycle.md` were
re-verified and gained one sentence each (the composed check, the creation
router's access order); `claim-model.md` was re-verified against the edited
`tasks.ts` and receipt contract (its claims did not change) and re-stamped.

The effect-boundary check then took in every repository the legacy task
write's fence trigger checks. A merge or create is refused with
`409 grounding_finalization_pending` when another operation owns the fence of
the target repository or of any repository of the requesting task (its
effective repository, stored PR URL repository and own active PR-create
intents' repositories), and with `409 grounding_enrollment_required` when the
requesting task is itself protected/`EXTERNAL_V1`/bound/held, whatever PR
number it sends. A comment is refused on an enforced repository and on a
peer's PR whoever sends it, the PR the requesting task stores included; as
defense in depth, enforced repositories must still not run comment-triggered
merge or deploy automation, and direct GitHub access outside agent-tasks is
not governed by the check. With configuration enabled, the legacy merge, create and comment
writes are sent with `redirect: "manual"` and a GitHub redirect (a renamed or
transferred repository) is refused with `409 github_redirect_refused`; the
unconfigured app still follows redirects. `architecture.md`, `backend.md`,
`governance-merge.md`, `reconcile-done-but-open.md` and `workflow-gates.md`
were updated, re-verified against the changed scope service and legacy
writers and re-stamped; `claim-model.md` was re-verified against the edited
receipt contract (its claims did not change) and re-stamped.

The comment check was then re-verified as strict: a comment on the PR the
requesting task stores is refused like any other comment on an enforced
repository or a peer's PR, and the check's line citations moved with the
scope service. `architecture.md`, `backend.md`, `governance-merge.md`,
`reconcile-done-but-open.md` and `workflow-gates.md` were re-verified against
the changed scope service and re-stamped; `claim-model.md` was re-verified
against the edited receipt contract (its claims did not change) and
re-stamped.

Separately, unconfigured (grounding-disabled) startup admission stopped
treating an unowned GitHub repository-fence row as grounding history on its
own, since the repository-fence SQL trigger bumps such a row on any ordinary
GitHub-linked task write whether or not grounding is ever configured. Fence
intents are not exempt. `backend.md` and `deploy.md` were corrected for this
too, in the same pass.

## 2026-09-26 (re-verification, adr/ and diagrams/ move into docs/)

Moving root `adr/` and `diagrams/` into `docs/adr/` and `docs/diagrams/`
(and renumbering the two colliding docs/adr ADRs, webhook-event-model
0001 -> 0014 and grounding-finish-gate 0002 -> 0013) touched
`backend/prisma/schema.prisma`, `backend/src/routes/tasks.ts`,
`backend/src/routes/projects.ts`, `backend/src/services/gates/grounding-gate.ts`,
`backend/src/services/github-webhook.ts` and `docs/deploy-verify-strategy.md`
(comment-only ADR-number fixes, no behavior change) and turned `okf-kit@0.10.0
check` STALE for eight docs that list one of those files as a source. Each was
re-verified against the current file content, not just re-stamped:

- `deploy.md`: re-verified the `ADR 0014` cross-reference plus the four
  sources (`.github/workflows/publish-npm.yml`, `Dockerfile.migrate`,
  `backend/package.json`, `backend/prisma/grounding-github-fence.sql`)
  already STALE before this task, since a blind re-stamp would have
  silently cleared them too; `db:push`, the `Dockerfile.migrate` `CMD`,
  and the fence SQL's header comment still match the doc's claims.
- `auth.md`: `AgentToken` model fields (`tokenHash`, `scopes`, `revokedAt`,
  `expiresAt`, `lastUsedAt`) unchanged in `backend/prisma/schema.prisma`.
- `backend.md`, `claim-model.md`, `workflow-gates.md`, `task-lifecycle.md`:
  none of their claims cite the edited comment lines in `tasks.ts` or
  `schema.prisma`; the surrounding route/model behavior is unchanged.
- `governance-merge.md`, `reconcile-done-but-open.md`: same for
  `github-webhook.ts` and `tasks.ts`; no claim depends on the edited
  comment line.
- Follow-up in the same change: the webhook-event-model ADR became 0014
  instead of 0009, because existing text already cites an ADR-0009 for the
  `task_submit_pr` design. `deploy.md`, `governance-merge.md` and
  `backend.md` were re-verified against the edited sources (one comment and
  one prose ADR reference, no line shifts) and re-stamped.

## 2026-09-24 (re-verification, remaining stale sources)

Re-verified five docs against the sources that `okf-kit@0.10.0 check`
reported stale for them at `50d3f9b`, before the earlier e36696d7 re-stamp
cleared those warnings without a re-check:

- `architecture.md`: `backend/src/app.ts`, `backend/src/routes/grounding-creation.ts`,
  `backend/src/routes/grounding-direct-tasks.ts`, `backend/src/routes/grounding-task-completion.ts`,
  `frontend/package.json`, `package.json`.
- `backend.md`: `backend/prisma/schema.prisma`, `backend/src/app.ts`,
  `backend/src/routes/grounding-creation.ts`, `backend/src/routes/grounding-direct-tasks.ts`,
  `backend/src/routes/grounding-task-completion.ts`, `backend/src/routes/grounding.ts`,
  `backend/src/routes/projects.ts`, `backend/src/routes/tasks.ts`, `backend/src/services`,
  `backend/src/services/grounding-attempts.ts`, `backend/src/services/grounding-completion.ts`,
  `backend/src/services/grounding-context.ts`, `backend/src/services/grounding-merge-provider.ts`.
- `claim-model.md`: `backend/prisma/schema.prisma`.
- `task-lifecycle.md`: `backend/src/routes/grounding-creation.ts`,
  `backend/src/routes/grounding-direct-tasks.ts`, `backend/src/routes/tasks.ts`,
  `backend/src/services/grounding-route-context.ts`.
- `workflow-gates.md`: `backend/prisma/schema.prisma`,
  `backend/src/routes/grounding-task-completion.ts`, `backend/src/services/grounding-completion.ts`.

Drift from #520 (the configured GitHub adapters and the
`grounding_enrollment_required` remote gate) is corrected:
`claim-model.md` and `workflow-gates.md` now say configured GitHub creation
and webhook writers participate in the shared context-mutation protocol,
and `architecture.md`, `backend.md` and `workflow-gates.md` now say a
configured app's fresh remote operation (task merge, GitHub merge, finish
with `autoMerge`) on an unenrolled task returns
`409 grounding_enrollment_required` before any remote effect, while
unprovisioned local completion and the unconfigured default app keep their
compatibility behavior. `backend.md`'s pinned `hono` version is corrected
to match `backend/package.json`, and its services list and
grounding-attempts paragraph now point to the configured GitHub services
and their tables.

Newly cited sources (not stale at `50d3f9b`, added to the docs' sources):
`docs/grounding-receipt-contract.md` (`backend.md`, `claim-model.md`,
`workflow-gates.md`), `backend/package.json` (`backend.md`),
`backend/src/routes/grounding-github.ts` (`architecture.md`, `backend.md`,
`workflow-gates.md`), `backend/src/services/grounding-github-create.ts` and
`backend/src/services/grounding-github-webhook.ts` (`backend.md`,
`claim-model.md`).
`task-lifecycle.md` needed no content change. All five docs re-stamped.

## 2026-09-23 (mcp-bridge 0.8.2)

`mcp-bridge.md` names `PACKAGE_VERSION` `"0.8.2"`; the published bridge now
pins mcp-server `"0.15.0"` too, so the "still pins 0.14.0" clause is gone.
Re-checked and re-stamped, together with `release-flow.md` (the pin steps
still hold) and `auth.md` (the `cli.ts` serve-path sentence quoted a pre-#403 message
and now names `noTokenAvailableMessage()` and its current opening words; the
`AgentToken` storage-shape sentence was corrected for `name` and the
`scopes` default; both checked against the current files).

## 2026-09-23 (mcp-server 0.15.0)

`mcp-server.md` names `SERVER_VERSION` and `mcp-server/package.json#version`
as `"0.15.0"` and points at the `## 0.15.0` CHANGELOG entry; `mcp-bridge.md`
names the bridge's exact pin `"0.15.0"` (the published bridge 0.8.1 still pins
`"0.14.0"`); `release-flow.md` now moves the bridge pin with the server bump (step 2),
since `mcp-bridge/tests/lockstep.test.ts` enforces pin equals workspace
version, and lists that test as a source. All three re-stamped.

## 2026-09-23 (re-verification scope)

The e36696d7 re-stamps of `backend.md`, `architecture.md`, `task-lifecycle.md`,
`workflow-gates.md` and `claim-model.md` re-verified only the claims that cite
`backend/src/routes/tasks.ts`, `backend/src/routes/docs.ts` and
`mcp-server/src/tools.ts`, plus the `app.ts` route mounting (`backend.md`
route list rewritten against the current `app.ts`, `architecture.md` Swagger
mount citation corrected). Other sources these docs list were stale before the
re-stamp and were not re-checked; follow-up task 1784b2a6.

## 2026-09-23 (round 2)

Restamped `claim-model.md`, `governance-merge.md`, `reconcile-done-but-open.md`,
`workflow-gates.md`, `task-lifecycle.md`, `backend.md` and `mcp-server.md`
after task e36696d7's round-2 fixes further edited
`backend/src/routes/tasks.ts` (comment shrink), `backend/src/routes/docs.ts`
(OpenAPI description) and `mcp-server/CHANGELOG.md`. `workflow-gates.md`'s
`evaluateV2TransitionGates` prose and cross-repo `prUrl` guard line numbers
were already stale at base (the function had moved since they were last
verified); re-checked against the current file and corrected. The other
docs carry only prose claims about `tasks.ts`/`tools.ts` with no line
citations and needed no content change, only a timestamp bump.

## 2026-09-23

Restamped `mcp-server.md` after `project_tasks`'s response gained `count`
and `truncated` fields (task e36696d7): the backend's `nextCursor`
heuristic for `GET /projects/:id/tasks` was replaced with an exact
take-limit-plus-one probe, and `read.ts`'s `projectTaskListSummary`
citation was re-pointed at its rewritten return statement.

## 2026-09-10

Restamped `release-flow.md` and `deploy.md` after `.github/workflows/publish-npm.yml`
moved from a token secret to npm Trusted Publishing (OIDC): an npm@11 upgrade
step now runs directly before publish, and the publish step gained a retry
loop with a 403/404 triage hint. `release-flow.md`'s step-order prose was
rewritten to match; its `mcp-bridge/package.json` pin quote was re-verified
against the current file and needed no change. `deploy.md` cites the workflow
as a source but made no body claims about it, so only its timestamp moved.

## 2026-09-08

Documented the provisioned grounding completion transport, session-free external
pickup/start guidance, canonical operation keys, durable recovery, and direct
claim-context invalidation. Recorded that server-only enrollment must quiesce
active legacy requests and that remaining positive, indirect, webhook, MCP, and
rollout-qualification surfaces are staged separately.

Bound required shared-service CI results to the freshly authorized decision,
receipt and reservation head while preserving the existing classifier/cache
policy. Corrected `claim-model.md` to distinguish free database storage from
the workflow API's fixed state vocabulary and added its workflow-route source.


Added dormant shared completion/finalization services: explicit cohort policy,
immutable operation results, atomic receipt consumption and mandatory audit,
head-bound remote reservation/dispatch/recovery, undispatched cancellation and
a transaction context-writer protocol. Existing completion routers remain
unwired; C02 issue/upload now honor the reservation. Updated receipt, domain,
events, backend and workflow-gate documentation. Rechecked the unchanged
auth and claim-model source claims against the additive Prisma change and
restamped their source scopes.


Added the dormant protected grounding-attempt and receipt-ingest service, additive
relational storage and exact task-context projection. Updated `backend.md` to
describe the authenticated app routes and C01 invocation while keeping completion
gates and activation outside this change. Project-access and GitHub-delegation
helpers now accept an optional transaction client with unchanged default callers.
Re-read `architecture.md`, `claim-model.md`, `auth.md` and `workflow-gates.md`:
app wiring and additive Prisma storage preserve their deployment, claim, token
and completion-gate behavior. Corrected the shifted app route citation and
re-stamped these affected source scopes.

Fleet sync to okf-kit 0.10.0 (agent-tasks PR #507) surfaced `sources-fresh`
STALE on `deploy.md` (`.github/workflows/ci.yml` changed after the stamp)
and `release-flow.md` (`.github/workflows/publish-npm.yml` and
`.github/workflows/ci.yml` changed after the stamp), plus
`sources-fresh-future` FUTURE-DATED on `architecture.md`, `auth.md`,
`mcp-bridge.md`, `mcp-server.md` (each doc's hand-written `timestamp:` sat
after its own last commit by more than the skew allowance). Re-read all
six docs' claims against their `sources:` at HEAD (master `55f4bde`, the
PR #508 squash). `auth.md` and `mcp-bridge.md` share the
`mcp-bridge/src/token-store.ts:112-168` citation (the `MultiSourceStore`
`get`/`set`/`clear` trio): still points at the quoted text, anchor
unmoved. `mcp-server.md`'s citations into `mcp-server/src/tools.ts:706`,
`mcp-server/src/read.ts:268`, and `mcp-server/src/read.ts:299-321` also
still match, no anchor moved. `deploy.md`, `release-flow.md`, and
`architecture.md` carry no line-anchored citations; their `ci.yml` job
list, `publish-npm.yml` steps, and compose/workspace file references were
re-read against the current tree with no drift found. All six
`timestamp:` fields bumped to the verification instant. Follow-up pass:
`mcp-server.md`'s `SERVER_VERSION`/`package.json#version` citation had
drifted to a stale value, `"0.13.0"`, corrected to the current
`"0.14.0"` and anchored to `mcp-server/src/server.ts:9` and
`mcp-server/package.json:3`; the historical sentence describing
rc-v1-C008's bump to 0.13.0 is left as-is, since it describes a past
release rather than the current value. `timestamp:` re-bumped to the
follow-up verification instant.

Review-round-2 corrections (reviewer found the re-stamp had preserved
claims the cited sources contradict): `mcp-server.md`'s
`backlog_not_promoted` bullet said `allowedNext: ["tasks_get",
"task_creator_abandon"]`; the code at `mcp-server/src/errors.ts:806`
reads `["task_respec", "task_creator_abandon"]`, corrected, and the
parenthetical now gives the code's own rationale from
`mcp-server/src/errors.ts:752-757` (the two verbs an agent can still call
while it waits). The same doc's two "Teaching hint:" paraphrases are now
quoted verbatim from the code's `recipe` field (not `hint`), anchored to
`mcp-server/src/errors.ts:747` (`backlog_routing_enforced`) and `:763`
(`backlog_not_promoted`). `mcp-server.md`'s version-constant paragraph
gained a closing clause naming the current `0.14.0` cut, commit
`a1a4b9a` (PR #478, `mcp-server/CHANGELOG.md`'s `## 0.14.0`,
2026-08-20), since the paragraph previously stopped at the 0.13.0
rc-v1-C008 cut. `architecture.md`'s component-1 sentence "All routes
mount under `/api`" is narrowed to "All API routes mount under `/api`;
the Swagger UI page is the one exception, served at `/docs`", anchored
to `backend/src/app.ts:93` and `backend/src/routes/docs.ts:1866`
(`docsRouter` mounts at `/` in `app.ts`, then registers `/docs` inside
itself, outside the `/api` prefix). `deploy.md`'s trigger sentence now
names the `paths-ignore` skip for `**.md`/`docs/**` pushes and PRs
(`ci.yml:6-11`, `:14-19`) and the frontend job's `node-version: [22,
26]` matrix (`ci.yml:93-95`), dropping the "five independent jobs"
overstatement for the frontend leg; the "Nothing in
`.github/workflows/` ..." sentence keeps its wording but its `sources:`
now lists all seven workflow files under `.github/workflows/`
(previously only `ci.yml` and `docker-smoke.yml`), so a new
deploy-capable workflow trips `sources-fresh`. Re-stamped
`architecture.md`, `deploy.md`, and `mcp-server.md`. Task: agent-tasks
`8a1c4c52`.

## 2026-09-02

Post-merge re-verification (2026-09-02T05:46:00Z) after the Node-24 GitHub Actions bump
(#502): `deploy.md` and `release-flow.md` went STALE against `ci.yml`,
`docker-smoke.yml`, `release.yml` and `publish-npm.yml`, whose only change
was the `uses:` majors (`actions/checkout` v4 to v5, `actions/setup-node`
v4 to v5, `softprops/action-gh-release` v2 to v3; no step, trigger or line
moved). Both docs re-read against the four workflows: the one claim naming
a major (`release-flow.md`, the GitHub Release step) now says `@v3`,
everything else holds; both re-stamped.

Fleet parity sweep: pinned `.github/workflows/okf-staleness.yml` to
`okf-kit@0.9.0` (from `0.6.0`), matching the other bundle repos (measured: 0.8.0 and 0.9.0 report identical findings here). Cleared all
11 pre-existing `sources-fresh` STALE warnings by re-verifying every flagged
doc's claims against the current source, not just re-stamping: `backend.md`,
`claim-model.md`, `governance-merge.md`, and `reconcile-done-but-open.md`
had no citation drift, only the timestamp needed bumping.
`confidence-scorer.md` and `frontend.md` had a stale line-count citation for
`frontend/src/lib/confidence.ts` (1239 -> 1290 lines, `#494`'s
keystone-blocking warning helper), and `frontend.md` also had a stale line
count for `dashboard/page.tsx` (736 -> 739 lines, `#496`'s label editor).
`workflow-gates.md` had eight stale line-number citations into
`backend/src/routes/tasks.ts`: four shifted by the `#497` label-audit
insertion (`POST /tasks/:id/claim` gate call 6400 -> 6421; the v1
`/tasks/:id/transition` route 6635 -> 6656; its `isProjectAdmin` check 6666
-> 6687; its `task.transitioned.forced` audit call 6871 -> 6893) and four
were a pre-existing off-by-4 drift unrelated to this sweep's trigger, caught
only by opening the cited spans by hand (the cross-repo `prUrl` guard's four
call sites: `task_finish` 3356 -> 3360, `submit-pr` 3712 -> 3716, the PATCH
agent lane 4706 -> 4710, the PATCH human lane 4778 -> 4782); the doc's
line-count footnote was bumped from 7205 to the current 7226. `okf-kit check
--json docs/okf` on the committed tree: 0 errors, 0 warnings, 0 notices.
Task: agent-tasks `44ee799a`.

## 2026-08-31

`mcp-server.md` re-verified against `task 3653962f` (review round 1): added
`mcp-server/src/read.ts` to `sources:` and a new "Read-verb projection
layer" paragraph describing `project_tasks`'s summary-row default and its
own narrower `include` vocabulary, alongside `tasks_get`'s existing
single-task projection. `timestamp:` bumped. Every claim re-verified
against the cited source at authoring time; no other doc in this bundle
touches `read.ts` or the `project_tasks` row shape.

## 2026-07-16

CI now watches staleness: warn-only `okf-kit check` on every PR
(.github/workflows/okf-staleness.yml, canonical pattern from harness#350).

## 2026-07-05

New invariant doc `auth.md` authored to close the `sources:` granularity gap
the P2c benchmark located (`docs/okf/BENCHMARK.md`, Q8: "How does the MCP
bridge authenticate its requests to the agent-tasks backend?"): the pointers
section on that answer was sourced from `architecture.md`, whose coarse
`sources:` (the four deployables only) don't name any auth-specific file.
Chose the "add a focused concept doc" option over tightening
`architecture.md`'s own `sources:`: a doc scoped tightly to the auth/token
subsystem is both more likely to be the chunk retrieved for auth-shaped
questions and carries the real implementation files
(`mcp-bridge/src/token-store.ts`, `mcp-bridge/src/cli.ts`,
`mcp-server/src/client.ts`, `backend/src/middleware/auth.ts`,
`backend/prisma/schema.prisma`) identified by reading the code, not from
memory. `architecture.md` is left unchanged, keeping its overview role and
coarse `sources:`; `auth.md` is linked from `index.md`'s Invariants section
so it stays reachable. Every claim verified against source at authoring
time. No benchmark re-run in this task, the next measurement point picks it
up. Task: agent-tasks `1c576413-a559-43af-a181-c524710d4ebd`.

## 2026-07-04

Point 6 re-score recorded in `BENCHMARK.md` (sixth point, confirmation run
for the P3 KEEP decision): after codebase-oracle 0.10.0's fail-loud ingest
fix put `backend/src/routes/tasks.ts` into the index (192 chunks), M2 rose
5/12 → 7/12 (first-ever hits on Q6 and Q7, both organic), M1 17/24 → 18/24,
P 10/12 → 11/12. Pre-registered criterion met, KEEP default-on confirmed,
with the recorded caveat that the gains came from organic retrieval of the
newly indexed file, not from expansion injections, and that the Q12
displacement regression persists via the organic-wins dedup rule (refinement
filed as codebase-oracle `d165ff85`). Task: agent-tasks `1190c227`.

P3 sources-expansion measured in `BENCHMARK.md` (fifth point, first
search-side treatment, oracle 0.9.0): M2 4/12 → 5/12 (first-ever hits on Q3
and Q11, one displacement regression on Q12), M1/P unchanged. Two integrity
findings: the benchmark caught the feature silently no-opping in production
(namespace bug, fixed as oracle #64 pre-measurement), and
`backend/src/routes/tasks.ts` turned out to be absent from the index
(codebase-oracle `004f9577`), capping M2 reachability for Q7 in all five
runs and causing the Q12 regression. Pre-registered +2 criterion missed as
measured; operator kept default-on with the deviation recorded, point 6
after the index fix confirms or reverts. Task: codebase-oracle `89f02fa4`.

Answer-LLM comparison recorded in `BENCHMARK.md`: oracle answer LLM swapped
from Groq llama-3.3-70b-versatile to local gemma4-26b-a4b-64k (Mac mini
Ollama, `.env` only). M1 17/24, M2 4/12, P 10/12, all per-question identical
to the P2c run; mean query latency 29.2s. Decision: keep the local model
(removes the 100k-tokens/day cap that stalled P2c; repo content stays
local). Task: codebase-oracle `772874fc`.

P2c consumer re-run recorded in `BENCHMARK.md`: same bundle and index
content, consumer upgraded to codebase-oracle 0.8.0 (frontmatter ingest +
retrieval surfacing). M1 17/24 (= post-bundle, no regressions), M2 4/12
(flat, third identical run), new pointer metric P 10/12 vs 5/12 post-bundle
proxy — the `Pointers` section closes the pointer gap where OKF docs are
retrieved. Next lever: ranking/boost experiment (M2) and finer `sources:`
granularity on coarse docs (Q8 miss). Task: codebase-oracle `707b51ac`.

## 2026-07-03

Upkeep after the first real `okf-kit check` staleness run (5 STALE
warnings): all doc timestamps set to the actual verification datetime
instead of the artificial midnight value, and `sources:` removed from
`BENCHMARK.md`, a benchmark records a measurement rather than describing
repo code, and its previous self-referential `docs/okf/` entry would have
gone stale on every bundle change. No content changes; no sources changed
between authoring and this verification.

`index.md` links switched from bundle-root-absolute (`/name.md`) to
same-directory relative (`name.md`): GitHub resolves a leading `/` against
the repository root, so the absolute form 404s when browsing this directory
on GitHub. Relative links are equally OKF-conformant.

Benchmark comparison recorded in `BENCHMARK.md`: M1 15/24 → 17/24, M2 flat
4/12, both affirmatively wrong baseline answers eliminated. Decision: go for
okf-kit Phase 1, with the oracle frontmatter-awareness work pulled forward.

Initial bundle authored: 13 concept docs (architecture, backend, frontend, mcp-server, mcp-bridge, confidence-scorer, governance-merge, workflow-gates, claim-model, release-flow, deploy, reconcile-done-but-open, task-lifecycle) plus `index.md`. OKF Phase-0 pilot for agent-tasks (task `9cdc0436-4599-44f0-825b-c1c4ed6a3b90`). Every claim verified against source at authoring time.

## 2026-08-31: task-lifecycle.md re-verified after the project_tasks summary change (task 3653962f)

- Trigger: this branch edits `mcp-server/src/tools.ts` (a `sources:` entry of task-lifecycle.md), so the doc goes sources-fresh STALE on commit.
- Method: read the doc's claims that rest on tools.ts (the verb surface list and the per-verb lifecycle semantics) against the branch diff; the diff touches only the `project_tasks` tool (description, include, projection wiring), none of the lifecycle verbs the doc describes.
- Verdict: no drift; timestamp bumped without content change.

## 2026-10-03 (status write residual fixes after review)

Re-verified `workflow-gates.md`, `task-lifecycle.md`, `governance-merge.md`, `backend.md`, `claim-model.md` and `reconcile-done-but-open.md` against the follow-up change to `backend/src/routes/tasks.ts`, `backend/src/services/task-status-cas.ts`, `backend/src/services/audit.ts` and `backend/src/services/grounding-github-observation-context.ts`. The writes that follow a PR merge (`/merge` and the autoMerge forms of `/finish`) no longer answer a plain `409` when the PR-merge webhook moved the task to `done` first: they complete against the fresh row, or answer `409 merged_but_status_changed` with a `task.merged_status_conflict` audit event; `/review` stores its comment in the guarded transaction; the observation writer bumps `Task.statusVersion` when it sets a status. `workflow-gates.md` and `task-lifecycle.md` carry the corrected paragraphs and `workflow-gates.md` its re-pointed `tasks.ts` line citations; `governance-merge.md` gained one sentence on the observation writer. The claims of the other three did not change. All six were re-stamped.


## 2026-10-03 (merge-race wording)

Re-verified `task-lifecycle.md` items 4 and 5 against `casUpdateTaskStatusAfterMerge` in `backend/src/services/task-status-cas.ts`. The post-merge retry completes against any row already in the target status, whichever writer moved it, so the text now says "another writer (typically the system's own PR-merge webhook)" instead of attributing the move to the webhook alone. Wording only, no behaviour change; the doc was re-stamped.

## 2026-10-04 (post-merge loss reporting and result policy)

Re-verified `workflow-gates.md` and `task-lifecycle.md` against `casUpdateTaskStatusAfterMerge` in `backend/src/services/task-status-cas.ts` and `writeStatusCas` in `backend/src/routes/tasks.ts`. The completion against a row another writer already set to the target status now keeps that row's `result` (written only while null) and its audit event carries `priorStatus`, `priorStatusVersion` and `resultKept`; a lost retry re-reads the row before reporting `currentStatus`; the `merged_but_status_changed` message tells a moved status (reconcile by hand) from a moved claim only (retrying is safe). The corrected paragraphs are in both docs, which were re-stamped. The four other docs that list `routes/tasks.ts` as a source make no claim about these writes (checked their text for the post-merge write, compare-and-swap and result wording); they were re-stamped without a content change. A later review round re-pointed every `routes/tasks.ts` line citation in `workflow-gates.md` (15 citations: the `evaluateV2TransitionGates` definition and its callers, the `/transition` route, force check and forced audit action, the `PATCH` status lane and its rule call, and the five cross-repo guard calls) to the current lines after checking each target's content, found no line citation in the other docs, and reworded the claims about what the row can tell apart (webhook from other writers by the claims, not an approval from an admin write), the result write (conditional on the result still being null) and the approval signal (carries the stored result when the other writer's was kept). All six docs were re-stamped.

## 2026-10-04 (docs drift fixes: deploy-verify-strategy.md and BoardView.tsx)

Re-verified `deploy.md` and `frontend.md` against the changed sources. `docs/deploy-verify-strategy.md` only reworded its closing sentence about workflow templates; `deploy.md`'s claims about it (design decision, operational follow-ups, ADR 0014, custom workflows) still match the doc. `BoardView.tsx` only changed a header comment; `frontend.md`'s column-gated create claim still matches the condition at `BoardView.tsx:197`. Both docs were re-stamped without a content change.

## 2026-10-10 (mcp-server.md refresh)

Re-verified every claim in `mcp-server.md` against `mcp-server/src/tools.ts`, `errors.ts`, `read.ts`, `server.ts`, `index.ts`, `legacy-flag.ts` and `CHANGELOG.md`. Fixes: the `project_tasks` row-allowlist sentence now mentions `totalLabels` / `totalBlockedBy` (added when a list is clamped, `projectTaskCore` in `read.ts` and the tool description); the legacy claim verb is named `tasks_claim` (the deprecated alias), not `claim`; the stale `tools.ts:803` anchor (it now points at the tool's `name:` line) is re-pointed to the description line, and every bare `file:line` citation gained a string anchor. The `merge_in_progress` paragraph, the idempotency-key text, the external-grounding transport verbs, and `SERVER_VERSION` / `package.json` (both `0.16.0`) match the source. The `Unreleased` changelog entries (the `tasks_list` cursor and `truncated` notes, the numeric enum rendering, the `task_start` distinct-reviewer note) change no claim in the doc. The doc was re-stamped.

## 2026-10-12 (release-flow.md: package CHANGELOG cut)

Steps 2 and 3 of `release-flow.md` now name the package CHANGELOG cut: the `## Unreleased` entries of `mcp-server/CHANGELOG.md` and `mcp-bridge/CHANGELOG.md` move under the new version heading in the same commit as the version bump. The lockstep pin and the bridge-after-server-publish order were already stated in those steps and are unchanged. The package CHANGELOGs are not added as `sources` (release notes change every release without changing the procedure). The doc was re-stamped.

## 2026-10-12 (frontend.md: point-in-time references moved here)

`frontend.md` no longer carries the history behind two behaviours; it is recorded here instead. The column-gated create affordance on the board (the header `+` only on `Backlog` and `Open`) was an operator decision of 2026-08-20, shipped in `#483`. The backlog-first default of the create modal (`DEFAULT_CREATE_STATUS`, `"backlog"`, for human-initiated creates too) shipped in `#482` and replaced the earlier agent-only backlog default. The behaviour descriptions in `frontend.md` are unchanged.

## 2026-10-12 (re-verification after the string, flag and config alignment)

Re-verified `architecture.md`, `auth.md`, `backend.md`, `claim-model.md`, `cli.md`, `confidence-scorer.md`, `deploy.md`, `frontend.md`, `governance-merge.md`, `mcp-bridge.md`, `mcp-server.md`, `permissions-model.md`, `reconcile-done-but-open.md`, `signals-and-notification-delivery.md`, `task-lifecycle.md` and `workflow-gates.md` against the changed sources: `backend/src/routes/tasks.ts` (message and comment text only, no line moved), `backend/src/services/signal.ts` (the `task_assigned` union member removed), `backend/prisma/schema.prisma` (comments), `docker-compose.prod.yml`, `backend/package.json` (dev script), `cli/src/index.ts` and `cli/src/api.ts` (`tasks claim --force-reason`), `mcp-server/src/errors.ts`, `tools.ts`, `primer.ts`, `client.ts` (strings and the creator-abandon pattern, no line moved in `errors.ts`) and `mcp-bridge/src/token-store.ts` (hint text).

Content changes: `cli.md` states the `--force-reason` rule; `task-lifecycle.md` says creator-abandon covers open and backlog tasks and quotes the new 409 text; `deploy.md` lists the optional settings the compose file now forwards; `claim-model.md` and `signals-and-notification-delivery.md` no longer list `task_assigned` and cite the shifted `signal.ts` lines. The other docs needed no content change: their claims (gate placement, force-transition admin check, error mapping, token resolution) still match the code. Verdict: no drift beyond the edits above; timestamps bumped.


## 2026-10-12 (review follow-up: stale-when-done sentence, engines floor)

`signals-and-notification-delivery.md` no longer names `task_assigned` in the sentence about pickup skipping pending rows of done tasks: `STALE_WHEN_DONE` in `backend/src/routes/tasks.ts` holds `review_needed` and `task_available` only. `architecture.md` lists `package.json` as a source, which now carries `engines.node` `>=22.9`; it makes no claim about the Node floor, so it was re-stamped without a content change. Both docs were re-stamped.

## 2026-10-25 (deploy.md: backend docker smoke job)

Re-verified `deploy.md` against `.github/workflows/docker-smoke.yml`, `tools/backend-docker-smoke.sh`, `tools/frontend-docker-smoke.sh` and `tools/compose.smoke-override.yml`: the new `backend-prod-images` job (migrate exit 0, `GET /api/health` 200 with database ok, compose healthcheck `healthy`, restart count above zero fails), the widened path filters, the override detaching the smoke backend from `traefik`, and the job staying a non-required check. The backend config and workflow route changes of the zod 4 migration (`backend/src/config/index.ts`, `backend/src/config/grounding-runtime.ts`, `backend/package.json`, `backend/src/routes/workflows.ts`) change no claim in the doc (`emptyAsUnset`, the defaults, `FIXED_STATE_NAMES` and `workflowDefinitionSchema` are unchanged). The doc was re-stamped.

## 2026-10-25 (deploy.md, backend.md, architecture.md: migrate fails closed)

Re-verified after the change that removes `--accept-data-loss` from `Dockerfile.migrate`. `deploy.md`: the migrate `CMD` claim (push without the flag, then the two SQL steps joined by `&&`), the failure behaviour (a destructive diff fails `migrate`, recreated services stay in `Created` until agent-relay's rollback) and the pointer to the deliberate path in `docs/ops-backups.md` match `Dockerfile.migrate` and `docker-compose.prod.yml`; the backend docker smoke paragraph still matches the scripts and the workflow after the squash merge. `backend.md`: `backend/package.json` gained `js-yaml` and `@types/js-yaml` as devDependencies for the migrate guard test; the doc makes no dependency claim that changes. `architecture.md`: the compose topology line (one-shot migrate via `prisma db push`) is unchanged. The three docs were re-stamped.


## 2026-10-27 (GET /projects/:id returns canAdmin)

`permissions-model.md` gained a paragraph on what the project read reports: `accessSource` and `accessRole` still come from `getProjectMembership` (team role first), and the new `canAdmin` is the `isProjectAdmin` result the admin-gated routes use; re-verified against `backend/src/routes/projects.ts` (the `GET /projects/:id` handler) and the five `isProjectAdmin` calls in `backend/src/routes/workflows.ts`, and against the integration test that runs the real routes. `frontend.md`: the effective-workflow fetch claim now names `projectCanAdmin` (server `canAdmin` when it is a boolean, the `isProjectAdminRole(accessRole)` rule only as the fallback); re-verified in `frontend/src/lib/api.ts`, `frontend/src/app/tasks/[id]/page.tsx` and `frontend/src/app/projects/[id]/board/page.tsx`, and the `isProjectAdmin` claim in the reassign-picker paragraph still holds. `backend.md`, `confidence-scorer.md` and `signals-and-notification-delivery.md` cite `backend/src/routes/projects.ts` for the settings PATCH, the eligible-actors route, the BLOCK acknowledgement and the webhook configuration; none of those handlers changed, so no claim moved. The five docs were re-stamped.

## 2026-10-27 (deploy.md: arm64 Prisma engine in the backend image)

Re-verified `deploy.md` after `backend/Dockerfile` installs openssl in the build stage and `backend/prisma/schema.prisma` adds the `linux-arm64-openssl-3.0.x` binary target. The doc cites `backend/Dockerfile` by path only and makes no claim about engine targets or the host platform; the prod-stage claims (openssl installed, `node_modules/.prisma` copied from the build stage) and the backend docker smoke paragraph still match `backend/Dockerfile` and `tools/backend-docker-smoke.sh`. The doc was re-stamped.

## 2026-10-27 (frontend.md: /tasks focus recovery and dropdown key isolation)

Re-verified `frontend.md` after `frontend/src/app/tasks/page.tsx`, `tasks/_components/columns.tsx` and `components/ui/DropdownMenu.tsx` changed: a row action that removes its row hands focus to the neighbouring row's trigger (or the results region) from an effect after the commit, the load banner's dismiss and Retry keep focus on mounted elements, and every DropdownMenu stops keydown propagation while open. The doc's `/tasks` row-actions and two-list-views claims still hold; it cites none of the edited lines by number. The doc was re-stamped.

## 2026-10-27 (ten docs: Grounding 403 refusals carry messages)

Re-verified after the Grounding routes and services gave their 403 refusals a `message` naming the precondition (missing token scope, no write access, no claim, consent, self-merge, review lock, role, another actor's attempt or Idempotency-Key) and the MCP layer passes it through with a per-verb recipe. `backend.md` and `architecture.md`: the attempt routes still run `admit` (task lookup, lock-free write check) at `grounding-attempts.ts:73` before any detail-bearing refusal, and a caller without access still gets one bare 403. `permissions-model.md`, `workflow-gates.md`, `governance-merge.md`, `claim-model.md`, `task-lifecycle.md` and `reconcile-done-but-open.md`: their scope, gate, self-merge and claim statements still hold; the cited lines in `grounding-github.ts` and `grounding-task-completion.ts` are unchanged. `mcp-server.md`: the `errors.ts` and `tools.ts` anchors still resolve. `signals-and-notification-delivery.md`: the `deliver(signal)` citation is re-pointed from `grounding-completion.ts:240-245` to `:245-250`. The ten docs were re-stamped.
