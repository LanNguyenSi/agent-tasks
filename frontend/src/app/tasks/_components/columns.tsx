// Column definitions for the /tasks browser's table (src/app/tasks/page.tsx).
// Pulled out of page.tsx (a route file) because Next's typed-routes codegen
// (.next/types/app/tasks/page.ts) rejects any named export from a `page.tsx`
// beyond the reserved route symbols (default, metadata, generateStaticParams,
// ...) — `tsc --noEmit` fails on TASK_PAGE_COLUMNS/EnrichedTask living there.
// This file is not a reserved Next filename (and lives under the
// underscore-prefixed `_components/`, Next's convention for route-private
// helpers — see src/app/projects/[id]/workflow/_components/), so exporting
// from here is safe and lets tests render individual column cells (e.g. the
// id-chip title cell, see tests/unit/TasksPageTitleCell.test.tsx) without
// mounting the whole data-fetching page component.
import type { Task } from "../../../lib/api";
import { formatAbsoluteDate, formatRelativeTime } from "../../../lib/time";
import { StatusChip } from "../../../components/ui/StatusChip";
import { PriorityLabel } from "../../../components/ui/PriorityLabel";
import { type ColumnDef } from "../../../components/ui/Table";
import { normalizeStatus, toDateLabel } from "../../../lib/taskDisplay";
import { STATUS_MUTED_IN_LIST } from "../../../lib/status";

export type EnrichedTask = Task & { projectName: string };

// Sort keys match the server-side SortColumn parameter names (page.tsx).
// Render functions close over module-level imports only (no component state).
export const TASK_PAGE_COLUMNS: ColumnDef<EnrichedTask>[] = [
  {
    key: "title",
    header: "Task",
    sortable: true,
    width: "34%",
    // Short id (first 8 chars of the task's UUID) next to the title so the
    // UI -> agent round-trip works when searching by id/prefix. The
    // trailing "…" is presentational only (CSS ::after on .table-row-id,
    // globals.css) so it never lands in a copy-paste selection; each span
    // carries its own `title` so both the clamped title and the full id
    // stay hoverable, and the chip's aria-label gives screen readers the
    // same short-id text sighted users see (without the decorative "…").
    render: (t) => (
      <span className="table-title-row">
        <span className="tasks-row-title" title={t.title}>
          {t.title}
        </span>
        <span className="table-row-id" title={t.id} aria-label={`Task id ${t.id.slice(0, 8)}`}>
          {t.id.slice(0, 8)}
        </span>
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    sortable: true,
    width: "12%",
    render: (t) => {
      const nStatus = normalizeStatus(t.status);
      const isMuted = STATUS_MUTED_IN_LIST.has(nStatus);
      return <StatusChip status={nStatus} className={isMuted ? "status-chip--muted" : undefined} />;
    },
  },
  {
    key: "project",
    header: "Project",
    sortable: true,
    width: "16%",
    render: (t) => (
      <span className="table-cell-secondary" title={t.projectName}>
        {t.projectName}
      </span>
    ),
  },
  {
    key: "due",
    header: "Due",
    sortable: true,
    width: "13%",
    render: (t) => (
      <span className="table-cell-secondary num">{t.dueAt ? toDateLabel(t.dueAt) : "—"}</span>
    ),
  },
  {
    key: "updated",
    header: "Updated",
    sortable: true,
    width: "13%",
    render: (t) => (
      <span className="table-cell-secondary num" title={formatAbsoluteDate(t.updatedAt)}>
        {formatRelativeTime(t.updatedAt)}
      </span>
    ),
  },
  {
    key: "priority",
    header: "Priority",
    sortable: true,
    width: "12%",
    render: (t) => <PriorityLabel priority={t.priority} />,
  },
];
