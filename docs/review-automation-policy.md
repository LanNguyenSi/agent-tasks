# Review Automation Policy

Defines when and how GitHub webhook events may transition task status, add comments, or update metadata in agent-tasks.

Companion to [ADR 0014 — Webhook event model](adr/0014-webhook-event-model.md).

This page describes the legacy webhook handlers. When the backend runs with `GROUNDING_RUNTIME_CONFIG`, the grounding webhook service handles deliveries instead; see [webhook-setup.md](webhook-setup.md#with-external-grounding-enabled).

## Guiding principles

1. **Conservative by default**: webhook events annotate tasks; status transitions require explicit policy.
2. **No surprise automation**: humans and agents must be able to predict what a webhook will do by reading this document.
3. **Audit task effects**: webhook events that review, transition or close the PR of a task write an audit log entry, whether or not they trigger a transition. A `pull_request` opened that matches a task writes only a timeline comment, and `push` only updates the project's sync timestamp.
4. **Idempotent processing**: duplicate deliveries must not duplicate comments, oscillate state, or corrupt data.
5. **Policy is consultable at runtime** (not implemented): the intent is that webhook handlers call a policy evaluation function rather than encoding rules inline. Today the handlers in `backend/src/services/github-webhook.ts` encode the policy inline; see [Implementation guidance](#implementation-guidance).

## Event → side-effect matrix

### Default workflow: `open → in_progress → review → done`

| GitHub event | Action | Preconditions | Status transition | Other side effects | Audit event |
|---|---|---|---|---|---|
| `pull_request_review` | `submitted` (approved) | Any | **No auto-transition** | Add timeline entry: "Review approved by {reviewer}" | `task.reviewed` (event `review_approved`) |
| `pull_request_review` | `submitted` (changes_requested) | Task is `review` | `review → in_progress` | Add timeline entry: "Changes requested by {reviewer}" | `task.reviewed` (event `changes_requested`) |
| `pull_request_review` | `submitted` (commented) | Any | None | Add timeline entry: "Review comment by {reviewer}" | `task.reviewed` (event `review_commented`) |
| `pull_request_review` | `dismissed` | Any | None | Add timeline entry: "Review dismissed for {reviewer}" | `task.reviewed` (event `review_dismissed`) |
| `pull_request` | `closed` + `merged=true` | Task is not `done` or `backlog` | `governanceMode: AUTONOMOUS`: `* → done`. Every other mode, default or custom workflow: `open`/`in_progress → review`; `review` unchanged (explicit approval still required). | Add timeline entry: "PR #N merged by {user}" (the merger is also in the audit payload's `merged_by`) | `task.transitioned` (event `pr_merged`, with `from` and `to`) |
| `pull_request` | `closed` + `merged=false` | Task is not `done` or `backlog` | **No auto-transition** | Add timeline entry: "PR #N closed without merge" | `task.reviewed` (event `pr_closed`) |
| `pull_request` | `opened` | Task is not `done` or `backlog` | None | Add timeline entry: "PR #N opened"; fill `prNumber`, `prUrl`, `branchName` if unset | None for a matched task; `task.reviewed` (event `pr_opened_unmatched`) when no task matches |

Other `pull_request` actions, such as `synchronize`, are ignored.

### Decision rationale

**Why no auto-transition on review approved?**
A single approval does not necessarily mean the task is done. Teams may require multiple approvals, or the author may want to address minor comments before merging. The approval is recorded in the timeline; the human or agent decides when to transition.

**Why auto-transition on changes requested?**
Changes requested is an unambiguous signal that the task needs more work. Sending it back to `in_progress` is the conservative, expected behavior. The assignee can re-submit for review when ready.

**Why PR merged lands in `review` (and not `done`) by default?**
In the default workflow `review → done` is a real gate: the reviewer — human or agent via `task_finish({ outcome: "approve" })` — signs off on more than just the code landing. A merged PR means the code shipped, not that the task is approved, so the webhook hands the task off for explicit review instead of closing it. Tasks already in `review` stay in `review` (no self-approval from a merge event).

One escape hatch preserves the old "merge ⇒ done" shortcut where it matches intent:
- **`governanceMode: AUTONOMOUS` projects** (formerly `soloMode: true`, ADR-0010) opt out of review-gating entirely. A merge still moves the task straight to `done`, and no `self_merge_notice` is emitted since there's no counterparty to notify.

Tasks bound to a custom workflow get the same targets as the default workflow. Known limitation: the webhook writes `review` without checking it against a custom workflow's states.

Projects with `governanceMode: AWAITS_CONFIRMATION` (formerly the ambiguous `soloMode=false, requireDistinctReviewer=false` combo) follow the default "merge ⇒ review" path above, AND emit a `self_merge_notice` signal to every human team member when the task subsequently reaches `done` via a self-merge. See `signal-payload-design.md#self_merge_notice`.

Projects with `governanceMode: REQUIRES_DISTINCT_REVIEWER` (formerly `requireDistinctReviewer: true`) additionally block self-merge attempts upstream via `checkSelfMergeGate`.

**Why no auto-transition on PR closed without merge?**
Closing a PR without merging is ambiguous — it could mean the approach was abandoned, replaced by another PR, or accidentally closed. The task should not silently move to `done`. A timeline entry alerts the assignee.

## Precondition enforcement

Before any status transition, the webhook handler must verify:

1. **Task exists and is bound**: the event maps to one or more tasks via the [binding strategy](adr/0014-webhook-event-model.md#pr--task-binding-policy); every matching task is handled.
2. **Current status allows transition**: each handler decides the target from the task's current status (for example, `changes_requested` moves only a task in `review`) and writes it with a compare-and-swap. A task in any other status is left as is; the skip writes no separate audit row. The target is not checked against a custom workflow's transitions.
3. **Idempotency**: if the task is already in the target status, the write is skipped. Repeated deliveries are dropped by their `X-GitHub-Delivery` id before any handler runs (see [webhook-setup.md](webhook-setup.md#how-a-delivery-is-processed)).

## Custom workflows

The webhook handlers do not read a project's custom workflow. The policy matrix above is applied to every project as it stands, and each handler writes its target status with a compare-and-swap without checking the target against the workflow's transitions. A project cannot override a transition target, add preconditions (for example N approvals before an auto-transition) or disable a single automation through its workflow definition: the workflow API has no webhook-policy field. Changing this would be a new feature, not an existing option.

## Out of scope (for now)

The following are explicitly **not** automated in the default workflow:

- **Deploy transitions**: merge does not imply deploy. Deploy/verify remain external follow-ups per ADR 0014.
- **Issue lifecycle**: `issues.opened` / `issues.closed` events create tasks or mark them done (existing behavior, see the matrix in [webhook-setup.md](webhook-setup.md#event--side-effect-matrix)), but this is task creation, not workflow automation.
- **CI status checks**: not consumed as webhook events in the MVP.
- **Branch protection / required reviews**: GitHub enforces these; agent-tasks does not duplicate them.

## Implementation guidance

The handlers in `backend/src/routes/github-webhook.ts` encode the policy inline; there is no separate policy evaluator. The matrix above is the contract, and the handlers implement it. If the policy ever needs to vary per project, extract the matrix into one function that the handlers call, and execute all side effects (timeline entries, metadata updates, audit events) atomically with the transition.

## ENGINEERING.md pattern

When a new webhook event type is added, update this policy document first. The matrix is the contract; the code implements the contract.

Likewise, when you change a transition target in the handler, update the matrix in the same PR — out-of-sync policy and handler is the scenario this doc exists to prevent.
