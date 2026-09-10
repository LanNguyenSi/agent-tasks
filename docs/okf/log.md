# Change log

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
