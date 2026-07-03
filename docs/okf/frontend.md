---
type: module
title: "frontend: Next.js UI"
description: "App-router structure, the two independently-authored task list views, and the hand-maintained confidence-scorer mirror."
tags: [frontend, nextjs, ui, confidence]
timestamp: 2026-07-03T00:00:00Z
sources:
  - frontend/src/app
  - frontend/src/app/tasks/page.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/lib/confidence.ts
  - frontend/src/components/dashboard/NewTaskModal.tsx
---

Next.js 15 app router (`frontend/package.json`: `next@^15.5.18`). Route segments under `frontend/src/app/`: `tasks`, `dashboard`, `projects`, `teams`, `settings`, `onboarding`, `invite`, `auth`, `home`, `dev`. `frontend/src/app/api/` holds exactly two route handlers (`auth/github/route.ts`, `auth/github/connect/route.ts`) for the GitHub OAuth redirect dance, everything else talks to the backend over HTTP, there is no BFF layer.

**Two list views, shared CSS not shared JSX**: `frontend/src/app/tasks/page.tsx` and `frontend/src/app/dashboard/page.tsx` are two independently-written React components (807 and 673 lines respectively) that both render a task list. Each imports its own tree of `components/ui/*` primitives (`Button`, `Skeleton`, `StatusChip`, `Pagination`, etc.) and neither imports the other's list markup, there is no shared `<TaskList>` component. What *is* shared is the class-name vocabulary defined once in `frontend/src/app/globals.css` (e.g. both use `db-search`/`db-search-input`/`num`; `tasks/page.tsx` additionally uses a `tasks-*` prefix, `dashboard/page.tsx` a `db-*` prefix). Practical consequence: a visual/behavioral fix to one list (sorting, empty state, filter chips) must be manually re-applied to the other; there is no single code path to patch.

**Confidence scorer client mirror** (`frontend/src/lib/confidence.ts`, 636 lines): a hand-maintained port of the backend scorer, used for create-time UX so `NewTaskModal.tsx` (`frontend/src/components/dashboard/NewTaskModal.tsx`) can show a live confidence score/badge before the task is even submitted (`calculateConfidence`, `ConfidenceBadge`). It is explicitly commented `FAITHFUL MIRROR ... keep in sync` with `backend/src/lib/confidence.ts`, see `confidence-scorer.md` for the parity mechanism and the exact duplicated section. `BoardView.tsx` and `TaskMetaSidebar.tsx`/`TaskDetail.tsx` also import from this module.

Related: `confidence-scorer.md`, `architecture.md`.
