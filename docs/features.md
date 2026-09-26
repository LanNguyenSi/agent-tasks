# Features

Detail behind the README's Key features summary.

## Task templates and dependencies

Task-template mode (the per-project `taskTemplate` in
`backend/prisma/schema.prisma`, validated by `templateDataSchema` in
`backend/src/lib/confidence.ts`) scaffolds structured fields on a task, such
as goal, acceptance criteria, context, and constraints (the configurable set
also includes scope, out of scope, dependencies, risk, and an agent prompt). Tasks can also declare block / blocked-by relationships
(`dependsOn` at create time); the backend runs a BFS cycle check before
accepting a new dependency edge and rejects one that would create a cycle
(`backend/src/routes/tasks.ts`).

## CSV/Excel import with Jira column auto-detection

`frontend/src/lib/import-mapping.ts` auto-detects Jira Excel/CSV export
column headers in both German and English and maps them onto the internal
task fields, so a Jira export can be imported without hand-mapping columns
first. `frontend/src/lib/wiki-to-markdown.ts` converts the Confluence/Jira
wiki markup commonly found in the description column of those exports into
Markdown.

A separate CLI tool, `tools/jira-import/jira-import.ts`, imports directly
from a live Jira instance over its REST API (JQL query, dry-run mode) for
teams that want to pull issues without an intermediate export file.

## Board and list views

The task board and list views support status/priority/label filters, a text
search box, pagination, and priority-aware sorting
(`frontend/src/app/tasks/page.tsx`, `frontend/src/components/dashboard/TaskListView.tsx`;
the label filter lives on the dashboard board, `frontend/src/app/dashboard/page.tsx`
with `frontend/src/components/dashboard/FilterToolbar.tsx`).

## Cross-team share visibility

Admins can list active project shares (ProjectMember and ProjectInvite
state) across every project where they hold a team-admin role via
`GET /api/admin/project-shares` (`backend/src/routes/invites.ts`). The route
is human-only: agent callers are rejected because agent tokens do not carry
a per-user team role.
