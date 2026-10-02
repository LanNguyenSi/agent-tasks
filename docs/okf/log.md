# Change log

## 2026-10-02 (grounded finalDisposition)

Re-verified `backend.md`, `reconcile-done-but-open.md`, `governance-merge.md`,
`task-lifecycle.md`, `workflow-gates.md` and `architecture.md` against the
changed grounding sources (comments only). `task-lifecycle.md` now states
that the grounded creator-abandon and admin restore reuse the REST handlers
and their post-commit `finalDisposition` write and clear. The other docs'
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
"task_creator_abandon"]`; the code at `mcp-server/src/errors.ts:764`
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
