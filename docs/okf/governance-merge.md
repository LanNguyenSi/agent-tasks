---
type: invariant
title: "Governance, grouped merges and webhook observations"
description: "Governance gates apply before grouped GitHub merges; configured webhooks preserve protected completion as a pending observation."
tags: [governance, merge, self-merge, distinct-reviewer, webhook]
timestamp: 2026-09-28T06:05:07Z
sources:
  - backend/src/lib/governance-mode.ts
  - backend/src/services/review-gate.ts
  - backend/src/services/github-webhook.ts
  - backend/src/routes/tasks.ts
  - backend/src/routes/github.ts
  - backend/src/app.ts
  - backend/src/routes/grounding-task-completion.ts
  - backend/src/routes/grounding-github.ts
  - backend/src/routes/grounding-github-webhooks.ts
  - backend/src/services/grounding-completion.ts
  - backend/src/services/grounding-finalization.ts
  - backend/src/services/grounding-github-merge.ts
  - backend/src/services/grounding-scope.ts
  - backend/src/services/grounding-github-fence.ts
  - backend/src/services/grounding-github-webhook.ts
  - backend/src/services/grounding-github-observation-context.ts
  - backend/src/services/grounding-merge-provider.ts
  - backend/src/services/grounding-context.ts
  - backend/src/services/grounding-operations.ts
  - backend/src/services/grounding-route-effects.ts
  - backend/prisma/grounding-github-fence.sql
---

`resolveGovernanceMode(project)` prefers the explicit `governanceMode` column.
When it is null, the legacy flags resolve in this order: `soloMode=true` selects
`AUTONOMOUS`, otherwise `requireDistinctReviewer=true` selects
`REQUIRES_DISTINCT_REVIEWER`, otherwise the mode is `AWAITS_CONFIRMATION`.
`governanceFlags(mode)` derives convenience flags from that result.

`checkSelfMergeGate` and the distinct-reviewer approval gates prevent the work
claimant from merging or approving their own work in
`REQUIRES_DISTINCT_REVIEWER`. `AWAITS_CONFIRMATION` allows self-merge and emits
the existing notice; `AUTONOMOUS` allows self-merge. These gates are separate
from grounding evidence: an assessment or grounding-only override cannot grant
missing project access, merge scope, delegation consent or workflow authority.

## Configured merge operations

The configured GitHub merge service uses one durable group for the requested
PR. It acquires a fence for the canonical, case-insensitive repository before
discovering protected tasks linked to that PR, including tasks in other
projects and tasks with an explicit deliverable repository. The effective
repository is `task.deliverableRepo ?? project.githubRepo`. Repository spelling
is canonicalized for coordination; signed task context and receipt bytes retain
their exact identity. A recognizable but inconsistent PR binding blocks the
operation instead of disappearing from the participant set. Existing policy
also rejects foreign-deliverable merges.

Every protected peer must pass its own standalone task-merge decision before
remote dispatch: project write access, agent `github:pr_merge` scope, an
eligible `allowAgentPrMerge` delegate, a review state with one terminal workflow
edge, required roles, review governance, and its cohort's evidence decision.
Merge head and CI reads use merge delegation consent. No general work or review
claim is added where the standalone route permits a non-claimant merger.
Required CI must refer to the same fresh source head as the receipt and every
other participant. OFF, legacy enrollment and grounding-only overrides do not
skip CI or ordinary merge gates.

The seed retains its requested task/finish/GitHub route semantics. Other
participants are guards: successful recovery consumes their reserved evidence
and records the decision, but preserves their status, claims and signals. A
consumed external guard receipt requires a fresh attempt before that peer can
complete later. One PR merge does not silently finish every linked task.

The group revalidates all participants before a durable dispatch claim. Only
the winner can send the remote merge with the expected source SHA. The
repository fence remains active across network I/O and local recovery; context,
membership and binding changes that could alter the decision are excluded by
the database backstop. A timeout, missing proof or an open PR after dispatch
keeps the operation pending. Expiry never unlocks the fence.

Retry with the original actor, idempotency key and canonical request. A changed
actor or request conflicts. Recovery rechecks current authority and delegation,
then requires exact repository, PR number, merged state, original source head
and a separate merge commit. It applies the stored decisions atomically without
another merge request. The local snapshot and receipt projection must still
match; a dispatched decision does not require fresh CI, receipt TTL or trust
verification. Completed replay returns the stored response without repeating
receipt consumption or route effects.

A fresh standalone merge must start in a review state. A terminal task can only
replay or recover its existing operation; a bare `autoMergeSha` cannot create
one. Only a wholly RESERVED, provably undispatched group can be cancelled, with
the original actor's current authority and a nonblank reason. Cancellation and
dispatch serialize, and a new operation needs a new key and evidence decision.

Configured fresh remote merges require explicit server enrollment only inside
the enforced scope derived from `creationPolicy` at startup: the task's own
project is selected, its effective repository belongs to a selected project,
or it is bound to or grouped with a protected/`EXTERNAL_V1`/held peer
(`grounding-scope.ts`, reusing the merge service's peer-discovery SQL rather
than duplicating it). Missing enrollment inside that scope returns
`409 grounding_enrollment_required` for task merge, GitHub merge and finish
with `autoMerge`, including when no operation key is supplied; outside it the
same request reaches the unchanged legacy handler instead, and an enabled
configuration with empty trust and an empty `creationPolicy` is equivalent to
the unconfigured app for every project. Startup itself refuses when a project
outside the enforced scope shares a GitHub repository with an enforced one,
so the enforced/legacy boundary is never ambiguous per request. Compatibility
tasks may be explicitly enrolled as OFF or LEGACY_LOCAL; external evidence is
not mandatory for every task. The peer read that decides scope is
point-in-time, not a lock: a peer that joins after that read is accepted as a
residual race (an admin rebinding a protected task's repository or PR
concurrently with an in-flight legacy merge of that same PR), not fenced by
it. Existing durable
operations keep their recovery path. Production enrollment and rollout remain
separate prerequisites; active legacy workers must be excluded before enabling
the configured lane.

## Configured webhook observations

A signed GitHub delivery records an external fact, not a user-authorized
completion. For provisioned tasks, including OFF, issue-close and merged-PR
events remain pending with a durable observation, visible task comment and
mandatory system-observation audit. They do not write success or review,
release claims, acknowledge signals or consume a receipt. A valid stored receipt
alone does not authorize the webhook to complete a task. The pending fact can
be resolved through an authorized completion operation.

Branch/title PR matching is observation-only for every configured task.
Exact unprovisioned PR bindings retain the legacy governance target below;
unprovisioned issue-title matches retain the existing issue-close behavior.
Invalid or partial enrollment cannot select that compatibility behavior.

PR-open may fill missing PR fields when existing PR number and URL identity
agree. It fills a missing branch and preserves an existing one. An actual
binding change invalidates assessment context in the same transaction and
conflicts with an active reservation. An identical binding leaves the current
attempt intact. Review changes requested and an observed changed source head on
reopen likewise invalidate affected context; reopening does not invent a task
status.

Delivery identity, payload fingerprint, observations, task effects and required
audits commit together. An exact duplicate returns the saved result. Reusing a
delivery ID for another event or payload conflicts. A database or audit failure
rolls back the delivery claim and all effects so that redelivery can retry.

## Historical unconfigured behavior

The original webhook and task routes remain the compatibility behavior of an
unconfigured application. `pickMergeTargetStatus` leaves `done` and `backlog`
alone; otherwise a merged PR moves an AUTONOMOUS task to `done`, or a task in
either confirmation mode to `review` unless already there. Legacy webhook
lookups exclude done and backlog tasks.

The historical task-merge route instead writes `done` after the merge helper
succeeds. It admits review and done, retains the self-merge gate on retries, and
runs distinct-reviewer approval while the task is in review. The helper can
recognize an already-merged PR. Historical finish with `autoMerge` requires
AUTONOMOUS mode for a work-claim finish; review finish or permitted self-approval
still runs the ordinary self-merge gate. These compatibility paths are not the
recovery contract for a configured grouped operation.

Related: [receipt contract](../grounding-receipt-contract.md),
[claim model](claim-model.md), [workflow gates](workflow-gates.md),
[recovery runbook](reconcile-done-but-open.md).

Administrative holds participate in repository fencing. Group discovery includes held unenrolled peers, and held seeds fail admission. Every matching held-task webhook fact remains pending, including PR-open, reopen and review changes requested; it cannot select the unprovisioned compatibility branch. The migration-only app composition also selects these configured adapters. See [migration and rollback](../grounding-migration.md).

Configured issue-open deliveries apply the runtime project creation selection. Selected creation validates that the preserved `open` state exists and is neither review nor terminal, then provisions the external cohort and binding in the same delivery transaction. Workflow, provisioning or audit failure rolls back all creation and delivery effects. Unselected creation and exact delivery deduplication retain their behavior.
