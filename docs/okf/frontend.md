---
type: module
title: "frontend: Next.js UI"
description: "App-router structure, the two independently-authored task list views, the backlog board column, and the hand-maintained confidence-scorer mirror."
tags: [frontend, nextjs, ui, confidence, backlog]
timestamp: 2026-09-02T04:50:50Z
sources:
  - frontend/src/app
  - frontend/src/app/tasks/page.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/components/dashboard/BoardView.tsx
  - frontend/src/lib/confidence.ts
  - frontend/src/components/dashboard/NewTaskModal.tsx
  - frontend/package.json
---

Next.js 15 app router (`frontend/package.json`: `next@^15`). Route segments under `frontend/src/app/`: `tasks`, `dashboard`, `projects`, `teams`, `settings`, `onboarding`, `invite`, `auth`, `home`, `dev`. `frontend/src/app/api/` holds exactly two route handlers (`auth/github/route.ts`, `auth/github/connect/route.ts`) for the GitHub OAuth redirect dance, everything else talks to the backend over HTTP, there is no BFF layer.

**Board view** (`frontend/src/components/dashboard/BoardView.tsx`): a Kanban board with columns for `Backlog` (agent-created tasks awaiting human review, left of Open with a count badge), `Open`, `In Progress`, `Review`, and `Done`. The backlog column includes row-level actions to promote a task to `Open` or discard it (transition to `abandoned`); the same promote/discard actions are available in the task detail header and in the `/tasks` table. Promoting backlog to open or discarding it to abandoned uses `PATCH /tasks/:id { status: "open" | "abandoned" }` and is human-only, matching the backend contract documented in `task-lifecycle.md`. **Column-gated create affordance** (operator decision 2026-08-20, `#483`): the header `+` button only renders on the `Backlog` and `Open` columns (`status === "backlog" || status === "open"`, `BoardView.tsx:197`) — `In Progress`, `Review`, and `Done` never get one, since those are not states the pipeline can legally start a task in.

**Create modal, backlog-first default** (`frontend/src/components/dashboard/NewTaskModal.tsx`, `#482`, supersedes D19): the Status dropdown offers exactly two values, `backlog` and `open` (Backlog listed first), defaulting to `DEFAULT_CREATE_STATUS` (`frontend/src/lib/status.ts`, `"backlog"`) unless a caller (e.g. a board column's `+`) passes an `initialStatus` hint; any other incoming value is clamped back to the default. Backlog is now the default create target for human-initiated creates too, not agent-only. While the selected status is `backlog`, the Assignee `"me"` option is disabled via the `Select` component's `aria-disabled` pattern (`components/ui/Select.tsx`, not the native `disabled` attribute, so the option stays screen-reader-visible-but-unavailable rather than hidden) — self-claiming on create makes no sense for a task that is not yet promoted out of backlog.

**Two list views, shared CSS not shared JSX**: `frontend/src/app/tasks/page.tsx` and `frontend/src/app/dashboard/page.tsx` are two independently-written React components (825 and 739 lines respectively; `tasks/page.tsx`'s column render helpers now live in a sibling `_components/columns.tsx`, split out because Next's typed-routes codegen rejects extra named exports from a `page.tsx`) that both render a task list. Each imports its own tree of `components/ui/*` primitives (`Button`, `Skeleton`, `StatusChip`, `Pagination`, etc.) and neither imports the other's list markup, there is no shared `<TaskList>` component. What *is* shared is the class-name vocabulary defined once in `frontend/src/app/globals.css` (e.g. both use `db-search`/`db-search-input`/`num`; `tasks/page.tsx` additionally uses a `tasks-*` prefix, `dashboard/page.tsx` a `db-*` prefix). The tasks list includes a backlog filter and promote/discard row actions. Practical consequence: a visual/behavioral fix to one list (sorting, empty state, filter chips) must be manually re-applied to the other; there is no single code path to patch.

**Confidence scorer client mirror** (`frontend/src/lib/confidence.ts`, 1290 lines): a hand-maintained port of the backend scorer, used for create-time UX so `NewTaskModal.tsx` (`frontend/src/components/dashboard/NewTaskModal.tsx`) can show a live confidence score/badge before the task is even submitted (`calculateConfidence`, `ConfidenceBadge`). It is explicitly commented `FAITHFUL MIRROR ... keep in sync` with `backend/src/lib/confidence.ts`, and is now also parity-checked live in CI, see `confidence-scorer.md` for the mechanism and the exact duplicated section. `BoardView.tsx` and `TaskDetail.tsx` also import from this module directly; `TaskMetaSidebar.tsx` (`components/task-detail/`) does not import it itself, it only renders a `confidenceScore` number `TaskDetail.tsx` computes and passes down as a prop.

Related: `confidence-scorer.md`, `architecture.md`.
