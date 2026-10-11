# Event catalog

Authoritative source: the `AuditAction` union in [`backend/src/services/audit.ts`](../backend/src/services/audit.ts) and the `SignalType` union in [`backend/src/services/signal.ts`](../backend/src/services/signal.ts). This page is a curated index.

## Audit actions

Every action lands in `AuditLog` with a `payload: JSON` and an optional `actorId`, `taskId`, `projectId`. Audit writes are fire-and-forget and swallow errors: never depend on audit being load-bearing for any flow. **Documented exception:** `ConfidenceTelemetry`'s calibration snapshot (`scoreAtClaim` / `effectiveThreshold` / `overrideUsed`) reads specific `task.claim_*` rows below back as its source of truth; see `backend/src/services/confidence-telemetry.ts`'s header comment.

### Identity and tokens

| Action | Emitted on |
|---|---|
| `user.registered` | First-party registration |
| `user.login` | Successful login (email+password, GitHub OAuth, OIDC) |
| `user.logout` | Explicit logout |
| `token.created` / `token.revoked` | Declared in the union for agent token mint and revoke; no code path writes them |
| `token.renamed` | Agent token display name changed via `PATCH /api/agent-tokens/:id` (payload `{ tokenId, from, to }`) |

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
| `task.created` | Task created by a GitHub `issues.opened` webhook, or by single create (`POST /api/projects/:projectId/tasks`) on a project selected by the grounding creation policy. On every project it is also written, with payload `event: task_available_signal`, whenever `task_available` signals go out: when single create or batch import (`POST /api/projects/:projectId/tasks/import`) creates a task as `open`, and when `/transition` or a human `PATCH` moves a task back to `open` (not on backlog promote). A `backlog` task, or one in a team with no claim-eligible agent, gets no such row, so single create on any other project then writes no creation row. Batch import also writes `task.imported` for every task, so an imported `open` task can carry both actions |
| `task.claimed` / `task.released` | Claim lifecycle |
| `task.transitioned` | Standard status change |
| `task.transitioned.forced` | Admin-forced transition with `force=true` + `forceReason` |
| `task.commented` | Comment added |
| `task.reviewed` | Review submitted (`approve` or `request_changes`) |
| `task.review_rejected_self_reviewer` | Self-review rejected by `REQUIRES_DISTINCT_REVIEWER` gate |
| `task.merge_rejected_bad_status` | Merge attempt against a task in `open` or `in_progress` |
| `task.workflow_id_rejected_cross_project` | Create-time `workflowId` that does not resolve under the target project (foreign or non-existent); no `taskId`, since no task row is created |
| `task.pr_submitted` | PR metadata recorded via `task_submit_pr` (or REST equivalent) |
| `task.respec` | `task_respec` changed the description or `templateData` of an unclaimed `open` or `backlog` task; payload carries `{from, to}` per changed field and the confidence score before and after. Not written when nothing changed |
| `task.creator_abandoned` | The creating agent retired its own unclaimed `open` or `backlog` task via `POST /tasks/:id/creator-abandon` |
| `task.unabandoned` | A project admin moved an `abandoned` task back to the workflow's initial state (`PATCH /tasks/:id`) |
| `task.backlog_promoted` / `task.backlog_discarded` | Human `PATCH /tasks/:id` moved a `backlog` task to `open` (promote) or to `abandoned` (discard) |
| `task.backlog_demoted` | Human `PATCH /tasks/:id` moved an unclaimed `open` task back to `backlog`; its pending signals are acknowledged |
| `task.deliverable_repo_set` | Task created with a non-null `deliverableRepo` |
| `task.deliverable_repo_changed` | `deliverableRepo` set, changed or cleared via `PATCH /tasks/:id` |
| `task.foreign_pr_linked` | A write path linked a `prUrl` while the task's effective deliverable repo differs from `project.githubRepo` |
| `task.debugFlavor.reclassified` | `reclassify=true` on `task_pickup` or `task_start` produced a different `debugFlavor` than the stored value |
| `task.merged` / `task.auto_merged` | PR merged through the API; `auto_merged` fires when the merge was triggered as a side effect of `task_finish { autoMerge: true }` |
| `task.auto_merge_post_assert_failed` | Post-merge invariant check failed; flagged for human attention |
| `task.merge_webhook_first` | Another writer (typically the system's own PR-merge webhook) already moved the task to its terminal status between the GitHub merge and the API's own status write; the write completed against that row (payload carries `via`, `mergeSha`, `status`, `actorType`, plus `priorStatus` and `priorStatusVersion` of the row the write completed against and `resultKept`, true when that row already had a result, which the write then did not overwrite) |
| `task.merged_status_conflict` | The post-merge write lost (the status changed, or only a claim moved): the PR was merged but the API could not record it; nothing was written and the request answered 409 `merged_but_status_changed` (payload carries `via`, `mergeSha`, `expectedFrom`, `targetStatus`, `currentStatus` as read after the last failed write, and `reason`: `status_changed`, `claim_moved` or `merge_in_progress`; the latter two mean the status is as it was read, only a claim moved or another merge holds the task, and retrying the request is safe) |
| `task.pr_merged.blocked_self_merge` | Self-merge blocked by `REQUIRES_DISTINCT_REVIEWER` gate |
| `task.self_merge_notice_emitted` | `AWAITS_CONFIRMATION` self-merge succeeded; `self_merge_notice` signal fanned out |
| `task.imported` | Batch import (`POST /api/projects/:projectId/tasks/import`, used by the CSV/Excel import dialog), one row per created task, backlog included; an item created as `open` can also get the `task.created` signal row above |
| `task.grounding_gate.bypassed` | A debug-flavored task was finished on a project with `requireGroundingForDebug` off; records that the debug-grounding finish gate would have applied (no block, no override) |
| `task.artifact.created` / `task.artifact.deleted` | Typed artifact lifecycle |
| `task.attachment.uploaded` / `task.attachment.deleted` | A human uploaded a file attachment, or deleted an attachment (creating a URL-pointer attachment writes no event) |
| `task.claim_confidence_recorded` | Confidence gate: an agent claim the gate evaluated and did not block or shadow-log (the common "claim went cleanly" case); carries `score`/`threshold`/`thresholdSource`/`actorTokenId` so `GET /projects/:id/telemetry/confidence` has a claim-time score to snapshot later |
| `task.claim_blocked_low_readiness` | Confidence gate, `BLOCK` mode: an agent claim below the threshold or violating a keystone was refused with `422` |
| `task.claim_would_block_shadow` | Confidence gate, `WARN` mode: a claim that would have been blocked was allowed through |
| `task.claim_override_used` | Confidence gate, `BLOCK` mode: `?force=true` with the `confidence:override` scope and a `forceReason` let a would-block claim through; records the operator identity |
| `task.labels_changed` | Human PATCH `/tasks/:id` changes a task's `labels` array, compared order-insensitively (a reorder of the same labels does not fire). Labels feed `resolveTriggeredRiskModifiers` (claim-threshold risk modifiers) and easy-pick/heavy-pick dispatch routing, so this is a claim-gating input; mirrors `task.deliverable_repo_changed`'s `{from, to, actorType}` payload shape. Agent PATCH cannot write `labels` (not in `agentUpdateTaskSchema`), so this only ever fires for a human actor. |

### Admin claim operations

| Action | Emitted on |
|---|---|
| `task.claim_released_by_admin` / `task.review_claim_released_by_admin` | `POST /tasks/:id/admin-release`: a project admin released a work or review claim held by anyone; one event per released claim |
| `task.claim_reassigned` | `POST /tasks/:id/admin-reassign`: a project admin moved a work or review claim to a chosen actor (payload `{ claim, priorHolder, newHolder, reason }`) |

### GitHub delegation

| Action | Emitted on |
|---|---|
| `github.pr_created` | Server-side PR open through team delegation |
| `github.pr_merged` | Server-side PR merge |
| `github.pr_merge_failed` | Merge call returned an error from GitHub |
| `github.pr_commented` | Server-side PR comment |

### Signal delivery

| Action | Emitted on |
|---|---|
| `signal.webhook_delivered` | Outbound signal webhook answered 2xx (after at most one retry) |
| `signal.webhook_failed` | Outbound signal webhook gave up after the retry, including a URL the egress guard refused |

See [notification-webhooks.md](notification-webhooks.md#observability) for the payloads.

## Signal types

`Signal` rows are pull-based. One signal targets exactly one recipient (either `recipientUserId` or `recipientAgentId`). Acking sets `acknowledgedAt`. When a task lands in a terminal status, `acknowledgeSignalsForTask` bulk-acks every pending signal on that task (unconditional, all types) so reviewers do not see stale entries on tasks that already shipped.

A separate `STALE_WHEN_DONE` constant suppresses three signal types (`review_needed`, `task_available`, `task_assigned`) from the `task_pickup` feed when the underlying task is already in `done`. This is a read-time filter, not an ack mechanism.

| Type | Emitted when | Recipient | Suppressed from task_pickup feed when task is done | Pushed via webhook |
|---|---|---|---|---|
| `review_needed` | Task enters `review` | Candidate reviewers (humans + agents minus the author) | yes | yes |
| `task_available` | Sent on these routes: single create or batch import of a task created as `open`, or a `/transition` or human `PATCH` that moves a task to `open` from another status (a `PATCH` promote from `backlog` sends none). A move to `open` keeps any work claim the task holds (for example the Release move from `in_progress`), so such a task stays out of the pickup pool until that claim is released. A claim release or `task_abandon` that resets a task to `open`, and a task created from a GitHub `issues.opened` delivery, send none | Eligible claimants | yes | yes |
| `task_assigned` | Never: declared in the `SignalType` union and filtered by `STALE_WHEN_DONE`, but no code path creates it | n/a | yes | n/a |
| `changes_requested` | Reviewer transitions `review → in_progress` with comment | The task claimant | no | yes |
| `task_approved` | Reviewer transitions `review → done` | The task claimant | no | yes |
| `task_force_transitioned` | Admin used `force=true` on a transition | The claimant + the active reviewer | no | yes |
| `self_merge_notice` | `AWAITS_CONFIRMATION` self-merge landed on `done` | Every human team member (one signal each) | no | yes |

Every emitted signal is pushed via outbound webhook when the parent project has `notificationWebhookUrl` configured. The push is best-effort with one retry; see [notification-webhooks.md](notification-webhooks.md) for the contract, payload shape, and HMAC verification.

`task_pickup` returns a discriminated union:

```ts
{ kind: "signal" | "review" | "work" | "idle", ... }
```

so a single call surfaces "you have a pending signal", "you have a review to do", "here is claimable work", or "nothing right now". Clients dispatch on `kind` before reading the payload.

## What is NOT an audit event

The audit layer covers backend state changes. The following are intentionally not in `AuditLog`:

- **Webhook delivery.** Inbound GitHub webhook events are processed in `backend/src/services/github-webhook.ts` and emit their effects (`task.created` for an opened issue, `task.transitioned` for a closed issue or a merged PR (`payload.event: "pr_merged"`), and `task.reviewed` with a `payload.event` such as `review_approved` or `pr_closed`) under the existing actions. There is no `webhook.received` audit row by design.
- **Signal acks.** Acking a signal is a recipient-side bookkeeping operation, not a system state change.
- **Tool-invocation idempotency rows.** `ToolInvocation` is its own log, not an `AuditLog` entry. Use the `(projectId, verb, idempotencyKey)` unique index to detect retries.

## Further reading

- [`signal-payload-design.md`](signal-payload-design.md), full payload shapes for each signal type.
- [`review-notification-policy.md`](review-notification-policy.md), who exactly receives `review_needed` and when.
- [`review-automation-policy.md`](review-automation-policy.md), webhook event to side-effect matrix.

## Shared grounding decisions

The dormant grounding services write these events inside the same
transaction as their task, evidence or reservation effect. A failed audit write
aborts that transaction; existing `logAuditEvent` callers retain their current
best-effort behavior.

| Event | Effect and attribution |
| --- | --- |
| `task.grounding.completed` | Successful local or recovered remote decision; operation ID, actor type/ID, source/target, mode, receipt ID and separate merge commit |
| `task.grounding.overridden` | Human project-admin grounding override, with required reason and the successful decision |
| `task.grounding.disposed` | Concrete non-success disposition, reason and invalidation, without a passing receipt claim |
| `task.grounding.cancelled` | Reasoned cancellation of a provably undispatched reservation; invalidates its attempt |
| `task.grounding.merge_guard_consumed` | A grouped GitHub merge consumed the guard task's receipt (or invalidated its context); later completion of that task needs fresh evidence |
| `task.grounding.migration` | Human administrative migration command (`hold`, `pin_legacy`, `migrate_external`, `resume`) with reason, key and before/after state |
| `task.grounding.context_observed` | A configured GitHub webhook changed PR binding fields or observed a changed head; the task's grounding context was invalidated |
| `task.github.observed` | A configured GitHub webhook recorded an observation on a task, attributed to a system observation |
| `task.grounding.external_pending` | Same as `task.github.observed`, for an observation recorded as pending (for example a merged PR or issue close on a provisioned task) |
| `project.grounding.context_mutated` | Context writer's actor type/ID, bounded reason and selected task IDs, committed with actual mutation and invalidation |

Task events attribute human actors through the user foreign key; agent token
identity stays in the payload. Exact historical retries add no event.
