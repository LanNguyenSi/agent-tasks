---
type: invariant
title: "Governance modes and the two merge paths"
description: "governanceMode (AUTONOMOUS / AWAITS_CONFIRMATION / REQUIRES_DISTINCT_REVIEWER) drives self-merge and review gates; the GitHub webhook and the REST merge verb pick different post-merge statuses."
tags: [governance, merge, self-merge, distinct-reviewer, webhook]
timestamp: 2026-07-03T00:00:00Z
sources:
  - backend/src/lib/governance-mode.ts
  - backend/src/services/review-gate.ts
  - backend/src/services/github-webhook.ts
  - backend/src/routes/tasks.ts
---

The current model is a single three-valued `governanceMode` enum (`backend/src/lib/governance-mode.ts`); the two booleans `soloMode`/`requireDistinctReviewer` are legacy. They still exist as columns and are kept in sync for back-compat readers, but `resolveGovernanceMode(project)` prefers the explicit `governanceMode` column and only falls back to deriving it from the legacy flags when that column is null:

- `soloMode=true` → `AUTONOMOUS` (wins over everything else; the old `requireDistinctReviewer=true && soloMode=true` combo was always a no-op).
- else `requireDistinctReviewer=true` → `REQUIRES_DISTINCT_REVIEWER`.
- else → `AWAITS_CONFIRMATION`.

`governanceFlags(mode)` derives convenience booleans: `allowsSelfMerge` (true for `AUTONOMOUS` and `AWAITS_CONFIRMATION`), `requiresDistinctReviewer` (true only for `REQUIRES_DISTINCT_REVIEWER`), `emitsSelfMergeNotice` (true only for `AWAITS_CONFIRMATION`).

**Gates keyed off the mode** (`backend/src/services/review-gate.ts`): `checkDistinctReviewerGate`/`checkReviewApprovalGate` (claimant cannot review/approve their own task) and `checkSelfMergeGate` (claimant cannot merge their own PR) both no-op unless `mode === REQUIRES_DISTINCT_REVIEWER`. Both are called from `POST /api/tasks/:id/merge`, `task_finish { autoMerge: true }` (both Mode A and Mode B, see `task-lifecycle.md`), and `POST /api/tasks/:id/transition`.

**Webhook vs REST-verb merge target divergence**:
- `pickMergeTargetStatus` (`backend/src/services/github-webhook.ts`, driven by `handlePullRequestEvent` on a GitHub `pull_request` `closed`+`merged` webhook): `currentStatus === "done"` → no-op (null); `AUTONOMOUS` → always `"done"`; otherwise (`AWAITS_CONFIRMATION` or `REQUIRES_DISTINCT_REVIEWER`, **any workflow**) → `"review"` if not already there, else no-op. Custom workflows get no `done` carve-out here by design (comment: "confirmation-required project must keep its review gate ... regardless of workflow").
- `POST /api/tasks/:id/merge` (`backend/src/routes/tasks.ts`) hardcodes `status: "done"` in its Prisma update, unconditionally, once the merge call to GitHub succeeds, it does not consult `governanceMode` for the target status at all (governance only gates *whether* the actor is allowed to call this verb, via self-merge/distinct-reviewer checks above).

**`task_finish` autoMerge modes** (`backend/src/routes/tasks.ts`, ADR-0010 §2 comments):
- **Mode A** (work-claim autoMerge, in_progress→done): requires `resolveGovernanceMode(project) === AUTONOMOUS`; any other mode returns `403 { error: "autonomous_mode_required" }`.
- **Mode B** (review-finish or self-approve autoMerge, review→done): allowed under any governance mode, but still runs `checkSelfMergeGate`, so a `REQUIRES_DISTINCT_REVIEWER` project blocks the claimant from also being the merger even via Mode B.

`POST /api/tasks/:id/merge` itself is idempotent: it accepts `status === "review"` or `status === "done"` (any other status is a `409 bad_state`); on a `done` retry the self-merge/distinct-reviewer checks are skipped (already satisfied on first pass) and `performPrMerge` detects an already-merged PR (`alreadyMerged: true`) rather than erroring.

Related: `claim-model.md`, `workflow-gates.md`, `reconcile-done-but-open.md`, `backend.md`.
