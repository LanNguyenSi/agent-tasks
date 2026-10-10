- 2026-10-10T06:36:28Z, task da6e6e67: `POST /tasks/:id/claim` (`routes/tasks.ts`) now refuses a status outside the workflow's initial state and the review holder as work claimant, both on the pre-lock read right after the backlog guard (a specific `409 bad_state`, ahead of the dependency, confidence and transition-rule gates) and, for the identity rule, again in the locked revalidate; the review-holder stand-in is one helper shared with `admin-reassign`. `claim-model.md` gained a paragraph on both rules and the race; `workflow-gates.md` says that `/claim` reaches its lost-race `409` text only for a lost race, and its `routes/tasks.ts` line citations (the `evaluateV2TransitionGates` definition and its `/start`, `/finish` and `/claim` callers, the `/transition` route, its `isProjectAdmin` force check and forced audit action, the `PATCH` route and its rule call, and the cross-repo guard calls) were re-pointed by reading each target line at head (they sat 4 lines off before this change and the new `/claim` code moves everything after it by about 35). `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` list `routes/tasks.ts` as a source, cite no line of it and make no claim about the `/claim` route's checks (`reconcile-done-but-open.md` and `task-lifecycle.md` describe `task_start`, not `/claim`), so they were re-read and re-stamped without content change.
- 2026-10-10T05:22:00Z, task 7fc13bcc (fix round): the review-claim branch of `POST /tasks/:id/start` (reason `task_start_review_claim`, used by the MCP `task_start` verb) re-runs `checkDistinctReviewerGate` in its revalidate against the locked row, like `POST /tasks/:id/review/claim` (`routes/tasks.ts`); both are the only routes besides `admin-reassign` that grant a review claim. `claim-model.md` now names both routes in its paragraph (renamed from the `/review/claim`-only wording) and `workflow-gates.md` names both in the lock-only writers sentence. `frontend.md` records the accessible names of the reassign button and the now required `onClaimReassigned` prop of `TaskMetaSidebar`. `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` were re-read against the changed code and re-stamped without content change.
- 2026-10-10T04:56:51Z, task 7fc13bcc: `POST /tasks/:id/review/claim` now re-runs `checkDistinctReviewerGate` in its revalidate against the locked row (`routes/tasks.ts`), and the task view gained the admin reassign picker (`ClaimReassignPicker.tsx`, `TaskMetaSidebar.tsx`, two api helpers, `.td-reassign*` styles). `claim-model.md` gained a paragraph on the review-claim re-check and `workflow-gates.md` names it in the lock-only writers sentence; `frontend.md` gained a paragraph on the picker and lists its sources. `backend.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` list `routes/tasks.ts` as a source, cite no line of it and make no claim about the review-claim revalidate, so they were re-read and re-stamped without content change. `frontend.md` was re-checked against its `frontend/package.json` claim (`next@^15` still holds), so only `architecture.md` (on `frontend/package.json`) and `mcp-server.md` (on `mcp-server` files) remain STALE; both predate this change and are not part of it.
- 2026-10-09T20:47:30Z, task 8296adcd (follow-up): `claim-model.md` was also re-read against `mcp-server/src/errors.ts` and `task-lifecycle.md` against `mcp-server/src/tools.ts`, with no content change. The distinct-reviewer rule was extended to the work claim (a project that requires a distinct reviewer refuses handing the work claim to the current review holder, checked before the transaction and again under the lock), so `claim-model.md` no longer lists that as not covered.
- 2026-10-09T20:23:19Z, task 8296adcd: `POST /tasks/:id/admin-reassign` (a sibling of `admin-release`) and `GET /projects/:id/eligible-actors` were added (`routes/tasks.ts`, `routes/projects.ts`, new `services/eligible-actors.ts`, new audit action `task.claim_reassigned`). `claim-model.md` gained a paragraph on the reassignment (authz, the eligible set, the single-active-claim and distinct-reviewer rules it mirrors, the holder-pinned write, the audit event) and names it in the grounding-context sentence; `backend.md` gained a paragraph on the eligible-actors route; `workflow-gates.md` lists `/admin-reassign` among the lock-only compare-and-swap writers and the writers that answer `merge_in_progress`. `workflow-gates.md` also carried 15 `routes/tasks.ts` line citations that no longer matched the file (they were off by up to about 150 lines before this change, and the new import and route move them further): each was re-pointed by reading the target line at head (the `evaluateV2TransitionGates` definition and its `/start`, `/finish` and `/claim` callers, the `/transition` route, its `isProjectAdmin` force check and forced audit action, the `PATCH` route and its rule call, and the four cross-repo guard calls). `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` list `routes/tasks.ts` as a source, cite no line of it and make no claim about the claim-release writers, so they were re-read and re-stamped without content change.
- 2026-10-07T04:24:51Z, task 7f0a62f5: a GitHub 5xx answer to the merge PUT is now an unknown outcome (`github-merge.ts` sets `outcomeUnknown` on a status of 500 or above and keeps GitHub's status; the source change is four lines after the 405 and failure audit, so no citation of `github-merge.ts` moved: the cited lines 143, 162, 195 and 220 are all above it) and the `performReservedMerge` doc comment in `routes/tasks.ts` says so (line count unchanged). `workflow-gates.md` now states the 5xx rule and the lapse boundary of `noLiveMergeReservation` (a lease exactly one TTL old has lapsed). `architecture.md`, `backend.md`, `claim-model.md`, `governance-merge.md`, `reconcile-done-but-open.md` and `task-lifecycle.md` list the changed files as sources, make no claim about the merge PUT's error classification, were re-read against the changed code and re-stamped without content change.
- 2026-10-06T09:48:48Z, task 06b06931 (follow-up): the source changes were comments on the merge reservation release in `routes/tasks.ts` and `routes/github.ts` and the `grounding_github_fence_conflict` 409 sentence on the finish and GitHub merge operations in `routes/docs.ts`; `routes/github.ts` gained one line, so the citations `routes/github.ts:840`, `:850` and `:863` in `architecture.md`, `backend.md`, `governance-merge.md` and `workflow-gates.md` moved to `:841`, `:851` and `:864`. `workflow-gates.md` now says the client stops waiting after 45 s and that GitHub completing the merge after the lease falls back to `merged_but_status_changed`. `claim-model.md`, `task-lifecycle.md` and `reconcile-done-but-open.md` make no claim about the changed text and were re-stamped without content change.
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
