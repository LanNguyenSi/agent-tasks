---
type: runbook
title: "Reconciling a task whose PR merged but the record is stuck open"
description: "Recover a configured merge with its original operation and exact GitHub proof; retain the separate historical task lifecycle repair flow."
tags: [reconcile, task-lifecycle, idempotency, runbook]
timestamp: 2026-09-23T10:20:00Z
sources:
  - backend/src/routes/tasks.ts
  - backend/src/services/default-workflow.ts
  - backend/src/services/github-merge.ts
  - backend/src/app.ts
  - backend/src/routes/grounding-task-completion.ts
  - backend/src/routes/grounding-github.ts
  - backend/src/routes/grounding-github-webhooks.ts
  - backend/src/services/grounding-completion.ts
  - backend/src/services/grounding-finalization.ts
  - backend/src/services/grounding-github-merge.ts
  - backend/src/services/grounding-github-fence.ts
  - backend/src/services/grounding-github-webhook.ts
  - backend/src/services/grounding-github-observation-context.ts
  - backend/src/services/grounding-merge-provider.ts
  - backend/src/services/grounding-context.ts
  - backend/src/services/grounding-operations.ts
  - backend/src/services/grounding-route-effects.ts
  - backend/prisma/grounding-github-fence.sql
  - backend/src/services/grounding-github-create.ts
  - backend/src/services/grounding-github-create-provider.ts
---

A PR may be merged while its task remains open because the remote response was
lost, a local commit failed, or GitHub was changed outside the task API. First
identify whether the application uses configured grounding completion and
whether the task has an existing durable operation. A stored `autoMergeSha` or
a webhook observation is not a completion decision.

## Configured operation recovery

1. Resume the original merge endpoint with the originating actor, the same
   idempotency key and the same canonical request. Preserve the original task,
   repository, PR and merge method; do not substitute a new key to work around
   a pending result. The service looks up the durable operation before mutable
   status and claim admission, so a changed task state does not turn recovery
   into a new merge.
2. Restore the actor's required project access, scope and eligible GitHub
   delegation if those checks fail. Recovery reauthorizes the original
   operation; an administrator or webhook does not replace its actor.
3. Let the service read GitHub. A DISPATCHED operation performs no second
   remote write. Completion requires the exact original repository, PR number,
   merged state and source head, plus a valid separate merge commit. Missing,
   mismatched or ambiguous proof stays pending, even when GitHub currently
   shows an open PR. A crash between the dispatch claim and network send is
   also uncertain.
4. On matching proof, the service commits the seed's stored task and route
   effects, guard evidence decisions, audits and reservation releases together.
   Guard peers retain their status, claims and signals. A database failure
   leaves the operation available for the same retry; a completed retry returns
   the stored response without repeating effects.

Receipt expiry after authorized dispatch does not prevent exact-proof recovery
or unlock the repository. Recovery checks the original local snapshot and
receipt projection; it does not require renewed receipt TTL, trust or CI. Do
not force a status, change a PR binding or clear a reservation to repair the
operation. Such changes either conflict with its fence or invalidate the
stored decision's context.

Only a wholly RESERVED, provably undispatched operation can use the server's
`cancelMerge(taskId, actor, key, reason)` API. It requires the originating actor's
current authority and a nonblank reason. It atomically invalidates the attempt,
records cancellation and releases the reservation. A DISPATCHED operation
cannot be cancelled by this API; time passing or an open-PR read does not prove
that no remote effect occurred.

If no durable operation exists, use the ordinary authorized completion flow.
For an external cohort, bind the authoritative PR before obtaining an attempt
and assessment for the appropriate finish, approve or merge intent. Every
protected peer linked to the PR must satisfy its own merge decision. A new
standalone merge requires a review state; neither a terminal task nor a bare
merge SHA permits creating a historical decision. Configured fresh remote
merge requests without enrollment return `409 grounding_enrollment_required`;
compatibility requires explicit OFF or LEGACY_LOCAL server enrollment, not a
fallback selected from task metadata.

A configured positive webhook for a provisioned task is a pending, audited
observation. Even a valid receipt does not let that delivery complete the task.
Use the actor-authorized completion flow to resolve the pending fact. Weak
branch/title PR matches cannot establish completion authority.

## Pending PR creation

Retry `POST /api/github/pull-requests` with the original actor, key and
normalized body. After dispatch, the create service reads for a unique PR with
the operation's internal body marker and exact logical repository/ref/PR
identity; it never repeats the POST. An old or newer untagged PR cannot stand
in for the request. Missing or edited markers, multiple correlated matches or
an incomplete lookup remain pending.

Once proof is established, the service binds the branch and PR, invalidates
assessment context, records audits and releases the repository fence in one
transaction. A failed local commit is retryable. Do not create another PR or
manually rewrite the binding to escape the intent.

A completed retry must re-read matching proof before returning its original
201 response. If proof is unavailable, `grounding_github_create_pending` can
report state COMPLETED: the prior result and binding remain committed, and the
released fence is not reacquired. If storage itself is unreadable, the response
omits state rather than inventing it.

`grounding_github_create_conflict` means a validated later response disagrees
with the recorded PR. The service preserves the original binding and records
a durable diagnostic, comment and system-observation audit. Later retries stay
unresolved; they cannot overwrite the binding or issue another POST. A failed
diagnostic transaction returns pending and a subsequent retry reads GitHub
again before any saved success can be returned.

## Historical unconfigured lifecycle repair

The following flow applies only to the original unconfigured task routes. It
assumes the task is in the workflow's initial or review state. `task_start`
rejects other states; backlog must be explicitly promoted. An orphaned
in-progress task needs the separate claim/admin procedure described in the
[claim model](claim-model.md).

1. Call `task_start` (`POST /api/tasks/:id/start`) to take the work claim from
   the initial state, or the review claim from a review state.
2. Ensure `branchName` is set. The default workflow's finish edge requires a
   branch and PR; start can set the branch with the claim write.
3. Call `task_finish` (`POST /api/tasks/:id/finish`) with the authoritative
   `prUrl`. The historical route validates and stores that binding, then
   selects the workflow's finish state.
4. Call `task_merge` (`POST /api/tasks/:id/merge`) from review or done. Its
   governance checks still apply. The legacy merge helper recognizes an
   already-merged PR and the route brings the task to done.

The historical finish autoMerge branch also has a narrower internal repair for
a saved merge SHA after a partial operation. That compatibility behavior does
not authorize a new configured operation or replace grouped recovery.

Related: [task lifecycle](task-lifecycle.md),
[governance and merge](governance-merge.md),
[receipt contract](../grounding-receipt-contract.md).
