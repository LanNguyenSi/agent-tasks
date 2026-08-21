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
import type { KeyboardEvent, MouseEvent } from "react";
import type { Task } from "../../../lib/api";
import { formatAbsoluteDate, formatRelativeTime } from "../../../lib/time";
import { StatusChip } from "../../../components/ui/StatusChip";
import { PriorityLabel } from "../../../components/ui/PriorityLabel";
import { Button } from "../../../components/ui/Button";
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

// Handlers threaded from the page for the backlog Promote/Discard row
// actions. `busyTaskId` disables both buttons on the row whose action is
// in flight, mirroring the disabled-while-busy pattern used throughout
// TaskDetail (e.g. handleAdvance/advanceBusy).
export interface BacklogRowActionHandlers {
  onPromote: (task: EnrichedTask) => void;
  onDiscard: (task: EnrichedTask) => void;
  busyTaskId: string | null;
}

// Row actions for the /tasks table: Promote (-> open) and Discard
// (-> abandoned), visible ONLY for backlog tasks. The table row itself is a
// clickable link (rowHref, see page.tsx), so each button stops propagation
// on click and on Enter/Space keydown to keep the row from navigating —
// same pattern as ProjectRowActions in app/teams/page.tsx.
// `rows` is the set of currently rendered table rows (the current page).
// The backlog actions column is only appended when at least one of those
// rows is a backlog task -- otherwise every project without backlog tasks
// would carry a permanently empty 13%-wide column.
// TASK_PAGE_COLUMNS' widths sum to 100% on their own (34+12+16+13+13+12).
// The table uses table-layout: fixed (globals.css .table--fixed) whenever
// any column declares a width, so percentages are binding, not hints: if a
// row's declared widths summed to more than 100%, the browser scales every
// column down proportionally to fit, which shrinks the trailing actions
// column enough to clip its buttons (the bug this const fixes). Appending
// the 13%-wide backlogActions column below would push the sum to 113%, so
// the title column -- the one column with headroom, since its ellipsis
// already handles overflow -- gives up the same 13pp here to keep the
// present-case sum at exactly 100%.
const TITLE_WIDTH_WITH_BACKLOG_ACTIONS = "21%";

export function buildTaskPageColumns(
  handlers: BacklogRowActionHandlers,
  rows: EnrichedTask[],
): ColumnDef<EnrichedTask>[] {
  const hasBacklogRow = rows.some((t) => normalizeStatus(t.status) === "backlog");
  if (!hasBacklogRow) return TASK_PAGE_COLUMNS;
  const baseColumns = TASK_PAGE_COLUMNS.map((c) =>
    c.key === "title" ? { ...c, width: TITLE_WIDTH_WITH_BACKLOG_ACTIONS } : c,
  );
  return [
    ...baseColumns,
    {
      key: "backlogActions",
      header: "Backlog actions",
      headerVisuallyHidden: true,
      width: "13%",
      render: (t) => {
        if (normalizeStatus(t.status) !== "backlog") return null;
        const busy = handlers.busyTaskId === t.id;
        const stopKeyPropagation = (e: KeyboardEvent<HTMLButtonElement>) => {
          if (e.key === "Enter" || e.key === " ") e.stopPropagation();
        };
        return (
          <div className="tasks-row-actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={(e: MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                handlers.onPromote(t);
              }}
              onKeyDown={stopKeyPropagation}
            >
              Promote
            </Button>
            <Button
              type="button"
              variant="outline-danger"
              size="sm"
              disabled={busy}
              onClick={(e: MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                handlers.onDiscard(t);
              }}
              onKeyDown={stopKeyPropagation}
            >
              Discard
            </Button>
          </div>
        );
      },
    },
  ];
}
