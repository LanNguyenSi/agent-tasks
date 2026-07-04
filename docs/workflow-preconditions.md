# Workflow Transition Preconditions

Workflows can attach declarative **preconditions** to any transition. The
backend evaluates them before allowing the status change, so agents (and
humans) can't mark work complete until the expected artifacts actually exist.

This is the system-level enforcement counterpart to the agent-workflow
policy in [`agent-workflow.md`](agent-workflow.md): that document tells
agents what they're supposed to do; this one makes the backend refuse when
they don't.

## Motivation

Without gates, an agent can transition `in_progress → review` the instant it
finishes typing, even if no branch was recorded and no PR exists. The
reviewer then has nothing to review, the signal inbox fills with noise, and
the audit trail becomes useless. Codifying the "did you actually do the
thing" checks in the state machine shifts the problem from "hope the agent
reads the docs" to "the API returns 422 until you fix it".

## How it works

Each entry in `workflow.definition.transitions` can carry a `requires` field
listing named rules:

```jsonc
{
  "states": [
    { "name": "open", "label": "Open", "terminal": false },
    { "name": "in_progress", "label": "In progress", "terminal": false },
    { "name": "review", "label": "In review", "terminal": false },
    { "name": "done", "label": "Done", "terminal": true }
  ],
  "initialState": "open",
  "transitions": [
    { "from": "open", "to": "in_progress", "requires": ["branchPresent"] },
    { "from": "in_progress", "to": "review", "requires": ["branchPresent", "prPresent"] },
    { "from": "review", "to": "done" }
  ]
}
```

When a client calls `POST /api/tasks/:id/transition` with
`{"status": "review"}` on a task in `in_progress`, the backend:

1. Looks up the transition definition (`from=in_progress`, `to=review`).
2. Evaluates each rule in `requires` against the task's current fields.
3. If any rule fails, responds with **HTTP 422** and a structured body
   listing the failed rules. The task is **not** transitioned.

Example failure response:

```json
{
  "error": "precondition_failed",
  "message": "Transition blocked — No pull request recorded on this task. …",
  "failed": [
    { "rule": "prPresent", "message": "No pull request recorded on this task. Create the PR …" }
  ],
  "canForce": true
}
```

## Default workflow (applied when no custom Workflow row exists)

Projects that haven't defined their own workflow inherit a built-in default
that **now carries gates**. It lives in
[`backend/src/services/default-workflow.ts`](../backend/src/services/default-workflow.ts)
and matches the recommended config below:

| From | To | Label | Requires |
| ---- | -- | ----- | -------- |
| `open` | `in_progress` | Start | *(none)* |
| `in_progress` | `review` | Submit for review | `branchPresent`, `prPresent` |
| `in_progress` | `done` | Mark done (skip review) | `branchPresent`, `prPresent` |
| `in_progress` | `open` | Release | *(none)* |
| `review` | `done` | Approve | *(none)* |
| `review` | `in_progress` | Request changes | *(none)* |
| `done` | — | *(terminal)* | — |

> `open → in_progress` has no gate on the default workflow. `branchPresent`
> used to live on this edge, but that self-checkmated `task_start`: the only
> v2-native path to write `branchName` is `task_submit_pr`, which requires
> the task to already be `in_progress`. The gate now lives on
> `in_progress → review` and `→ done` where it is load-bearing. Projects
> that need branch-before-start can customize their workflow to re-add
> the rule.

Before this change the no-workflow path accepted any transition string
without validation. It now rejects transitions that aren't listed with HTTP
400, and blocks gated transitions with HTTP 422 — the same behaviour that
custom workflows already enforce. Teams that need different rules should
create a custom `Workflow` row; the gates in `requires` can then be set per
transition independently.

### What bypasses these gates

- **GitHub webhook handlers** (`backend/src/services/github-webhook.ts`) write
  task state directly via Prisma on PR merge/close events. These never go
  through `/tasks/:id/transition`, so webhook-driven transitions are
  deliberately ungated.
- **The `/tasks/:id/review` endpoint** (approve / request changes) manages
  its own state transitions without calling the transition handler, so the
  review flow is also not affected.
- **Admin force** (documented below) remains the explicit manual escape
  hatch with full audit.

## Built-in rules

| Rule | Passes when | Fails when | Fix |
| ---- | ----------- | ---------- | --- |
| `branchPresent` | `task.branchName` is a non-empty string | branch missing | `PATCH /api/tasks/:id` with `branchName` |
| `prPresent` | `task.prUrl` **and** `task.prNumber` are set | PR missing | `POST /api/github/pull-requests` (or `PATCH` the fields manually) |
| `ciGreen` | Every check run on the PR's head commit is `success` / `neutral` / `skipped` | Any check is `failure` / `cancelled` / `timed_out` / `action_required` / `stale` / still running | Wait for CI, re-run a failing job, or admin-force the transition |
| `prMerged` | The PR is in the closed-merged state (`state=closed` and `merged=true`) | PR is still open, was closed without merging, or GitHub/delegation errors | Merge the PR, or admin-force |

### `ciGreen` details

`ciGreen` is the first **async** rule — it queries the GitHub Check
Runs API for the task's PR head commit. It uses the same GitHub
delegation path as `POST /api/github/pull-requests`: the backend picks
the first team member with a valid `githubAccessToken` and
`allowAgentPrCreate` consent. Fail-closed behavior:

- If the project has no `githubRepo` → fails (cannot query CI)
- If no team member has a valid delegation token → fails
- If the task has no `prNumber` → fails
- If the GitHub API returns an error (network, 401, 404, 429) → fails,
  error surfaced in the 422 response as `{rule: "ciGreen", error: "…"}`
- If any check run is still queued or in_progress → fails (pending)
- If any check run is unrecognized → fails (unknown state)

Results are cached for 60 seconds behind the `Cache<T>` abstraction
in `services/cache.ts`. Single-instance deploys get an in-memory
FIFO cache (default). Multi-instance deploys with `REDIS_URL`
configured share a RedisCache so the GitHub API hit rate stays
`1/N × request_rate` instead of fanning out linearly by pod count.
The PR object is cached by `(owner, repo, prNumber)` and shared
with `prMerged`, so a task with both gates on the same transition
makes only one `/pulls/:n` fetch per 60s. The check-runs
classification is cached separately by `(owner, repo, sha)` so a
force-push that moves the head will re-run check-runs against the
new SHA as soon as the PR cache refreshes. A Redis outage degrades
gracefully to a cache miss — requests never fail on cache health,
they just pay the underlying GitHub API cost.

**Recovery paths** when a rule fails:

1. **Fix the underlying problem** (push a commit to fix CI, merge
   the PR, re-run a flaky check) and retry the transition. The 60s
   cache means the retry needs to wait up to a minute for the
   state to refresh — it's not a real-time UI.
2. **Admin force** with a `forceReason`, audited as
   `task.transitioned.forced`. Use this for hot-fixes, rollbacks,
   or when GitHub itself is down.

If you legitimately need to complete a task whose CI is broken or
GitHub is unreachable, a team admin can force the transition with
`{force: true, forceReason: "…"}` — audited as
`task.transitioned.forced`.

**Not supported in v1**: GitHub's older commit-status API (only check
runs); self-hosted CI without GitHub integration; auto-retry on CI
completion.

### `prMerged` details

`prMerged` closes the gap where a task can be marked `done` while
the PR is still sitting open — the companion of `ciGreen`. Uses the
same GitHub delegation path and shares the PR cache: when both
`ciGreen` and `prMerged` are on the same transition, only one
`/pulls/:n` fetch is made per 60s (not two).

**Pass only when**: the PR is in the closed-merged state.

**Fail closed when**:

- Task has no `prNumber` → fails
- Project has no `githubRepo` or it's malformed → fails
- No team member has a valid delegation token → fails
- GitHub API returns a non-2xx → fails, error surfaced in the 422
  response as `{rule: "prMerged", error: "…"}`
- PR is still `open` → fails (pending, not rejected)
- PR is `closed && !merged` → fails (rejected / closed without merge)
- Malformed response (missing `merged` or `state` fields) → fails

**Interaction with the webhook path**: GitHub webhooks auto-transition
tasks on PR merge via a raw `prisma.update` that bypasses the rule
evaluator entirely (see "What bypasses these gates" above). In the
default workflow the webhook lands the task in `review` (AUTONOMOUS
projects — formerly `soloMode=true` — and custom-workflow tasks still
go to `done`; see
[review-automation-policy.md](review-automation-policy.md)). The
`prMerged` rule only matters for manual/agent-driven transitions
where the webhook hasn't arrived yet, or when the task's `prNumber`
is linked to a PR whose webhook events aren't subscribed.

**Recommended pairing**: add both `prPresent` and `prMerged` to the
same transition. `prPresent` gives a clean early error when the task
has no PR linked at all; `prMerged` handles the "PR exists but not
merged" case.

More rules (PR merged, docs touched, CI green) are planned as follow-ups.
Adding one is a ~10-line change in
[`backend/src/services/transition-rules.ts`](../backend/src/services/transition-rules.ts)
plus a unit test.

### Unknown rules are not blocking

If a workflow references a rule name the backend doesn't recognise (e.g.
`docsTouched` on an older backend), the rule is **ignored** rather than
failing the transition, and a warning is logged. This keeps workflows
forward-compatible across backend versions — you can pre-configure rules
before the backend supports them, and they activate on the next deploy.

## Forcing a transition past a failed precondition

Sometimes you need to bypass: a hot-fix has no PR because you're applying
it via a different tool; a docs-only task legitimately has no branch; a
task was imported from Jira and its metadata was never populated.

Team **admins** can force:

```http
POST /api/tasks/<id>/transition
Content-Type: application/json

{
  "status": "review",
  "force": true,
  "forceReason": "imported from Jira; PR lives in LEG-442"
}
```

Rules:

- Only **human** actors may force. Agents always get 403 on `force=true`.
- The human must have the `ADMIN` role in the team that owns the task's
  project. HumanMembers and reviewers cannot force.
- The transition existence and `requiredRole` checks still apply — `force`
  only bypasses the `requires` preconditions, not the whole workflow.
- Every forced transition writes an audit event with action
  `task.transitioned.forced`, payload containing the list of bypassed rules
  and the (optional) `forceReason`, so forced transitions are
  reconstructible from the audit log.
- A `task_force_transitioned` signal is emitted to the task's current
  claimant and reviewer (both human and agent, deduplicated, excluding
  the forcing admin). Agents polling the inbox see the override on the
  next poll so they can re-fetch the task instead of acting on stale
  state. See [signal-payload-design.md](signal-payload-design.md) for
  the payload shape.

## How agents see the rules

`GET /api/tasks/:id/instructions` returns `allowedTransitions` where each
entry now includes a `requires` array:

```json
{
  "allowedTransitions": [
    { "to": "review", "label": "Submit for review", "requires": ["branchPresent", "prPresent"] }
  ]
}
```

Well-behaved agents read this and satisfy the requirements before calling
the transition endpoint. Misbehaved agents get a 422 and a clear error
message — which they can also act on, since the message names the missing
rules.

## Editor API (for UI and scripts)

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api/workflow-templates` | List available workflow templates: `{templates: [{slug, name, description, stateCount, initialState}]}`. |
| `POST` | `/api/projects/:projectId/workflow/apply-template/:slug` | Admin-only. Creates (or overwrites) a custom workflow from a predefined template. Returns `201` with the new workflow. Returns `404` if the template slug is unknown. |
| `GET` | `/api/workflow-rules` | Catalog of built-in rules: `{rules: [{id, label, description, failureMessage}]}`. Used by the UI to render rule checkboxes without hardcoding any IDs on the frontend. |
| `GET` | `/api/projects/:projectId/effective-workflow` | Returns the workflow currently in force for the project: `{source: "custom"\|"default", workflowId, definition}`. The response shape is stable whether a custom `Workflow` row exists or not — the UI can render it identically. |
| `POST` | `/api/projects/:projectId/workflow/customize` | Admin-only. Forks the hardcoded default into a new `Workflow` row marked `isDefault: true`. Returns `201` with the new workflow. Returns `409` if the project already has a custom workflow. |
| `DELETE` | `/api/projects/:projectId/workflow` | Admin-only. Drops the custom `Workflow` row, unlinks any tasks that referenced it (`workflowId` set to `NULL`), and reverts the project to the hardcoded default. Returns `404` if there's nothing to delete. |

Once a custom workflow exists, the full edit surface is the existing
`PUT /api/workflows/:id` endpoint — the UI writes the whole
`definition` (states + transitions + initialState) back on every save.

## Managing workflows in the UI

Team admins can edit workflows in the browser at
`/projects/workflow?projectId=<uuid>` — linked from the project dropdown
and the dashboard gear icon. Non-admins see a read-only view.

**Flow for a project using the default workflow:**

1. Open the page. The banner shows "Using system default".
2. Either click **Customize this workflow** to fork the built-in default,
   or click a **template button** (e.g. "Branch, PR & Merge Gated") to
   apply a predefined workflow with transitions and gates pre-configured.
3. Edit states: inline-edit name/label, toggle terminal, click
   "Add instructions…" to open a textarea for the state's agent
   instructions, use `+ Add state` / the `✕` button per row.
   Renaming a state propagates the rename into every transition
   endpoint and the initial state so the graph stays coherent —
   mid-keystroke values that would duplicate or be invalid do **not**
   propagate, they just write the name and let the validation banner
   flag it.
4. Edit transitions: `from` / `to` are state dropdowns, label is
   inline, `required role` is a dropdown (`any`, `ADMIN`,
   `HUMAN_MEMBER`, `REVIEWER`), and the gates column shows one
   checkbox per built-in rule from `/api/workflow-rules`. `+ Add
   transition` creates a new row defaulted to the initial state →
   first other state.
5. Validation errors (duplicate names, bad name format, dangling
   `initialState`, missing transition endpoints, duplicate
   transitions) block Save with an inline banner.
6. Reachability warnings (unreachable states, dead-end non-terminal
   states, orphan states with no incoming transition) show as a
   warning banner but do **not** block Save.
7. `Cmd/Ctrl+S` saves. Save PUTs the whole definition to the backend
   schema, which re-validates with `.superRefine()` before persisting.
8. **Reset to default** drops the custom row entirely and reverts the
   project to the hardcoded default. Tasks that referenced the custom
   workflow get `workflowId` unset and fall back to the default.

**Renaming a state** does **not** migrate existing task rows whose
`status` column matches the old name. A warning banner appears when a
rename is pending, advising that affected tasks will need an admin
force-transition or manual re-label. The backend will return `422` on
transition attempts for those stuck tasks until they're moved.

## Configuring rules on a workflow

Rules live in the workflow's `definition.transitions[].requires` array.
Edit them via the existing workflow CRUD:

```http
PUT /api/workflows/<workflowId>
Content-Type: application/json

{
  "definition": {
    "states": [ ... ],
    "initialState": "open",
    "transitions": [
      { "from": "open", "to": "in_progress", "requires": ["branchPresent"] },
      { "from": "in_progress", "to": "review", "requires": ["branchPresent", "prPresent"] },
      { "from": "review", "to": "done" }
    ]
  }
}
```

The workflow validator accepts up to 10 rules per transition.

## Recommended default for new code-review workflows

```
open            ──▶ in_progress    requires: branchPresent
in_progress     ──▶ review         requires: branchPresent, prPresent
in_progress     ──▶ open           (no requires — release is always allowed)
review          ──▶ done           (no requires — approval is its own gate)
review          ──▶ in_progress    (no requires — "request changes" must always work)
```

Two gates, zero friction for the legitimate path, and hot-fixes stay
possible through admin override.

## Solo Mode & autoMerge

**ADR-0010** introduces `task_finish { autoMerge: true }` for atomic
merge-and-transition in a single call. Two modes:

### Mode A — Solo work-claim merge

Requires `project.governanceMode = AUTONOMOUS` (legacy: `soloMode=true`). A single agent can take a task from
`open` to `done` without a distinct reviewer:

```
task_start → (work + gh pr create) → task_submit_pr → task_finish { autoMerge: true }
```

The handler overrides `targetStatus` to `done`, evaluates all workflow gates
except `prMerged` (which can't pass yet), calls the GitHub merge API via
`performPrMerge`, runs a `prMerged` post-check if the workflow required it,
and transitions the task atomically. No review signal is emitted.

### Mode B — Reviewer-triggered merge

Does NOT require `AUTONOMOUS` mode (legacy: `soloMode`). A distinct reviewer calls:

```
task_finish { outcome: "approve", autoMerge: true }
```

Same merge + post-check flow, but the distinct-reviewer gate is enforced
first (defense-in-depth). `emitTaskApprovedSignal` fires as usual.

### Cross-repo hardening

`task_submit_pr` and `task_finish { prUrl }` both validate that the PR's
`owner/repo` matches `project.githubRepo`. Mismatches are rejected with
`400 cross_repo_pr_rejected`. The `performPrMerge` helper derives
`owner/repo` exclusively from the project — body-supplied values are
ignored.

### Cross-repo deliverable override (`deliverableRepo`)

Some tasks have a legitimate deliverable that is a PR in a **different**
GitHub repo than the one the project is linked to — benchmark runs,
cross-repo measurement, or docs tasks that land their output elsewhere.
Without an escape hatch, such a task deadlocks: `branchPresent`/`prPresent`
require a PR, but the cross-repo PR guard rejects any PR that isn't in
`project.githubRepo`.

`Task.deliverableRepo` (nullable, `owner/repo` format) is the escape hatch.
When set, every place that would otherwise compare against
`project.githubRepo` compares against the **effective deliverable repo**
instead: `task.deliverableRepo ?? project.githubRepo`. A value equal to the
project's own repo is a harmless no-op.

**When to use it**: a task whose PR genuinely belongs in another repo (the
task itself still lives in this project). Do not use it to route around the
guard for a same-repo task — that's what the guard is for.

**Where it's enforced** (all task-side `prUrl` write paths, plus PR
creation):

- `task_finish { prUrl }` and `task_submit_pr`
- `PATCH /api/tasks/:id` (`prUrl`), both the agent and the human lane
- `POST /api/github/pull-requests` — validated against the requested
  `owner`/`repo` **before** the PR is created on GitHub

All five reject a mismatch with the same `400 cross_repo_pr_rejected` shape.

**What stays forbidden**:

- **Merge automation never merges a foreign deliverable.** `performPrMerge`
  — the single choke point behind `task_merge`, `task_finish { autoMerge:
  true }` (both Mode A and Mode B), and `POST /api/github/pull-requests/:n/merge`
  — refuses with `409 foreign_deliverable_merge_refused` whenever the
  effective deliverable repo diverges from `project.githubRepo`. The foreign
  repo owns its own merge lifecycle; merge it there directly.
- **Agents cannot set or change it.** `deliverableRepo` may be supplied at
  `task_create` time by either a human or an agent (safe, because the
  point above already blocks the abuse case). Once the task exists, only a
  human **project admin** may set, change, or clear it via
  `PATCH /api/tasks/:id`. An agent PATCH body naming `deliverableRepo` is
  rejected with `403`, even if the value is unchanged — this prevents
  mid-flight retargeting of a task's merge-automation ownership.

**`ciGreen` / `prMerged` on a foreign deliverable (v1 semantics)**: this
project's GitHub delegation token has no standing on a foreign repo, so
these rules cannot be meaningfully evaluated there. v1 treats them as
**skipped** (trivially satisfied) rather than evaluated or force-failed —
the alternative would either fail closed forever with no recovery path, or
silently pretend the rule ran. The skip is recorded, not hidden: a
`task_finish` response on a foreign-deliverable task carries an additive
`skippedGates: [{ rule, reason }]` array when this applies. Task-level
introspection (`GET /api/tasks/:id/instructions`) surfaces the override
itself via an additive `crossRepoDeliverable: { deliverableRepo,
effectiveRepo, overridden }` block.

**Audit trail**: `task.deliverable_repo_set` (create, non-null only),
`task.deliverable_repo_changed` (PATCH, set/changed/cleared), and
`task.foreign_pr_linked` (any write path that links a `prUrl` under an
active override) are all logged via the standard audit-event pipeline.

### Branch protection

Solo mode raises the trust placed in the `allowAgentPrMerge` delegation
user. **Branch protection on GitHub is the primary safeguard** — do not
enable solo mode without `require_pull_request_reviews` and at least one
required status check.

## Workflow templates

Predefined templates provide complete workflow definitions that can be
applied to a project in one click. Templates are defined in code at
[`backend/src/services/workflow-templates.ts`](../backend/src/services/workflow-templates.ts)
and are versioned with the backend.

### Branch, PR & Merge Gated (`branch-pr-merge-gated`)

The locked four-state workflow with stricter precondition gates than the
built-in default. It enforces branch-first discipline and only lets a
task reach `done` once its pull request is actually merged.

| From | To | Label | Requires |
| ---- | -- | ----- | -------- |
| `open` | `in_progress` | Start | `branchPresent` |
| `in_progress` | `review` | Submit for review | `branchPresent`, `prPresent` |
| `in_progress` | `done` | Mark done | `branchPresent`, `prPresent`, `prMerged` |
| `in_progress` | `open` | Release | *(none)* |
| `review` | `in_progress` | Request changes | *(none)* |
| `review` | `done` | Approve | `prMerged` |

How it differs from the built-in default:

- **`open → in_progress` is gated on `branchPresent`.** The default
  deliberately leaves this edge ungated so exploratory work can begin
  before a branch exists; this template instead requires the branch to
  be recorded first. `task_start` returns `422` until `branchName` is
  set — the `open` state's `agentInstructions` say so explicitly.
- **Every edge into `done` requires `prMerged`.** Both the `review →
  done` approval and the `in_progress → done` skip-review path require
  the PR to be merged, so reaching `done` always means the PR landed.

Each state includes `agentInstructions` so agents using `task_start`
know what is expected at each stage.

Applying a template replaces the project's custom workflow (or creates
one if none exists). Existing tasks are not migrated, but because the
state vocabulary is fixed (`open`, `in_progress`, `review`, `done`)
their `status` values stay valid — only the transitions, gates, and
labels change.
