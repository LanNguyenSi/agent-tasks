---
type: overview
title: "The v2 verb surface and the happy-path task lifecycle"
description: "task_create, task_pickup, task_start, task_finish, task_merge, task_abandon, the polymorphic MCP-oriented verbs layered over the classic REST CRUD, plus lazy debugFlavor classification."
tags: [task-lifecycle, mcp, verbs, overview]
timestamp: 2026-07-03T00:00:00Z
sources:
  - backend/src/routes/tasks.ts
  - mcp-server/src/tools.ts
---

ADR-0008 introduced a small, polymorphic "verb" surface on top of the classic REST CRUD, purpose-built for the stdio MCP client (`mcp-server.md`): `task_create`, `task_pickup`, `task_start`, `task_finish`, `task_merge`, `task_abandon`, each exposed both as a backend route (`backend/src/routes/tasks.ts`) and as an MCP tool of the same name (`mcp-server/src/tools.ts`).

**Happy path** (default workflow `open → in_progress → review → done`):
1. `task_create` (`POST /projects/:projectId/tasks`), a human or agent creates a task; `status` defaults to `open`; a create-time confidence score is computed and returned but never blocks creation (see `confidence-scorer.md`).
2. `task_pickup` (`POST /tasks/pickup`, agent-only), "what should I do next?": signals, then review pool, then open-work pool, then idle (exact ordering in `claim-model.md`). On first touching an open task, lazily classifies `debugFlavor` (below).
3. `task_start` (`POST /tasks/:id/start`), polymorphic: on an `open` task it author-claims and transitions to `in_progress`; on a `review` task (reached via `task_pickup`'s review branch or a direct call) it acquires the review lock without changing status. Both branches enforce the single-active-claim rule and the workflow's transition gates (`workflow-gates.md`).
4. `task_finish` (`POST /tasks/:id/finish`), also polymorphic, dispatched on which claim the actor holds: a work claim transitions `in_progress → review` (or `→ done` for workflows that skip review), storing `result`/`prUrl`; a review claim transitions `review → done` (`outcome: "approve"`) or back `→ in_progress` (`outcome: "request_changes"`, notifies the original author). Either can pass `autoMerge: true` to also merge the PR in the same call (Mode A on a work claim requires `governanceMode: AUTONOMOUS`; Mode B on a review claim/self-approve works under any mode but still runs the self-merge gate), see `governance-merge.md`.
5. `task_merge` (`POST /tasks/:id/merge`), the standalone merge verb, split from approval so the audit trail distinguishes "I agree this is done" from "I am the one pushing the GitHub merge button." Requires `review` or `done` status; hardcodes the post-merge status to `done` regardless of `governanceMode` (contrast with the GitHub-webhook path, `governance-merge.md`).
6. `task_abandon` (`POST /tasks/:id/abandon`), releases whichever claim (work and/or review) the actor holds, resetting status back to the workflow's initial state if a work claim was released from a work state. Refuses to release a work claim while the task sits in a review state (would orphan the request-changes auto-resume path), and refuses if the actor holds no claim at all ("call task_start first").

**`debugFlavor` lazy classification**: a task's `metadata.debugFlavor` (boolean) can be set explicitly at `task_create` time (skips the heuristic entirely) or is otherwise left unset and classified lazily, the *first* `task_pickup` or `task_start` call that touches the task runs `detectDebugFlavor` (title/description/labels heuristic) and persists the result into `metadata`. `isFresh` (metadata had no `debugFlavor` yet) gates whether the write happens; `?reclassify=true` forces a re-run and, if the result differs from what was persisted, emits a `task.debugFlavor.reclassified` audit event. A `true` result triggers a grounding-session hint (`groundingHint` in the response) via `GroundingClient`, reconstructed from persisted `groundingSessionState` on subsequent calls rather than re-started.

Related: `claim-model.md`, `workflow-gates.md`, `governance-merge.md`, `mcp-server.md`, `reconcile-done-but-open.md`.
