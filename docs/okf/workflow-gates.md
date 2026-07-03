---
type: invariant
title: "v2 transition gates: precondition rules, branch folding, cross-repo guard"
description: "branchPresent/prPresent/ciGreen/prMerged return 422 precondition_failed; branchName is folded atomically into task_start's claim; prUrl payloads are checked against the project's linked repo."
tags: [workflow, gates, transitions, precondition]
timestamp: 2026-07-03T00:00:00Z
sources:
  - backend/src/services/transition-rules.ts
  - backend/src/services/gates/pr-repo-matches-project.ts
  - backend/src/routes/tasks.ts
  - backend/prisma/schema.prisma
---

**Four built-in transition rules** (`backend/src/services/transition-rules.ts`, `TransitionRule`): `branchPresent` (sync: non-empty `task.branchName`), `prPresent` (sync: both `prUrl` and `prNumber` set), `ciGreen` (async, GitHub-backed: every check run on the PR's head SHA must be `success`), `prMerged` (async, GitHub-backed: the PR must be in the closed-merged state, open, draft, and closed-unmerged all fail). `ciGreen`/`prMerged` are in `GITHUB_BACKED_RULES` and fail closed on any network/API error (`evaluateTransitionRules` catches per-rule throws; a `GithubChecksError` surfaces its status, anything else collapses to a generic "Rule evaluation error"). Workflows attach these to a `transitions[].requires` array (per-transition, per-workflow); admins bypass with `{force: true}` (audited, admin-only, see `claim-model.md`).

**422 shape**: any route evaluating these rules (`/tasks/:id/start`, `/tasks/:id/finish`, `/tasks/:id/transition`, `/tasks/:id/review`) returns `{ error: "precondition_failed", message, failed: [{rule, message, error?}], canForce: false }` with HTTP 422 when one or more required rules fail, the shared logic lives in `evaluateV2TransitionGates` (`backend/src/routes/tasks.ts`, ~line 1919), which resolves the effective workflow definition (or the built-in default), filters any `skipRules` (e.g. `autoMerge` strips `prMerged` from the pre-check since the merge hasn't happened yet), checks `requiredRole`, then calls `evaluateTransitionRules`.

**branchName atomic fold** (`POST /tasks/:id/start`, open→in_progress branch): if the caller supplies `branchName` in the request body AND the task has none yet, it is folded into the *same* gate-evaluation input (`effectiveBranchName = task.branchName ?? providedBranchName ?? null`) and persisted in the *same* `prisma.task.updateMany` compare-and-swap that claims the task (`willPersistBranchName = providedBranchName !== undefined && task.branchName === null`), so a `branchPresent`-gated project can pass its own start-transition gate on the call that claims the work, and a failed gate never leaves a stranded `branchName` write. If the task already has a `branchName`, a supplied value is silently ignored (idempotent re-calls stay safe; overwriting would destroy a pre-existing value).

**Cross-repo `prUrl` guard** (`checkPrRepoMatchesProject`, `backend/src/services/gates/pr-repo-matches-project.ts`, ADR-0010 §5b): active only when `project.githubRepo` is set. Parses `owner/repo` out of both the `prUrl` payload (`github\.com\/([^/]+)\/([^/]+)\/pull\/`) and `project.githubRepo`, case-insensitive compare; a mismatch is rejected, at both `task_finish` (`backend/src/routes/tasks.ts` ~line 2780) and `submit-pr` (~line 3114), with `400 { error: "cross_repo_pr_rejected", message }`. Prevents an agent token valid for project A from driving a merge against project B's repo via a spoofed PR URL.

**`externalRef` idempotency**: `Task.externalRef` (nullable `String`) has `@@unique([projectId, externalRef])` in `backend/prisma/schema.prisma`. `POST /projects/:projectId/tasks` catches `Prisma.PrismaClientKnownRequestError` code `P2002` on that constraint and returns `409` (`conflict(c, ...)`) with a message naming the duplicate `externalRef`, repeated task-creation calls with the same external key are safe to retry.

Related: `claim-model.md`, `governance-merge.md`, `task-lifecycle.md`.
