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
| `open` | `in_progress` | Start | `branchPresent` |
| `in_progress` | `review` | Submit for review | `branchPresent`, `prPresent` |
| `in_progress` | `done` | Mark done (skip review) | `branchPresent`, `prPresent` |
| `in_progress` | `open` | Release | *(none)* |
| `review` | `done` | Approve | *(none)* |
| `review` | `in_progress` | Request changes | *(none)* |
| `done` | — | *(terminal)* | — |

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

Results are cached in-memory for 60 seconds keyed by
`(owner, repo, sha)` — long enough to avoid hammering the API on
quick retries, short enough that a re-run of a flaky check is visible
on the next attempt. Force-pushes invalidate automatically because
the head SHA changes.

If you legitimately need to complete a task whose CI is broken or
GitHub is unreachable, a team admin can force the transition with
`{force: true, forceReason: "…"}` — audited as
`task.transitioned.forced`.

**Not supported in v1**: GitHub's older commit-status API (only check
runs); self-hosted CI without GitHub integration; auto-retry on CI
completion.

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
2. Click **Customize this workflow** — this forks the hardcoded default
   into a new custom `Workflow` row you can edit.
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
