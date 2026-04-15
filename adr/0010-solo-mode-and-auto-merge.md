# ADR 0010: Solo Mode & `task_finish { autoMerge }`

## Status
Proposed (2026-04-15)

## Context

ADR-0008 established the v2 verb-oriented MCP surface with a distinct-reviewer rule and a hard 1-claim-per-agent limit. The v2 gate-enforcement invariant was completed by b459be3 (`task_finish`), e53a50b (`task_submit_pr`), and edd9c73 (`task_start`) — every transition verb now evaluates workflow gates. The canonical flow for a `branchPresent`-gated project is:

```
task_start → (work + gh pr create) → task_submit_pr → task_finish
```

Two scenarios are still incomplete.

### 1. Solo operation

A single agent cannot take a task from `open` to `done` alone when the workflow has a review state:

- **Distinct-reviewer rule** (ADR-0008 §66–74): `task_pickup` prio 2 filters out tasks authored by the calling agent. The solo agent never sees its own task in the review pool.
- **Hard 1-claim limit** (ADR-0008 §60): the work claim is kept on transitions to `review` so `request_changes` can auto-resume the author. The solo agent is stuck — can't take another task, can't pick up its own for review.

The workaround today is to configure a review-less workflow (ADR-0008 §50–56 fallback `done`), which works end-to-end for solo agents once the gate fixes are in. But there's still no **atomic merge + finish** intent: after `task_finish {}` transitions the task to `done`, the agent must separately invoke the GitHub merge API. Two round trips for a conceptually single intent, and no shared audit record linking the merge to the task finish event.

### 2. Reviewer-triggered merge

Even in multi-agent projects with a distinct reviewer, the reviewer's `approve` intent logically includes "and merge". Today the reviewer calls `task_finish { outcome: approve }` to transition `review → done` and then must separately invoke the merge route. Same atomicity gap.

### 3. Existing infrastructure

`backend/src/routes/github.ts:135–342` already implements `POST /api/github/pull-requests/:prNumber/merge`:

- Requires agent-only caller with `tasks:transition` scope
- Uses `findDelegationUser(teamId, "allowAgentPrMerge")` to resolve the delegation token
- Enforces status `review` or `done` (distinct-reviewer gate fires on review path)
- Calls GitHub Merge API (`PUT /repos/:owner/:repo/pulls/:n/merge`)
- Handles the 405 "already been merged" idempotent case
- Sets `task.status = "done"`
- Emits `github.pr_merged` audit event with `{ delegatedUserId, delegatedUserLogin, owner, repo, prNumber, mergeMethod, sha }`

This ADR reuses this infrastructure wholesale. The `pull_requests_merge` MCP tool is deprecated per ADR-0008, but the backend route stays as the shared backbone. This ADR extracts the GitHub-call-plus-audit portion into a helper and invokes it from inside `task_finish` when `autoMerge: true` is passed.

## Decision

Three coupled additions. None requires new infrastructure; all reuse existing primitives.

### 1. `Project.soloMode` boolean

Schema: `Project.soloMode Boolean @default(false)`. Same shape as the existing `requireDistinctReviewer` governance flag (`schema.prisma:172`).

- **Toggle path**: `PATCH /api/projects/:id` with `{ soloMode: boolean }`. Same route used for `requireDistinctReviewer` and `confidenceThreshold`.
- **Authorization**: project-admin only (`isProjectAdmin` at `routes/projects.ts:220`). Note: the existing PATCH handler uses `isProjectAdmin`, not team-admin; soloMode follows the same check.
- **Schema extension**: the Zod `updateProjectSchema` at `routes/projects.ts:31–35` currently does NOT accept `soloMode` — the implementation must extend it with `soloMode: z.boolean().optional()`. This is an additive edit, not a refactor.
- **Audit**: the `project.updated` diff block at `routes/projects.ts:238–257` is **per-field, not generic** — it has explicit `if` branches for `requireDistinctReviewer` and `confidenceThreshold`. The implementation must add a third branch for `soloMode` that follows the same shape: `{ soloMode: { from: project.soloMode, to: body.soloMode } }`. A toggle produces a `project.updated` audit event with that payload.
- **Frontend warning**: project settings UI shows a warning banner when the toggle is flipped on: "Solo mode allows a single agent to merge its own PRs without a distinct reviewer. Branch protection rules on GitHub remain the primary safeguard — do not enable solo mode on repositories without `require_pull_request_reviews` and at least one required status check." No code decision here beyond the copy; the toggle mechanics are trivial.

### 2. `task_finish` accepts `autoMerge`

Payload extension:

```
task_finish {
  taskId: uuid,
  result?: string (max 5000),
  prUrl?: string (github regex),
  outcome?: "approve" | "request_changes",
  autoMerge?: boolean,                               // NEW
  mergeMethod?: "squash" | "merge" | "rebase"        // NEW, default "squash"
}
```

`autoMerge: true` has three acceptance modes:

**Mode A — Solo work-claim merge** (requires `soloMode: true` on the project):
- Caller holds work claim on task, task status `in_progress`.
- Workflow must allow `in_progress → done` (direct or via the fallback). If the resolved workflow only allows `in_progress → review`, autoMerge is rejected with `bad_request`.
- **Target-state override**: the autoMerge work-branch **bypasses** `expectedFinishStateFromDefinition` (which prefers `review` over `done` on the built-in default) and hard-sets `targetStatus = "done"`. The existence check for an `in_progress → done` transition in the resolved workflow is the authoritative gate — no implicit review-hop.
- Gates evaluated for `in_progress → done` except `prMerged` (see §3).
- On pass: merge helper called, task transitions to `done`, work claim cleared, `autoMergeSha` set.

**Mode B — Review approve + merge** (does NOT require `soloMode`):
- Caller holds review claim, task status `review`, `outcome: "approve"` in payload.
- Distinct-reviewer gate already enforced by `task_start`'s review-claim path upstream.
- Workflow allows `review → done` (the default workflow does).
- Gates evaluated for `review → done` except `prMerged`.
- On pass: merge helper called, task transitions to `done`, both claims cleared, `autoMergeSha` set.
- `outcome: "request_changes"` + `autoMerge: true` is **rejected** with `bad_request` — they are mutually exclusive intents. Enforced at the Zod schema boundary via `.refine()` on `finishReviewSchema`, not as a runtime check.

**Step order (Mode B)** — must match the existing merge route's ordering to preserve governance invariants:
1. Parse + validate payload (Zod catches `outcome`/`autoMerge` mutex and `autoMerge` without `soloMode`/review-approve).
2. State = `review` check.
3. Distinct-reviewer gate (re-run even though upstream already enforced it; defense in depth matches `routes/github.ts:242`).
4. `evaluateV2TransitionGates` for `review → done` with `prMerged` stripped (§3).
5. `performPrMerge` call.
6. `prMerged` post-check if the workflow required it (§3).
7. `prisma.task.update` → status `done`, clear both claims, set `autoMergeSha`.
8. Audit + signals (see §6 for the full list).

**Mode C — Rejected**: `autoMerge: true` without either Mode A (soloMode) or Mode B (review approve) conditions → 403 with a specific error code (`solo_mode_required` / `review_claim_required`).

### 3. `prMerged` gate during autoMerge

`prMerged` checks the live GitHub API for PR state `closed-merged` (`transition-rules.ts:103–119`). When the workflow has `prMerged` in the `requires` for the target transition, evaluating it as a pre-check during autoMerge is tautologically impossible — the merge hasn't happened yet.

Resolution:

- **Pre-check**: strip `prMerged` from the evaluated rule set when `autoMerge: true`. All other rules (`branchPresent`, `prPresent`, `ciGreen`) evaluate normally. This is a targeted filter, not a bypass — the rule's enforcement is deferred to the post-check.
- **Filter mechanism**: extend `evaluateV2TransitionGates` signature with an optional `skipRules?: readonly TransitionRule[]` parameter. The helper drops any listed rule from `resolvedRequires` before calling `evaluateTransitionRules`. The filter lives co-located with rule evaluation so callers can only mute rules at the evaluation boundary, not anywhere else. Documented usage: `skipRules` is for the autoMerge post-check contract ONLY and is NOT a general-purpose escape hatch.
- **Merge call**: invoke `performPrMerge` helper. If it returns failure (4xx/5xx from GitHub), the task is NOT transitioned. The error is propagated as `github_error` with status 502 (bad gateway — GitHub was reachable but rejected the merge). Audit event `github.pr_merge_failed` captures the attempt.
- **Post-check**: if `prMerged` was in the original requires, re-evaluate it AFTER the merge call returns success. This is a short GitHub API round-trip against the same PR.
  - **Success**: proceed with transition.
  - **Failure**: do NOT transition. Emit `task.auto_merge_post_assert_failed` audit event (LOUD — admin dashboard should surface this). Return a 502 `github_error` to the caller with a clear message. The task stays in its prior status; the merge on GitHub is already committed but the task does not claim `done`. This is an extremely rare "GitHub said success but the poll says not merged" state (could be replication lag or GitHub API bug). It is left to an operator to reconcile.
  - **Rationale for fail-closed**: `transition-rules.ts:20` documents the invariant "A broken GitHub API must NOT silently bypass the gate." Silently marking done after a failed post-check would break that invariant. The first-draft review of this ADR correctly flagged "warning, done anyway" as too loose.
- If the workflow does NOT have `prMerged` in its requires, no post-check runs. The merge helper's success response is authoritative.

### 4. Shared merge helper

Extract `backend/src/services/github-merge.ts` → `performPrMerge(task, mergeMethod, actor)`:

```
async function performPrMerge(task, mergeMethod, actor): Promise<
  | { ok: true; sha: string | null; alreadyMerged: boolean }
  | { ok: false; error: "no_delegation" | "github_error"; message: string; status?: number }
>
```

- **`owner/repo` is derived from `task.project.githubRepo`** (parsed via `parseOwnerRepo` in `transition-rules.ts:76`), **NOT** from `task.prUrl` and **NOT** from any request body. This is a hardening change vs. the existing `routes/github.ts:128–133` behavior, which currently trusts `owner`/`repo` from the request body — see §7 for the cross-repo exploit path this closes.
- **`prNumber` is read from `task.prNumber`** (set by `task_submit_pr` or `task_finish { prUrl }`), NOT from request body.
- Resolves delegation user via `findDelegationUser(task.project.teamId, "allowAgentPrMerge")` — same as existing route.
- Calls `PUT /repos/:owner/:repo/pulls/:n/merge` — same as existing route.
- Handles 405 "already been merged" as `alreadyMerged: true, ok: true, sha: null` — same idempotent behavior. Callers that need a SHA on the already-merged path must re-query via `prMerged` post-check.
- Emits `github.pr_merged` audit event — same payload shape.
- Returns the merge SHA (or null for already-merged idempotent path).

Both call sites use this helper:

1. The existing `POST /api/github/pull-requests/:prNumber/merge` route (`routes/github.ts:135+`) is refactored to call `performPrMerge` instead of inlining the GitHub call. Behavior is preserved EXCEPT for one deliberate tightening: the route's `owner`/`repo`/`prNumber` body fields become **ignored in favor of values derived from the task**. Callers that previously passed mismatched body values will see a behavior change (the merge hits the task's actual repo); this is a bug fix, not a regression, and the test suite should pin the correction.
2. `task_finish` in the new autoMerge path calls `performPrMerge` inline and plumbs the result into the transition logic.

The helper is the single point where `allowAgentPrMerge` delegation is resolved and the GitHub API is called. No duplication, no divergence.

### 5. `Task.autoMergeSha` column

Schema: `Task.autoMergeSha String?`.

- Written only on the autoMerge path, never on the manual merge route.
- Captures the merge commit SHA returned by the GitHub API on the autoMerge call.
- Used for **retry idempotency** (see §8).
- **Naming**: "autoMergeSha" (not "mergeSha") to signal this is specifically an audit anchor for the in-process autoMerge flow, not a general "current HEAD after merge" field. Future webhook sync work can add a separate column if needed; this one is scoped to autoMerge's local atomicity story.

### 5a. Schema extensions

Two Zod schemas in `tasks.ts` must gain the `autoMerge` + `mergeMethod` fields:

- `finishWorkSchema` (`tasks.ts:~1021`): adds `autoMerge: z.boolean().optional()` and `mergeMethod: z.enum(["squash","merge","rebase"]).optional().default("squash")`.
- `finishReviewSchema` (`tasks.ts:~1183`): same additions, plus a `.refine()` predicate that rejects `{ outcome: "request_changes", autoMerge: true }` with a clear error message. The mutex is enforced at the schema boundary, not as a runtime check.

Both schemas share the new fields verbatim. The schemas are not merged into one — the existing `task_finish` handler dispatches on claim type before parsing, and that structure is preserved.

### 5b. `task_submit_pr` cross-repo hardening (HARDENING — part of this ADR's scope)

`task_submit_pr`'s current `submitPrSchema` (`tasks.ts:~836–849`) validates `prUrl` against the generic github.com regex only. It does NOT enforce that the URL's `owner/repo` matches `task.project.githubRepo`. Combined with the delegation user's cross-repo write access, this is a live exploit path: an attacker with an agent token on project A's soloMode config can submit `prUrl: https://github.com/victim-org/victim-repo/pull/42` and then `task_finish { autoMerge: true }` will (pre-hardening) merge the wrong repo's PR under the delegation user's token, subject only to branch protection on the victim repo — not on the project's repo.

The hardening is scoped into this ADR because `task_finish { autoMerge }` is the first caller that would execute the cross-repo merge. Without it, soloMode ships with a CVE-grade hole. Required changes:

1. `performPrMerge` derives `owner/repo` from `task.project.githubRepo` only (see §4).
2. `task_submit_pr` parses `prUrl` and asserts the extracted `owner/repo` matches `task.project.githubRepo`. On mismatch, 400 `bad_request` with a specific `cross_repo_pr_rejected` error code.
3. `task_finish { prUrl }` (when the payload provides `prUrl` as a shorthand for the submit-pr step) runs the same owner/repo assertion on the payload before merging.
4. Test case: `task_submit_pr { prUrl: "https://github.com/other-org/other-repo/pull/1" }` on a task where `project.githubRepo = "acme/repoA"` → 400 with `cross_repo_pr_rejected`.

The hardening is also applied at the existing `POST /api/github/pull-requests/:prNumber/merge` route as a side effect of `performPrMerge` deriving owner/repo from the task. This closes the pre-existing defect the helper extraction surfaces.

### 6. `task_finish` polymorphism, fully enumerated

After this ADR, `task_finish` has exactly six modes, dispatched by claim type + payload:

| Claim | Payload | Target | Effect |
|---|---|---|---|
| Work | `{result?, prUrl?}` → workflow resolves to `review` | `review` | Transition, keep work claim |
| Work | `{result?, prUrl?}` → workflow resolves to `done` | `done` | Transition, clear work claim |
| Work | `{autoMerge: true, mergeMethod?, ...}` + project.soloMode=true | `done` via GitHub merge | Gates (sans prMerged pre) → merge → transition → clear claim → autoMergeSha set |
| Review | `{outcome: "approve"}` | `done` | Transition, clear both claims |
| Review | `{outcome: "approve", autoMerge: true, mergeMethod?}` | `done` via GitHub merge | Gates (sans prMerged pre) → merge → transition → clear both claims → autoMergeSha set |
| Review | `{outcome: "request_changes"}` | `in_progress` | Transition back, reactivate work claim |

Two new modes (+autoMerge on Work, +autoMerge on Review-approve). `outcome: "request_changes"` + `autoMerge: true` is a payload error (rejected at the schema boundary).

**Audit events on a successful autoMerge call** — all of these fire, in order, on the happy path:

| Event | Source | Semantics |
|---|---|---|
| `github.pr_merged` | `performPrMerge` helper (existing, reused) | The GitHub merge API call succeeded; carries delegation user, owner, repo, PR number, merge method, SHA |
| `task.transitioned` (Mode A) *or* `task.reviewed` (Mode B) | `task_finish` handler (existing, reused) | The task's workflow state changed; carries from/to states, actor type, `via: "task_finish"` |
| `task.auto_merged` | `task_finish` autoMerge path (new) | Ties the merge to the task transition in a single audit record; carries taskId, `autoMergeSha`, mergeMethod, actor |

The `task.auto_merged` event is the anchor that makes the atomic intent reconstructable in a post-hoc audit trace. `github.pr_merged` alone doesn't tie to the task; `task.transitioned`/`task.reviewed` alone doesn't tie to the merge. `task.auto_merged` is the join record.

**Signal emission on a successful autoMerge call**:
- Mode A: no signal. No reviewer to notify (there is no review hop).
- Mode B: `emitTaskApprovedSignal` fires, matching the existing review-approve path.

### 7. Threat model

**Attack surface**: anyone who obtains an agent token with `tasks:transition` scope inside a soloMode project can:
- Write arbitrary `{branchName, prUrl, prNumber}` via `task_submit_pr` (trust-based per ADR-0009).
- Call `task_finish { autoMerge: true }` to merge the referenced PR number via the project's `allowAgentPrMerge` delegation user.

The delegation user's GitHub token can merge any PR in any repo it has write access to, **constrained by branch protection rules**. The attack surface is therefore `{compromised agent token} × {any PR visible to the delegation user} \ {PRs protected by branch protection}`.

**Primary defense — branch protection (MANDATORY)**:
- `require_pull_request_reviews` with at least one required reviewer (ideally with `dismiss_stale_reviews`).
- `require_status_checks_to_pass` with CI green required.
- `enforce_admins` ON, so branch protection applies even to administrators.
- `restrict_pushes` to a specific set if applicable.

A soloMode project without branch protection is insecure by definition. The project settings UI must display a branch protection status indicator (best-effort query to the GitHub API, cached; falls back to a static warning if the indicator can't load). **The ADR does not gate the soloMode toggle on an actual branch protection check** — the user may be setting up the repo, or the delegation user's scopes may not permit the BP read — but the UI must warn clearly and the project settings docs must name the BP baseline.

**Secondary defenses**:
- `soloMode` toggle is team-admin-only and audit-logged (reuses the existing `project.updated` diff audit).
- `task_finish { autoMerge }` calls emit `github.pr_merged` + `task.auto_merged` audit events.
- `allowAgentPrMerge` delegation is per-user consent and revocable.
- The `tasks:transition` scope is required and is already the strongest agent scope — anyone with it can already finish tasks.

**Deferred mitigation (follow-up ticket)**: `task_submit_pr` verification — lightweight GitHub API check that the PR was created by the claiming agent or that the branch head points at a commit the agent authored. This is orthogonal to the autoMerge flow and can be added later without breaking the verb's contract. Documented in ADR-0009's OQ2 as a trust-based default.

### 8. Retry idempotency

If `task_finish { autoMerge: true }` fails mid-flight (network timeout, partial state, client retry after 502), the agent will likely re-invoke the same call. Semantics:

- **Task already `done` + `autoMergeSha` set**: the merge was previously recorded successful. Short-circuit: return a 200 with the existing `autoMergeSha`, no GitHub call, no state change.
- **Task still `in_progress` + `autoMergeSha` set** (wrote the column but crashed before transition): check `prMerged` via GitHub API — if the PR is in `closed-merged` state, proceed with the transition without re-calling the merge API. This is the mid-flight-crash recovery path.
- **Task `in_progress` + `autoMergeSha` null**: call `performPrMerge` normally. The GitHub API's 405 "already been merged" handling covers the race where a first call succeeded but the client didn't see the response. On return, write `autoMergeSha` and transition.
- **Task already `done` + `autoMergeSha` null**: the task was completed by a different path (admin force-transition via v1 `/transition`, or a prior non-autoMerge `task_finish`). The existing state guard at the top of `task_finish`'s work branch rejects with 409 `bad_state` (status must be `in_progress`). No special case — the existing behavior is correct. Documenting it here so the implementation ticket doesn't add a spurious short-circuit.
- **Task `open` or other invalid state**: rejected by the existing state guard.

The effect is that `task_finish { autoMerge: true }` can be retried safely on the pre-success path (network failure before or during the merge call) and the post-success path (crash after merge but before transition). Retries against a task that's already reached `done` via a different mechanism are rejected — the autoMerge intent doesn't reach into other completion paths.

### 9. `soloMode` toggle during an in-flight call

The `task_finish` handler reads `project.soloMode` exactly once at the start, as part of the initial `prisma.task.findUnique` (widened to include `soloMode`). An admin toggling `soloMode: false` mid-call does not affect the in-flight decision — the call proceeds or rejects based on the snapshot. This is the call-time-snapshot semantics recommended by the prior review.

No locking or serialization is needed. The snapshot is the contract.

### 10. Draft PRs

`autoMerge` on a draft PR: **rejected**. The GitHub Merge API returns a 405 for draft PRs; the helper surfaces this as `github_error` with the original message. The agent should call `gh pr ready` before `task_finish { autoMerge }`. No special-casing in this ADR — the existing behavior is sufficient.

### 11. Workflow resolution — NO change

soloMode does not alter the ADR-0008 §50–56 workflow resolution chain. The chain remains:
1. `task.workflowId` → that Workflow row
2. Else project default Workflow row
3. Else built-in `defaultWorkflowDefinition()`

soloMode is consulted ONLY to decide whether `autoMerge: true` is accepted on a work-claim call. It does not rewire target-state resolution or gate evaluation.

A soloMode project with a review-bearing workflow is a valid-but-unusual configuration. The UI warns about the combination ("you have soloMode enabled but your workflow includes review; autoMerge from in_progress→done will skip review. To remove review entirely, use a workflow without a review state."). Most soloMode projects will pair it with the built-in default workflow's `in_progress → done` direct path or a custom workflow that drops `review`.

### 12. Hard 1-claim-per-agent limit — NO change

The 1-claim limit is not relaxed for soloMode. A soloMode agent still holds one claim at a time. The design goal is to let a single agent go `open → done`, not to enable parallelism. Parallelism remains a multiple-agent-identities problem per ADR-0008 §60.

## Consequences

**Positive**:

- A single agent can go `open → done` end-to-end in soloMode projects without falling back to multi-agent ceremony.
- Multi-agent projects get atomic review-approve-and-merge via the Mode B extension, reducing two round trips to one without relaxing any governance rule.
- All GitHub merge traffic funnels through one helper (`performPrMerge`), eliminating duplication between the existing merge route and the new autoMerge path.
- The existing `POST /api/github/pull-requests/:prNumber/merge` route stays functional for v1 callers and is internally refactored but behaviorally unchanged.
- No new signal shape, no new recipient rule. All new audit events use the existing `AuditAction` union and the fire-and-forget audit writer. Consistent with ADR-0009's "audit is supplementary, not load-bearing" finding.
- `prMerged` enforcement stays honest via the post-check + fail-closed semantics. No silent bypass.
- soloMode is a minimal project-level flag that mirrors the existing `requireDistinctReviewer` shape exactly, reusing its PATCH handler and audit integration.

**Negative / trade-offs**:

- `task_finish` polymorphism grows from 4 modes to 6. The dispatch matrix must be clearly documented in the MCP tool description. Acceptable because the new modes are gated on explicit payload flags (`autoMerge: true`) — agents that don't set the flag see no behavior change.
- soloMode raises the trust placed in the `allowAgentPrMerge` delegation user. A compromised agent in a soloMode project can merge arbitrary PRs within the delegation user's repo scope, modulo branch protection. Mitigation is entirely via GitHub BP — the ADR promotes this from "nice to have" to "required" in documentation, but does not enforce it in code.
- The `prMerged` post-check adds an extra GitHub API round trip on every autoMerge call when a workflow has `prMerged` configured. For workflows that don't configure `prMerged`, no extra round trip. Acceptable overhead.
- `autoMergeSha` is a new nullable column on Task. Zero-cost in practice (NULL for every non-autoMerge task) and only meaningful for retry idempotency.
- `task_submit_pr`'s trust-based write semantics remain the weakest link. Explicitly out of scope here but tracked as a follow-up; the ADR recommends branch protection as the structural compensation.

**Follow-ups outside this ADR**:

- **Implementation ticket**: schema migration (`Project.soloMode`, `Task.autoMergeSha`), `performPrMerge` helper extraction from `routes/github.ts:135–342`, `task_finish` handler extension in `backend/src/routes/tasks.ts`, MCP tool description update in `mcp-server/src/tools.ts` (the `task_finish` tool definition) + schema extension in `mcp-server/src/client.ts`, `routes/projects.ts` updateProjectSchema + audit diff extension for `soloMode`, `task_submit_pr` cross-repo hardening, frontend settings toggle + warning banner, unit and integration tests (see test plan below). Will be created after this ADR is accepted.
- **Documentation updates**: `docs/workflow-preconditions.md` (add soloMode + autoMerge flow section), `feedback_workflow.md` memory (add the soloMode canonical path), README mentions if any.
- **`task_submit_pr` authorship verification**: GitHub API check that the PR author matches the claiming agent, or that the branch head commit is authored by the agent's delegation user. Separate ticket, not blocking — the cross-repo hardening in this ADR (§5b) closes the most urgent exploit surface.
- **Branch protection status indicator**: frontend widget that queries `GET /repos/:owner/:repo/branches/:branch/protection` and surfaces the status on the project settings page. Separate ticket.
- **Webhook-based PR-state sync**: ADR-0008 §64 follow-up, unchanged by this ADR.

## Test plan (for the implementation ticket, not this ADR)

Unit tests in `tests/unit/tasks-v2-routes.test.ts`:

1. `task_finish { autoMerge: true }` without soloMode + work claim → 403 `solo_mode_required`
2. `task_finish { outcome: "approve", autoMerge: true }` on review claim (no soloMode needed) → happy path → merge helper called, task `done`, `autoMergeSha` set, all three audit events fired (`github.pr_merged`, `task.reviewed`, `task.auto_merged`), `emitTaskApprovedSignal` fired
3. `task_finish { outcome: "request_changes", autoMerge: true }` → 400 (Zod mutex error from `.refine()`)
4. Mode A happy path: soloMode project, work claim, `in_progress → done` workflow → gates pass → merge called → task `done`, `autoMergeSha` set, three audit events fired (`github.pr_merged`, `task.transitioned`, `task.auto_merged`), no signal
5. Mode A gate fail (missing branchName) → 422, merge NOT called, no DB write
6. Mode A `performPrMerge` returns 404 (PR not found) → 502 `github_error`, task stays `in_progress`, no `autoMergeSha` written
7. Mode A `performPrMerge` returns 405 "already merged" → treat as success, task transitions to `done`, `autoMergeSha` captured from post-check query (the helper returned `sha: null` + `alreadyMerged: true`)
8. Retry idempotency A: task already has `autoMergeSha` set + status `done` → short-circuit, return 200 with existing `autoMergeSha`, no GitHub call, no audit events
9. Retry idempotency B: task has `autoMergeSha` set but status still `in_progress` (mid-flight crash recovery) → `prMerged` check → proceed with transition without re-calling merge API
10. Retry rejection: task already `done` but `autoMergeSha` null → existing state guard rejects with 409 `bad_state`
11. `prMerged` post-check failure (GitHub API says not merged after successful merge call) → LOUD `task.auto_merge_post_assert_failed` audit event, task NOT transitioned, 502 returned, `autoMergeSha` NOT written (leave the recovery path manual)
12. `soloMode: false` → `true` toggle on a project with the existing PATCH route → `project.updated` audit event with `{ changes: { soloMode: { from: false, to: true } } }`
13. Parity: `performPrMerge` is called with the same shape from both call sites (existing merge route + new autoMerge path); `github.pr_merged` audit payload is identical
14. `task_finish { autoMerge: true }` with `prUrl` payload → prUrl merged into gate context (re-using b459be3's semantics), prPresent satisfied from payload if task.prUrl is null
15. **Mode A on a workflow without `in_progress → done`** (only `in_progress → review` exists) → 400 `bad_request` with clear message, no merge call
16. **Cross-repo prUrl rejection (§5b hardening)**: `task_submit_pr { prUrl: "https://github.com/other-org/other-repo/pull/1" }` on a task where `project.githubRepo = "acme/repoA"` → 400 with `cross_repo_pr_rejected` error code, no DB write
17. **Cross-repo prUrl on task_finish**: `task_finish { prUrl: "https://github.com/other-org/.../pull/1", autoMerge: true }` where task.project.githubRepo = "acme/repoA" → 400 with same error code
18. **Pre-existing merge route parity under the hardening**: `POST /api/github/pull-requests/:prNumber/merge` with body `owner: "other-org", repo: "other-repo"` where `task.project.githubRepo = "acme/repoA"` → merge hits `acme/repoA` (the body fields are ignored), not `other-org/other-repo`. Locks in the §4 hardening.

Integration tests: same flow end-to-end through both the MCP tool and the REST endpoint, verifying `github.pr_merged` + `task.auto_merged` events fire in the expected order.

## Open questions

All four open questions from the first-draft review cycle are resolved in the body of this ADR. Listing them explicitly so the next reviewer can verify:

- **OQ1 — Workflow resolution integration**: resolved in §11 (soloMode does NOT alter resolution; it only gates `autoMerge: true` acceptance).
- **OQ2 — `prMerged` handling**: resolved in §3 (strip from pre-check, re-assert post-check, fail-closed on discrepancy).
- **OQ3 — Reviewer-triggered autoMerge**: resolved in §2 Mode B (included with justification: same safety profile as soloMode with a distinct reviewer, strictly safer).
- **OQ4 — Threat model**: resolved in §7 (branch protection mandatory in docs + UI warning, delegation user consent is per-user revocable).

No genuine open questions remain at the scope of this ADR. `task_submit_pr` verification (mentioned in §7 secondary defenses) is a separate concern and is tracked as a follow-up ticket, not an OQ here.
