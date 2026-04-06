# Review notifications policy

Defines who receives review-needed signals and how recipients are selected.

## Hard rules

1. **The current assignee is always excluded.** The worker who transitions a task to `review` must never receive the review signal for that task (no self-review).

2. **Revoked or expired tokens are excluded.** Only active agent tokens participate.

## Recipient eligibility

### Agents

An agent token is eligible to receive review signals if **all** of the following are true:

| Condition | Rationale |
|---|---|
| Token belongs to the same team as the project | Team-scoped access |
| Token has `tasks:transition` scope | Required to submit reviews |
| Token is not revoked (`revokedAt` is null) | Inactive tokens excluded |
| Token is not expired (`expiresAt` is null or in the future) | Expired tokens excluded |
| Token is not the task's `claimedByAgentId` | No self-review |

### Humans

A human user is eligible to receive review signals if **all** of the following are true:

| Condition | Rationale |
|---|---|
| User is a member of the project's team | Team-scoped access |
| User has role `REVIEWER` or `ADMIN` | Role-based eligibility |
| User is not the task's `claimedByUserId` | No self-review |

### Default behavior

- **Team-scoped:** signals are scoped to the team that owns the project. No cross-team signals.
- **Both agents and humans** receive signals by default. There is no opt-out per recipient in the MVP.
- **All eligible recipients** receive the signal. There is no "pick one reviewer" logic — any eligible reviewer can claim the review.

## What is NOT in scope (MVP)

- **Project-level reviewer lists** — all team members with the right role/scope are eligible. Per-project filtering is a future extension.
- **Review assignment / round-robin** — no automatic assignment. Signals go to all eligible; first to claim the review lock wins.
- **Notification preferences / opt-out** — no per-user or per-token notification settings in the MVP.
- **Cross-team reviews** — not supported. A reviewer must be in the same team.
- **Rate limiting / batching** — every transition to `review` emits one signal per eligible recipient. No deduplication for rapid re-reviews.

## Signal lifecycle

```
Task enters "review"
  → findEligibleReviewers(projectId, excludeAssignee)
  → For each eligible recipient:
      → Create Signal { type: "review_needed", recipientAgentId/recipientUserId }
  → Timeline comment: "[system] Review requested — eligible reviewers: ..."
  → Audit event: task.reviewed { event: "review_needed", recipients: [...] }
```

```
Reviewer requests changes
  → Task moves to "in_progress"
  → Create Signal { type: "changes_requested", recipientAgentId: originalAssignee }
  → Review lock cleared
```

```
Reviewer approves
  → Task moves to "done"
  → Create Signal { type: "task_approved", recipientAgentId: originalAssignee }
  → Review lock cleared
```

## Future extension points

- **`reviewers` field on Project** — explicit reviewer list per project, overriding team-wide eligibility.
- **`canReview` scope on AgentToken** — separate scope for review eligibility (currently piggybacks on `tasks:transition`).
- **Notification preferences** — per-token or per-user opt-in/opt-out for signal types.
- **Review assignment strategies** — round-robin, load-balanced, or explicit assignment.

## Relationship to existing code

The `findEligibleReviewers()` function in `review-signal.ts` already implements the agent + human eligibility logic described here. This policy document formalizes and extends it.
