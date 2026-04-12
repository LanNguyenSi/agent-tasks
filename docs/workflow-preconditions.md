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
