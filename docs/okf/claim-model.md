---
type: invariant
title: "Claim model: task_pickup resolution order and single-active-claim"
description: "Signals, then review, then open work, then idle; priority desc/createdAt asc; blockedBy filtering; one active claim per agent enforced in both pickup and start; status is an unconstrained free String."
tags: [claim, pickup, status, dependencies]
timestamp: 2026-08-20T07:56:41Z
sources:
  - backend/src/routes/tasks.ts
  - backend/prisma/schema.prisma
  - mcp-server/src/errors.ts
---

**`POST /tasks/pickup`** (agent-only; humans get `400 bad_request`, told to use `/tasks/claimable` instead) resolves "what should I do next?" in this fixed order, first hit wins:

1. **Signals**, the oldest unacknowledged `Signal` addressed to this agent (`recipientAgentId`), excluding stale ones: `review_needed`/`task_available`/`task_assigned` are dropped once their task reaches `done` (they ask the recipient to *do* something that no longer applies), but `task_approved`/`changes_requested`/`task_force_transitioned` are outcome notifications that survive even against a terminal task. The matched signal is acknowledged (`acknowledgedAt` set) atomically as part of returning it, at-most-once delivery.
2. **Review pickup**, oldest-by-`(priority desc, createdAt asc)` task with `status: "review"`, no existing review claim (`reviewClaimedByAgentId`/`reviewClaimedByUserId` both null), and `createdByAgentId !== actor.tokenId` (distinct-reviewer at the pool level, independent of `governanceMode`, see `governance-merge.md`), team-scoped, with `blockedBy: { none: { status: { notIn: ["done", "abandoned"] } } }`.
3. **Open work**, same ordering/blocking rule, `status: "open"`, unclaimed. On the first hit, `deriveDebugFlavor` runs (see below) and, if fresh or `?reclassify=true`, persists `metadata.debugFlavor` before responding.
4. **Idle**, `{ kind: "idle" }` if nothing above matched.

**Hard-limit, single active claim per agent**: before any of the above, both `POST /tasks/pickup` and `POST /tasks/:id/start` reject with `409 { error: "already_claimed", activeClaim: {taskId, title, role} }` if the calling agent already holds *any* active claim, an author claim (`claimedByAgentId`, `status !== "done"`) or a review claim (`reviewClaimedByAgentId`, `status === "review"`). The two call sites duplicate this check independently (same query shape); there is no shared helper. Parallelism is achieved by using multiple agent identities, not by one identity holding concurrent claims. `mcp-server`'s teaching-error layer (`mcp-server/src/errors.ts`'s `alreadyClaimedError`/`extractActiveClaim`) passes this same `activeClaim` through, clamped, as `detail.activeClaim` on the MCP-facing `already_claimed` error, and lists `tasks_get` in `allowedNext` so a caller can check `activeClaim.taskId`'s actual status.

**Ordering**: every claim-pool query orders `[{ priority: "desc" }, { createdAt: "asc" }]`, highest `TaskPriority` (`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`) first, oldest-within-priority first.

**Dependency gate**: `blockedBy: { none: { status: { notIn: RESOLVED_BLOCKER_STATUSES } } }` (`RESOLVED_BLOCKER_STATUSES = ["done", "abandoned"]`) at the Prisma level for pool selection, and `POST /tasks/:id/start` and `POST /tasks/:id/claim` separately re-check `blockedBy` (`unresolved = blockers.filter(dep => !RESOLVED_BLOCKER_STATUSES.includes(dep.status))`) and return `409 { error: "blocked", blockedBy: [...] }` if any blocker is unresolved, belt-and-suspenders against a race between pool selection and claim. `abandoned` counts as resolved-for-gating since task 5200f326 (treat-abandoned-as-resolved): a dependent whose sole blocker was creator-abandoned (`POST /tasks/:id/creator-abandon`, task 7a1360da) is claimable again instead of deadlocking forever; the `blockedBy` edge itself is left intact, this is a predicate change only, not auto-detach. The gate is claim-time-only and is never re-evaluated afterward: nothing hooks a blocker's status change to re-scan its dependents, so unabandoning a blocker (the admin-only `PATCH /tasks/:id` recovery path) does not retroactively re-block a dependent that already claimed while the blocker sat `abandoned`. One consequence of that design choice: an agent that created both the blocker and the dependent can resolve its own ordering unilaterally, by creator-abandoning the blocker it no longer needs to gate on (workflow ordering the creator already controlled, not an authorization boundary being crossed).

**`status` is a free `String` column**, not a DB enum: `backend/prisma/schema.prisma` declares `status String @default("open")` on `Task`. The four-value vocabulary (`open`, `in_progress`, `review`, `done`, plus `abandoned` in the claimable-filter list) is enforced only at input-schema edges: `createTaskSchema`'s Zod `z.enum([...])` on create, and `PROJECT_TASK_STATUSES`/`CLAIMABLE_VALID_STATUSES` array checks on the list/claimable query params. A custom workflow can introduce arbitrary additional status strings; nothing at the schema level stops it.

**Forced transitions are admin-only**: `POST /tasks/:id/transition` with `{ force: true }` returns `403` unless `isProjectAdmin(actor, task.projectId)`, checked unconditionally, before the workflow-precondition evaluation, specifically so a non-admin can't bypass the distinct-reviewer gate merely by having no failing preconditions to force past.

**`debugFlavor` lazy classification**: see `task-lifecycle.md`.

Related: `workflow-gates.md`, `governance-merge.md`, `task-lifecycle.md`.
