---
type: invariant
title: "v2 transition gates: precondition rules, branch folding, cross-repo guard"
description: "branchPresent/prPresent/ciGreen/prMerged return 422 precondition_failed; branchName is folded atomically into task_start's claim; prUrl payloads are checked against the project's linked repo."
tags: [workflow, gates, transitions, precondition]
timestamp: 2026-10-01T11:36:22Z
sources:
  - backend/src/services/grounding-completion.ts
  - backend/src/services/grounding-finalization.ts
  - backend/src/services/grounding-context-mutation.ts
  - backend/src/routes/grounding-task-completion.ts
  - backend/src/routes/grounding-direct-tasks.ts
  - backend/src/services/grounding-direct-context.ts
  - backend/src/services/transition-rules.ts
  - backend/src/services/gates/pr-repo-matches-project.ts
  - backend/src/services/workflow-templates.ts
  - backend/src/services/default-workflow.ts
  - backend/src/routes/workflows.ts
  - backend/src/services/grounding-context-mutation.ts
  - backend/src/routes/tasks.ts
  - backend/prisma/schema.prisma
  - backend/src/services/confidence-gate.ts
  - backend/src/routes/grounding-github.ts
  - backend/src/services/grounding-scope.ts
  - backend/src/services/github-merge.ts
  - backend/src/routes/github.ts
  - docs/grounding-receipt-contract.md
---

**Four built-in transition rules** (`backend/src/services/transition-rules.ts`, `TransitionRule`): `branchPresent` (sync: non-empty `task.branchName`), `prPresent` (sync: both `prUrl` and `prNumber` set), `ciGreen` (async, GitHub-backed: every check run on the PR's head SHA must be `success`), `prMerged` (async, GitHub-backed: the PR must be in the closed-merged state, open, draft, and closed-unmerged all fail). `ciGreen`/`prMerged` are in `GITHUB_BACKED_RULES` and fail closed on any network/API error (`evaluateTransitionRules` catches per-rule throws; a `GithubChecksError` surfaces its status, anything else collapses to a generic "Rule evaluation error"). Workflows attach these to a `transitions[].requires` array (per-transition, per-workflow).

**422 shape**: any route evaluating these rules returns `{ error: "precondition_failed", message, failed: [{rule, message, error?}], canForce: false }` with HTTP 422 when one or more required rules fail. Two call shapes exist (`backend/src/routes/tasks.ts`): the shared helper `evaluateV2TransitionGates` (defined ~line 2539; it resolves the effective workflow definition (or the built-in default), filters any `skipRules` (e.g. `autoMerge` strips `prMerged` from the pre-check since the merge hasn't happened yet), checks `requiredRole`, then calls `evaluateTransitionRules`) is called from `POST /tasks/:id/start` (line 2107), `POST /tasks/:id/finish` (lines 2761, 3036, 3488), and `POST /tasks/:id/claim` (line 6595); `POST /tasks/:id/transition` (v1, route at line 6844) and the human `PATCH /tasks/:id` status-write lane (route at line 4770, gate call at line 5129) instead call `evaluateTransitionRules` directly and build the same 422 shape inline. `POST /tasks/:id/review` does not evaluate transition rules at all. **`{force: true}` is not a general escape hatch for these routes**: it is wired into exactly one of them, `POST /tasks/:id/transition` (v1, `backend/src/routes/tasks.ts` route at ~line 6844), gated on `isProjectAdmin` (~line 6874) unconditionally before the precondition check, and audited as `task.transitioned.forced` (~line 7080) with the bypassed rule names and an optional `forceReason`. `task_start`/`task_finish`/`task_review` (the v2 verb surface) accept no `force` field at all for these four transition rules, and always report `canForce: false` for them; there is no non-admin and no v2-verb bypass for a failing transition rule. (`force` does appear on `/start` and `/claim`, but for a different gate entirely: the ADR-0011 confidence-override, its own `confidence:override`-scoped bypass, `confidence-gate.ts:78`; not a transition-rule bypass.)

*Line numbers above were checked against `backend/src/routes/tasks.ts` at the commit this doc is stamped for; they drift as the file grows; see the separate citation-audit mechanism (agent-dx task 2e7680f6, okf-kit backlog) for keeping this class of claim mechanically fresh rather than by periodic manual re-grep.*

**No-PR task classes** (`workflow-templates.ts`, template `release-ops-no-pr`, agent-tasks 5107416c): a task whose class never produces a branch or a PR — a tag-only release, a config/ops action — hits `422 precondition_failed` on the default workflow's `in_progress → review`/`→ done` edges with `canForce: false` and no agent-side recovery, because both edges require `branchPresent`/`prPresent` there. Rather than adding a bypass to the gate evaluator, this is handled by applying a different, registered workflow: the `release-ops-no-pr` template is the default four-state workflow with exactly those two `requires` arrays dropped, every other edge (including the normal `review → done`/`→ in_progress` flow) unchanged.

**Audit trail depends on how the template is applied.** Assigning it per task — `task_create({ workflowId })` against a *non-default* `Workflow` row (`POST /workflows { isDefault: false }`, seeded from the template's `definition`) — is per-task auditable: that one task's `workflowId` records the exception, and `result` (written on `task_finish`) stands in for the evidence a PR link would otherwise provide. `POST /projects/:projectId/workflow/apply-template/:slug` (`backend/src/routes/workflows.ts`, template-application handler) is a different path: it always persists the workflow with `isDefault: true`, so any task subsequently created without an explicit `workflowId` resolves to it silently via the project-default lookup and itself carries `workflowId: null` — the audit trail for *those* tasks is the project's default-workflow row plus the `workflow.template_applied` audit event, not a per-task marker, and every task in the project (not just release/ops ones) loses the branch/PR gates. **Operator guidance**: in a mixed project (regular code tasks + release/ops tasks), do not `apply-template` this one as the project default — create a non-default named workflow from it instead and assign it per task.

**Grounding context writers**: workflow customize, template application, reset,
default creation or replacement, and definition updates use the shared context
mutation protocol. Before the route writes, it locks the project and selected
tasks, rejects an active finalization reservation, and rechecks project-admin
authority. A project-default change selects null-`workflowId` tasks because
they inherit the default; a definition update also selects explicit references
to that workflow. Reset selects both explicit references that it detaches and
inherited tasks. A name-only update and non-default workflow creation leave
existing grounding attempts unchanged. Configured GitHub creation and webhook
writers participate in the same shared context-mutation protocol (see
`governance-merge.md` and the [receipt contract](../grounding-receipt-contract.md)).
Public MCP transport remains separate follow-up work.

`Task.workflowId` can only be set at task-create time: `updateTaskSchema` (the PATCH body schema) has no `workflowId` field at all, so a PATCH payload naming one has it silently stripped/ignored by Zod (`z.object()` strips unrecognized keys by default — this is not a rejected/400 request), not persisted. A task already created under the default workflow therefore cannot be migrated onto this template after the fact; recovery for an already-stuck task stays the admin-only forced `/transition` path described above.

**branchName atomic fold** (`POST /tasks/:id/start`, open→in_progress branch): if the caller supplies `branchName` in the request body AND the task has none yet, it is folded into the *same* gate-evaluation input (`effectiveBranchName = task.branchName ?? providedBranchName ?? null`) and persisted in the *same* `prisma.task.updateMany` compare-and-swap that claims the task (`willPersistBranchName = providedBranchName !== undefined && task.branchName === null`), so a `branchPresent`-gated project can pass its own start-transition gate on the call that claims the work, and a failed gate never leaves a stranded `branchName` write. If the task already has a `branchName`, a supplied value is silently ignored (idempotent re-calls stay safe; overwriting would destroy a pre-existing value).

**Provisioned direct routes**: an enrolled task's direct transition, review and status-PATCH routes are resolved under a locked, persisted route descriptor. The server applies the workflow, role and review gates to that descriptor and rechecks it when a receipt is ingested. A positive decision needs an `Idempotency-Key`; the only direct force path is a human-admin transition with a nonblank reason. This does not relax the existing v2 claim model, and it does not cover indirect workflow, webhook or MCP writers.

**Cross-repo `prUrl` guard** (`checkPrRepoMatchesProject`, `backend/src/services/gates/pr-repo-matches-project.ts`, ADR-0010 §5b): active only when `project.githubRepo` is set. Parses `owner/repo` out of both the `prUrl` payload (`github\.com\/([^/]+)\/([^/]+)\/pull\/`) and `project.githubRepo`, case-insensitive compare; a mismatch is rejected, at `task_finish` (`backend/src/routes/tasks.ts` line 3462), `submit-pr` (line 3819), and both actor branches of `PATCH /tasks/:id` (agent lane line 4833, human lane line 4905), with `400 { error: "cross_repo_pr_rejected", message }`. Prevents an agent token valid for project A from driving a merge against project B's repo via a spoofed PR URL.

**`externalRef` idempotency**: `Task.externalRef` (nullable `String`) has `@@unique([projectId, externalRef])` in `backend/prisma/schema.prisma`. `POST /projects/:projectId/tasks` catches `Prisma.PrismaClientKnownRequestError` code `P2002` on that constraint and returns `409` (`conflict(c, ...)`) with a message naming the duplicate `externalRef`, repeated task-creation calls with the same external key are safe to retry.

Related: `claim-model.md`, `governance-merge.md`, `task-lifecycle.md`.

**Shared grounding service boundary** (`grounding-completion.ts`,
`grounding-completion-gates.ts`, `grounding-finalization.ts`): selects the
semantic edge and retains current access/claim, role, review and CI checks.
Required CI retains the existing classification/cache policy and additionally
binds the reported CI SHA to the freshly observed decision, the signed head of
a `CODE_HEAD` receipt and the reserved head. Its stored PR URL check compares
with the project repository, owner/repo case-insensitively, and the PR number
exactly; a repository name with surrounding whitespace never matches. Cached prior-head green results block until normal refresh.
Unknown rules fail closed at this boundary. Local foreign-deliverable rule
skips retain their existing meaning and are recorded in the decision audit;
remote foreign merges are refused. An explicit human-admin grounding override
with a reason does not bypass these other gates. Persisted cohort mode alone
selects external, legacy-local or OFF; external errors never fall back. The
per-app provisioned completion router now invokes these services before
completion/disposition effects. It preserves the semantic finish/approve/merge
edge and requires canonical transport plus a durable operation key; the
historical unprovisioned handlers remain separate. On a configured app the
routers make only exact decisions (admission, task lookup, the caller's
access, durable keyed history, enrollment mode, and whether the task's own
project is in the configured `creationPolicy` scope): a fresh remote operation
(task merge, GitHub merge, finish with `autoMerge`) on an unenrolled task in
that scope returns `409 grounding_enrollment_required` before any remote
effect rather than falling back to the unprovisioned handler
(`grounding-task-completion.ts:114`, `routes/grounding-github.ts:142`), and
outside it the untouched request falls back to the unprovisioned handler,
including without an operation key (`grounding-task-completion.ts:118`,
`routes/grounding-github.ts:141`). The unprovisioned handler's transition
gates run as before; the handler is unchanged except for a target check at its
effect boundary (`grounding-scope.ts:103`): with configuration enabled,
`performPrMerge` checks the exact repository and PR number right before the
GitHub merge call (`services/github-merge.ts:114`), and the legacy PR creator
and commenter check the repository (and PR) they post to
(`routes/github.ts:267`, `routes/github.ts:768`). The check refuses with
`409 grounding_enrollment_required` a repository string that is not exactly
canonical, an enforced repository, a protected/`EXTERNAL_V1`/bound/held task's
PR (including such a task whose own repository string is not canonical and
that shares the number), and a merge or create whose requesting task is itself
such a task, whatever PR number it sends; it refuses a merge or create with
`409 grounding_finalization_pending` when another operation owns the fence of
the target repository or of any repository the legacy task write's fence
trigger checks for the requesting task (its effective repository, stored PR
URL repository and own active PR-create intents' repositories). Comments write
no task and take no fence. A comment is refused on an enforced repository and on a peer's PR whoever sends
it, the PR the requesting task stores included, since an agent can set a
task's PR number and repository. As defense in depth, enforced repositories
must still not run comment-triggered merge or deploy automation; direct GitHub
access outside agent-tasks (tokens, the GitHub UI, other apps) is not governed
by the check. With configuration enabled a GitHub redirect on any of the
three legacy writes (a renamed or transferred repository) is answered with
`409 github_redirect_refused` instead of being followed
(`services/github-merge.ts:156`, `routes/github.ts:297`,
`routes/github.ts:791`). The configured GitHub create and merge routes check
the caller's project access with the legacy rule right after the task lookup,
before any Grounding read or lock (`routes/grounding-github.ts:82`,
`routes/grounding-github.ts:130`), so a caller without access gets the legacy
handler's own 403. Outside the enforced scope they read only the task id and a
well-formed key for the history lookup, then hand the request to the legacy
handler unmodified; the principal differences from the unconfigured app are
the boundary and in-scope refusals, the refusal of renamed or transferred
repository writes, the agent-scope admission check that runs first, a
transient `503 grounding_verification_unavailable` from the Serializable
routing read, and the GitHub merge route's `503` retry message. Enabling
configuration still writes grounding history (webhook deliveries, for
example), so a later unconfigured restart is refused and enabling is one-way,
and rollback keeps an enabled configuration with empty trust and an empty
`creationPolicy`. Startup itself refuses when a project outside the enforced
scope shares a GitHub repository with an enforced one, when an enforced
project's repository is not canonical, and, while the scope owns a repository,
when any project's repository is not canonical; a project created or
re-pointed after startup is not re-checked. The boundary read is
point-in-time, one database round trip before the GitHub call, and two
residual races within that window are accepted: a change after the read that
makes some task a protected/`EXTERNAL_V1`/held peer of the targeted PR (an
admin rebinding a repository or PR, a migration hold, an enrollment) is not
seen, and a grouped operation that acquires one of the checked fences after
the read lets the legacy GitHub effect happen while the legacy task write
fails on the fence (a merge lands with the task still in review; a create
leaves an unlinked PR). See the [shared receipt consumer
contract](../grounding-receipt-contract.md).

An independent administrative hold is checked before cohort selection or unprovisioned fallback. It blocks fresh task completion and evidence use, including force/override paths; the database guard freezes all task-row updates and deletes. Existing claims and cohort history remain stored. See [migration and resume](../grounding-migration.md).

The runtime creation policy also covers signed issue-open deliveries. For selected projects, the existing `open` status must exist in the effective workflow and must not be review or terminal. Task creation and provisioning share the delivery transaction; this does not grant a completion decision or relax transition gates.
