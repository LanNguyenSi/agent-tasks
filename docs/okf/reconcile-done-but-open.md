---
type: runbook
title: "Reconciling a task whose PR merged but the record is stuck open"
description: "task_start, ensure branchName, task_finish with prUrl, task_merge, relies on task_merge's alreadyMerged idempotency to bring a stale task record in line with GitHub reality."
tags: [reconcile, task-lifecycle, idempotency, runbook]
timestamp: 2026-07-03T00:00:00Z
sources:
  - backend/src/routes/tasks.ts
  - backend/src/services/default-workflow.ts
  - backend/src/services/github-merge.ts
---

Symptom: a task's PR is already merged on GitHub, but the task row in agent-tasks is still `open` (or `review`), tracking fell behind reality (e.g. a human merged the PR outside the tool, or a prior agent session died before calling the finish verbs).

**Preconditions this flow assumes**: the task is currently in the workflow's *initial* state (`open` by default) or a *review* state. `POST /tasks/:id/start` explicitly rejects any other status with `409 bad_state` ("must be in initial state ... or a review state"), so this flow does **not** apply to a task stuck `in_progress` under a claim nobody holds anymore; that needs an admin-forced transition (`POST /tasks/:id/transition {force:true}`, admin-only, see `claim-model.md`) before these verbs become callable again.

**Steps**:
1. `task_start` (`POST /tasks/:id/start`), claims the task and transitions `open → in_progress` (default workflow; no `requires` gate on this edge, see `backend/src/services/default-workflow.ts` `DEFAULT_TRANSITIONS`). If the task is in a review state instead, this call acquires the review lock rather than the work claim.
2. **Ensure `branchName` is set** before finishing: the default workflow's `in_progress → review` edge requires `branchPresent` (and `prPresent`). Either fold it in at step 1 (`task_start { branchName }`, folded atomically into the same claim write, see `workflow-gates.md`) or `PATCH /tasks/:id { branchName }` beforehand.
3. `task_finish` (`POST /tasks/:id/finish`) with `{ prUrl }`, validates the PR URL shape and the cross-repo guard (`checkPrRepoMatchesProject`), stores `prUrl`/`prNumber`, and transitions to the workflow's expected finish state (`review` by default, or `done` directly for workflows that allow skipping review, both require `branchPresent`+`prPresent` in the default workflow).
4. `task_merge` (`POST /tasks/:id/merge`), requires status `review` or `done` (409 otherwise); runs the self-merge/distinct-reviewer gates (see `governance-merge.md`), then calls `performPrMerge`. Because the PR is already merged on GitHub, `performPrMerge` detects this and returns `{ ok: true, alreadyMerged: true, sha: null }` instead of erroring, the task is still transitioned to `done` and `autoMergeSha` recorded. This is what makes the whole flow idempotent: re-running `task_merge` against an already-`done` task with the gates already satisfied is a safe no-op retry (self-merge/distinct-reviewer checks are skipped on the `done→done` path).

`task_finish { autoMerge: true }` has its own narrower recovery path for the specific case of a call that merged the PR but crashed before persisting the transition (`task.status === "in_progress" && task.autoMergeSha` set), it re-verifies `prMerged` and completes the transition without re-invoking the merge API. That path is internal to `task_finish`'s autoMerge branches, not a general-purpose reconciliation entry point.

Related: `task-lifecycle.md`, `claim-model.md`, `governance-merge.md`.
