# Event catalog

Authoritative source: the `AuditAction` union in [`backend/src/services/audit.ts`](../backend/src/services/audit.ts) and the `SignalType` union in [`backend/src/services/signal.ts`](../backend/src/services/signal.ts). This page is a curated index.

## Audit actions

Every action lands in `AuditLog` with a `payload: JSON` and an optional `actorId`, `taskId`, `projectId`. Audit writes are fire-and-forget and swallow errors: never depend on audit being load-bearing for any flow.

### Identity and tokens

| Action | Emitted on |
|---|---|
| `user.registered` | First-party registration |
| `user.login` | Successful login (email+password, GitHub OAuth, OIDC) |
| `user.logout` | Explicit logout |
| `token.created` | Agent token minted via `POST /api/agent-tokens` |
| `token.revoked` | Agent token revoked |

### Project lifecycle

| Action | Emitted on |
|---|---|
| `project.created` | New project |
| `project.updated` | Settings changed (governance fields, confidence threshold, task template, ...) |
| `project.synced` | GitHub repo sync |
| `project.invite_created` / `project.invite_consumed` / `project.invite_revoked` | Per-project share-link lifecycle |
| `project.member_removed` | Collaborator dropped from a project |
| `project.solo_mode_disabled_by_share` | Auto-flip when a second human enters a soloMode project; the distinct-reviewer gate becomes real from this moment |

### Workflow management

| Action | Emitted on |
|---|---|
| `workflow.created` / `workflow.updated` / `workflow.reset` | Custom workflow CRUD |
| `workflow.customized` | First custom override of the system default |
| `workflow.template_applied` | Pre-built workflow template adopted |

### Task lifecycle

| Action | Emitted on |
|---|---|
| `task.created` | New task |
| `task.claimed` / `task.released` | Claim lifecycle |
| `task.transitioned` | Standard status change |
| `task.transitioned.forced` | Admin-forced transition with `force=true` + `forceReason` |
| `task.commented` | Comment added |
| `task.reviewed` | Review submitted (`approve` or `request_changes`) |
| `task.review_rejected_self_reviewer` | Self-review rejected by `REQUIRES_DISTINCT_REVIEWER` gate |
| `task.merge_rejected_bad_status` | Merge attempt against a task in `open` or `in_progress` |
| `task.pr_submitted` | PR opened via `task_submit_pr` (or REST equivalent) |
| `task.merged` / `task.auto_merged` | PR merged through the API; `auto_merged` fires when the merge was triggered as a side effect of `task_finish { autoMerge: true }` |
| `task.auto_merge_post_assert_failed` | Post-merge invariant check failed; flagged for human attention |
| `task.pr_merged.blocked_self_merge` | Self-merge blocked by `REQUIRES_DISTINCT_REVIEWER` gate |
| `task.self_merge_notice_emitted` | `AWAITS_CONFIRMATION` self-merge succeeded; `self_merge_notice` signal fanned out |
| `task.imported` | Bulk CSV/Excel import |
| `task.grounding_gate.bypassed` | Admin override of the debug-grounding gate |
| `task.artifact.created` / `task.artifact.deleted` | Typed artifact lifecycle |

### GitHub delegation

| Action | Emitted on |
|---|---|
| `github.pr_created` | Server-side PR open through team delegation |
| `github.pr_merged` | Server-side PR merge |
| `github.pr_merge_failed` | Merge call returned an error from GitHub |
| `github.pr_commented` | Server-side PR comment |

## Signal types

`Signal` rows are pull-based. One signal targets exactly one recipient (either `recipientUserId` or `recipientAgentId`). Acking sets `acknowledgedAt`. When a task lands in a terminal status, every pending signal in `STALE_WHEN_DONE` for that task is bulk-acked so reviewers never see stale `review_needed` entries on tasks that already shipped.

| Type | Emitted when | Recipient | Auto-ack on task done |
|---|---|---|---|
| `review_needed` | Task enters `review` | Candidate reviewers (humans + agents minus the author) | yes |
| `task_available` | New claimable task surfaced for backlog visibility | Eligible claimants | yes |
| `task_assigned` | Task explicitly assigned to a specific recipient | The assignee | yes |
| `changes_requested` | Reviewer transitions `review → in_progress` with comment | The task claimant | no (read by claimant before they iterate) |
| `task_approved` | Reviewer transitions `review → done` | The task claimant | no |
| `task_force_transitioned` | Admin used `force=true` on a transition | The claimant + the active reviewer | no |
| `self_merge_notice` | `AWAITS_CONFIRMATION` self-merge landed on `done` | Every human team member (one signal each) | no |

`task_pickup` returns a discriminated union:

```ts
{ kind: "signal" | "review" | "work" | "idle", ... }
```

so a single call surfaces "you have a pending signal", "you have a review to do", "here is claimable work", or "nothing right now". Clients dispatch on `kind` before reading the payload.

## What is NOT an audit event

The audit layer covers backend state changes. The following are intentionally not in `AuditLog`:

- **Webhook delivery.** Inbound GitHub webhook events are processed in `backend/src/services/github-webhook.ts` and emit their effects (`task.transitioned`, `task.pr_merged`, etc.) under the existing actions. There is no `webhook.received` audit row by design.
- **Signal acks.** Acking a signal is a recipient-side bookkeeping operation, not a system state change.
- **Tool-invocation idempotency rows.** `ToolInvocation` is its own log, not an `AuditLog` entry. Use the `(projectId, verb, idempotencyKey)` unique index to detect retries.

## Further reading

- [`signal-payload-design.md`](signal-payload-design.md) — full payload shapes for each signal type.
- [`review-notification-policy.md`](review-notification-policy.md) — who exactly receives `review_needed` and when.
- [`review-automation-policy.md`](review-automation-policy.md) — webhook event to side-effect matrix.
