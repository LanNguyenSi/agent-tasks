# Review Automation Policy

Defines when and how GitHub webhook events may transition task status, add comments, or update metadata in agent-tasks.

Companion to [ADR 0001 — Webhook event model](adr/0001-webhook-event-model.md).

## Guiding principles

1. **Conservative by default** — webhook events annotate tasks; status transitions require explicit policy.
2. **No surprise automation** — humans and agents must be able to predict what a webhook will do by reading this document.
3. **Audit everything** — every accepted webhook event produces an audit log entry, whether or not it triggers a transition.
4. **Idempotent processing** — duplicate deliveries must not duplicate comments, oscillate state, or corrupt data.
5. **Policy is consultable at runtime** — webhook handlers call a policy evaluation function rather than encoding rules inline.

## Event → side-effect matrix

### Default workflow: `open → in_progress → review → done`

| GitHub event | Action | Preconditions | Status transition | Other side effects | Audit event |
|---|---|---|---|---|---|
| `pull_request_review` | `submitted` (approved) | Task is `review` | **No auto-transition** | Add timeline entry: "Review approved by {reviewer}" | `webhook.review_approved` |
| `pull_request_review` | `submitted` (changes_requested) | Task is `review` | `review → in_progress` | Add timeline entry: "Changes requested by {reviewer}" | `webhook.changes_requested` |
| `pull_request_review` | `submitted` (commented) | Any | None | Add timeline entry: "Review comment by {reviewer}" | `webhook.review_commented` |
| `pull_request_review` | `dismissed` | Any | None | Add timeline entry: "Review dismissed" | `webhook.review_dismissed` |
| `pull_request` | `closed` + `merged=true` | Task is not `done` | `* → done` | Update metadata: `mergedAt`, `mergedBy` | `webhook.pr_merged` |
| `pull_request` | `closed` + `merged=false` | Task is not `done` | **No auto-transition** | Add timeline entry: "PR closed without merge" | `webhook.pr_closed` |
| `pull_request` | `opened` | — | None | Add timeline entry: "PR opened"; update `prUrl`, `prNumber` if unset | `webhook.pr_opened` |
| `pull_request` | `synchronize` | — | None | Add timeline entry: "PR updated (new commits)" | `webhook.pr_synchronized` |

### Decision rationale

**Why no auto-transition on review approved?**
A single approval does not necessarily mean the task is done. Teams may require multiple approvals, or the author may want to address minor comments before merging. The approval is recorded in the timeline; the human or agent decides when to transition.

**Why auto-transition on changes requested?**
Changes requested is an unambiguous signal that the task needs more work. Sending it back to `in_progress` is the conservative, expected behavior. The assignee can re-submit for review when ready.

**Why auto-transition on PR merged?**
In the default workflow, `done` means the task's modeled lifecycle is complete. A merged PR is the strongest external signal that the work is finished. This is the one transition where automation matches universal expectation.

**Why no auto-transition on PR closed without merge?**
Closing a PR without merging is ambiguous — it could mean the approach was abandoned, replaced by another PR, or accidentally closed. The task should not silently move to `done`. A timeline entry alerts the assignee.

## Precondition enforcement

Before any status transition, the webhook handler must verify:

1. **Task exists and is bound** — the event maps to exactly one task via the [binding strategy](adr/0001-webhook-event-model.md#pr--task-binding-policy).
2. **Current status allows transition** — the target status is a valid transition from the current status. If not, skip the transition and log `webhook.transition_blocked`.
3. **Idempotency** — if the task is already in the target status, skip the transition (no-op, no duplicate audit entry).

## Custom workflows

For projects using custom workflow definitions, the policy matrix above serves as the **default behavior**. Custom workflows may:

- Override transition targets (e.g., `review → approved` instead of no transition on approval).
- Add additional preconditions (e.g., require N approvals before auto-transition).
- Disable specific automations entirely.

Custom workflow overrides are defined in the workflow definition's `webhookPolicy` field (future work).

## Out of scope (for now)

The following are explicitly **not** automated in the default workflow:

- **Deploy transitions** — merge does not imply deploy. Deploy/verify remain external follow-ups per ADR 0001.
- **Issue lifecycle** — `issues.opened` / `issues.closed` events create tasks or mark them done (existing behavior), but this is task creation, not workflow automation.
- **CI status checks** — not consumed as webhook events in the MVP.
- **Branch protection / required reviews** — GitHub enforces these; agent-tasks does not duplicate them.

## Implementation guidance

1. Extract a `evaluateWebhookPolicy(event, task)` function that returns `{ transition?: string, sideEffects: SideEffect[] }`.
2. Webhook handlers call this function instead of hardcoding transitions.
3. The function consults the matrix above (or a custom workflow's `webhookPolicy` if defined).
4. All side effects (timeline entries, metadata updates, audit events) are executed atomically with the transition.
5. Failed policy evaluations are logged but do not cause webhook delivery failure (return 200 to GitHub).

## ENGINEERING.md pattern

When a new webhook event type is added, update this policy document first. The matrix is the contract; the code implements the contract.
