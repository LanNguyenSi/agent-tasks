---
type: invariant
title: "Governance modes and the two merge paths"
description: "governanceMode (AUTONOMOUS / AWAITS_CONFIRMATION / REQUIRES_DISTINCT_REVIEWER) drives self-merge and review gates; the GitHub webhook and the REST merge verb pick different post-merge statuses."
tags: [governance, merge, self-merge, distinct-reviewer, webhook]
timestamp: 2026-08-21T09:00:00Z
sources:
  - backend/src/lib/governance-mode.ts
  - backend/src/services/review-gate.ts
  - backend/src/services/github-webhook.ts
  - backend/src/routes/tasks.ts
  - backend/src/routes/github.ts
---

The current model is a single three-valued `governanceMode` enum (`backend/src/lib/governance-mode.ts`); the two booleans `soloMode`/`requireDistinctReviewer` are legacy. They still exist as columns and are kept in sync for back-compat readers, but `resolveGovernanceMode(project)` prefers the explicit `governanceMode` column and only falls back to deriving it from the legacy flags when that column is null:

- `soloMode=true` → `AUTONOMOUS` (wins over everything else; the old `requireDistinctReviewer=true && soloMode=true` combo was always a no-op).
- else `requireDistinctReviewer=true` → `REQUIRES_DISTINCT_REVIEWER`.
- else → `AWAITS_CONFIRMATION`.

`governanceFlags(mode)` derives convenience booleans: `allowsSelfMerge` (true for `AUTONOMOUS` and `AWAITS_CONFIRMATION`), `requiresDistinctReviewer` (true only for `REQUIRES_DISTINCT_REVIEWER`), `emitsSelfMergeNotice` (true only for `AWAITS_CONFIRMATION`).

**Gates keyed off the mode** (`backend/src/services/review-gate.ts`): `checkDistinctReviewerGate`/`checkReviewApprovalGate` (claimant cannot review/approve their own task) and `checkSelfMergeGate` (claimant cannot merge their own PR) both no-op unless `mode === REQUIRES_DISTINCT_REVIEWER`. Called from `POST /api/tasks/:id/merge`, `task_finish { autoMerge: true }` (both Mode A and Mode B, see `task-lifecycle.md`), `POST /api/tasks/:id/transition`, `POST /api/tasks/:id/start`'s review-claim branch, `POST /api/tasks/:id/review`/`/review/claim`, and — since `#402`, 2026-07-14 — the human `PATCH /api/tasks/:id` status-write lane too, which was hardened to run through the same `resolveEffectiveDefinition`/`checkReviewApprovalGate` pipeline `/transition` uses instead of writing `status` straight to the row. A separate merge lane also calls both gates: `POST /api/github/pull-requests/:prNumber/merge` (`backend/src/routes/github.ts`, the MCP `pull_requests_merge` verb; its own `checkTaskStatusForMerge` precondition, a distinct merge path from `/api/tasks/:id/merge` above) runs `checkReviewApprovalGate` only while `task.status === "review"` (`github.ts:352`, skipped on purpose on the `done` idempotent retry) and `checkSelfMergeGate` unconditionally on every call regardless of status (`github.ts:381`), which is what catches the retry case the review-approval check deliberately skips. The two gates are enforced everywhere a claim boundary is crossed; this enumeration is not asserted to be exhaustive — `sources:` below is what `sources-fresh` uses to flag future drift here.

**Webhook vs REST-verb merge target divergence**:
- `pickMergeTargetStatus` (`backend/src/services/github-webhook.ts`, driven by `handlePullRequestEvent` on a GitHub `pull_request` `closed`+`merged` webhook): `currentStatus === "done"` → no-op (null); `currentStatus === "backlog"` → no-op (null, since task backlog-status-v1, `#477`, 2026-08-20 — an unpromoted backlog task leaves backlog only via an operator's explicit `PATCH` promotion, never a webhook-observed merge; a defense-in-depth backstop, since `findTasksByPr` already excludes `backlog` tasks — see below); `AUTONOMOUS` → always `"done"`; otherwise (`AWAITS_CONFIRMATION` or `REQUIRES_DISTINCT_REVIEWER`, **any workflow**) → `"review"` if not already there, else no-op. Custom workflows get no `done` carve-out here by design (comment: "confirmation-required project must keep its review gate ... regardless of workflow"). `findTasksByPr` and the issue-`closed` handler's title-match lookup both filter `status: { notIn: ["done", "backlog"] }`, so a webhook event cannot even bind to (let alone transition) an unpromoted backlog task in the first place; this is the same v1 backlog gate `task-lifecycle.md`/`claim-model.md` describe for the agent-facing verbs, extended to the webhook path.
- `POST /api/tasks/:id/merge` (`backend/src/routes/tasks.ts`) hardcodes `status: "done"` in its Prisma update, unconditionally, once the merge call to GitHub succeeds, it does not consult `governanceMode` for the target status at all (governance only gates *whether* the actor is allowed to call this verb, via self-merge/distinct-reviewer checks above).

**`task_finish` autoMerge modes** (`backend/src/routes/tasks.ts`, ADR-0010 §2 comments):
- **Mode A** (work-claim autoMerge, in_progress→done): requires `resolveGovernanceMode(project) === AUTONOMOUS`; any other mode returns `403 { error: "autonomous_mode_required" }`.
- **Mode B** (review-finish or self-approve autoMerge, review→done): allowed under any governance mode, but still runs `checkSelfMergeGate`, so a `REQUIRES_DISTINCT_REVIEWER` project blocks the claimant from also being the merger even via Mode B.

`POST /api/tasks/:id/merge` itself is idempotent: it accepts `status === "review"` or `status === "done"` (any other status is a `409 bad_state`); on a `done` retry the distinct-reviewer approval check is skipped (`checkReviewApprovalGate` only runs while `status === "review"`), while `checkSelfMergeGate` still runs unconditionally, it just no-ops because the first merge cleared the claimant fields and the gate does nothing outside `REQUIRES_DISTINCT_REVIEWER`; `performPrMerge` detects an already-merged PR (`alreadyMerged: true`) rather than erroring.

Related: `claim-model.md`, `workflow-gates.md`, `reconcile-done-but-open.md`, `backend.md`.
