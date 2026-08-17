---
type: module
title: "frontend: Next.js UI"
description: "App-router structure, the two independently-authored task list views, and the hand-maintained confidence-scorer mirror."
tags: [frontend, nextjs, ui, confidence]
timestamp: 2026-08-17T18:01:17Z
sources:
  - frontend/src/app
  - frontend/src/app/tasks/page.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/lib/confidence.ts
  - frontend/src/components/dashboard/NewTaskModal.tsx
---

Next.js 15 app router (`frontend/package.json`: `next@^15.5.18`). Route segments under `frontend/src/app/`: `tasks`, `dashboard`, `projects`, `teams`, `settings`, `onboarding`, `invite`, `auth`, `home`, `dev`. `frontend/src/app/api/` holds exactly two route handlers (`auth/github/route.ts`, `auth/github/connect/route.ts`) for the GitHub OAuth redirect dance, everything else talks to the backend over HTTP, there is no BFF layer.

**Two list views, shared CSS not shared JSX**: `frontend/src/app/tasks/page.tsx` and `frontend/src/app/dashboard/page.tsx` are two independently-written React components (741 and 718 lines respectively; `tasks/page.tsx`'s column render helpers now live in a sibling `_components/columns.tsx`, split out because Next's typed-routes codegen rejects extra named exports from a `page.tsx`) that both render a task list. Each imports its own tree of `components/ui/*` primitives (`Button`, `Skeleton`, `StatusChip`, `Pagination`, etc.) and neither imports the other's list markup, there is no shared `<TaskList>` component. What *is* shared is the class-name vocabulary defined once in `frontend/src/app/globals.css` (e.g. both use `db-search`/`db-search-input`/`num`; `tasks/page.tsx` additionally uses a `tasks-*` prefix, `dashboard/page.tsx` a `db-*` prefix). Practical consequence: a visual/behavioral fix to one list (sorting, empty state, filter chips) must be manually re-applied to the other; there is no single code path to patch.

**Confidence scorer client mirror** (`frontend/src/lib/confidence.ts`, 692 lines): a hand-maintained port of the backend scorer, used for create-time UX so `NewTaskModal.tsx` (`frontend/src/components/dashboard/NewTaskModal.tsx`) can show a live confidence score/badge before the task is even submitted (`calculateConfidence`, `ConfidenceBadge`). It is explicitly commented `FAITHFUL MIRROR ... keep in sync` with `backend/src/lib/confidence.ts`, and is now also parity-checked live in CI, see `confidence-scorer.md` for the mechanism and the exact duplicated section. `BoardView.tsx` and `TaskDetail.tsx` also import from this module directly; `TaskMetaSidebar.tsx` (`components/task-detail/`) does not import it itself, it only renders a `confidenceScore` number `TaskDetail.tsx` computes and passes down as a prop.

Related: `confidence-scorer.md`, `architecture.md`.
