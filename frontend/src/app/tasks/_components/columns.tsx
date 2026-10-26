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
import DropdownMenu from "../../../components/ui/DropdownMenu";
import { type ColumnDef } from "../../../components/ui/Table";
import { normalizeStatus, toDateLabel } from "../../../lib/taskDisplay";
import { STATUS_MUTED_IN_LIST } from "../../../lib/status";
import { DEMOTE_LABEL, demoteBlockedHint } from "../../../lib/backlogDemote";
import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

export type EnrichedTask = Task & { projectName: string };

// Column widths: none are declared, on purpose. The Table primitive applies
// table-layout: fixed only when some column declares a width, so with no
// widths the /tasks table uses the browser's auto layout: every data column
// sizes to its content and the Task column takes all remaining width (the
// task-list block in globals.css keeps the data columns nowrap and caps the
// project cell, so nothing steals width from the title).
// Sort keys match the server-side SortColumn parameter names (page.tsx).
export const TASK_PAGE_COLUMNS: ColumnDef<EnrichedTask>[] = [
  {
    key: "title",
    header: "Task",
    sortable: true,
    // Short id (first 8 chars of the task's UUID) next to the title so the
    // UI -> agent round-trip works when searching by id/prefix. The
    // trailing "…" is presentational only (CSS ::after on .table-row-id,
    // globals.css) so it never lands in a copy-paste selection; each span
    // carries its own `title` so both the clamped title and the full id
    // stay hoverable, and the chip's aria-label gives screen readers the
    // same short-id text sighted users see (without the decorative "…").
    // The title wraps to at most two lines (.tasks-row-title line clamp,
    // globals.css) instead of truncating on one.
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
    render: (t) => (
      <span className="table-cell-secondary num">{t.dueAt ? toDateLabel(t.dueAt) : "—"}</span>
    ),
  },
  {
    key: "updated",
    header: "Updated",
    sortable: true,
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
    render: (t) => <PriorityLabel priority={t.priority} />,
  },
];

// Handlers threaded from the page for the row actions: Promote and
// Discard on backlog rows, Move to backlog (demote) on open rows.
// `busyTaskId` disables the actions on the row whose action is in flight,
// mirroring the disabled-while-busy pattern used throughout TaskDetail
// (e.g. handleAdvance/advanceBusy).
export interface BacklogRowActionHandlers {
  onPromote: (task: EnrichedTask) => void;
  onDiscard: (task: EnrichedTask) => void;
  onDemote: (task: EnrichedTask) => void;
  busyTaskId: string | null;
}

// Row actions for the /tasks table, behind one "..." menu per row: Promote
// (-> open) and Discard (-> abandoned) for backlog tasks, and Move to
// backlog (open -> backlog) for open tasks; the latter is disabled with a
// hint while the task holds a work or review claim. Same actions as the
// former inline buttons, in a narrow column so the title gets the space.
// The table row itself is a clickable link (rowHref, see page.tsx), so the
// trigger stops propagation on click and on Enter/Space keydown to keep the
// row from navigating -- same pattern as ProjectRowActions in
// app/projects/page.tsx. The menu items need no such guard: the panel is
// portaled to document.body, and the Table row ignores events whose target
// is outside its own DOM (Table.tsx isFromRowDom), although React bubbles
// them through the portal to it. The panel is the shared keyboard-operable
// DropdownMenu primitive (ArrowUp/ArrowDown/Home/End move between items,
// Escape closes and returns focus to the trigger), with menu semantics
// (role="menu" named after the task, role="menuitem" items).
// `rows` is the set of currently rendered table rows (the current page).
// The row-actions column is only appended when at least one of those rows
// is a backlog or an open task -- otherwise a page of in-progress, review or
// done rows would carry a permanently empty column. With no column
// declaring a width the table stays in auto layout (see the note on
// TASK_PAGE_COLUMNS), so no percentage-width scaling can clip the trigger.
export function buildTaskPageColumns(
  handlers: BacklogRowActionHandlers,
  rows: EnrichedTask[],
): ColumnDef<EnrichedTask>[] {
  const hasActionRow = rows.some((t) => {
    const status = normalizeStatus(t.status);
    return status === "backlog" || status === "open";
  });
  if (!hasActionRow) return TASK_PAGE_COLUMNS;
  return [
    ...TASK_PAGE_COLUMNS,
    {
      key: "rowActions",
      header: "Row actions",
      headerVisuallyHidden: true,
      render: (t) => {
        const status = normalizeStatus(t.status);
        if (status !== "backlog" && status !== "open") return null;
        return <TaskRowActionsMenu task={t} handlers={handlers} />;
      },
    },
  ];
}

// One "..." trigger + DropdownMenu panel (portaled to body) per actionable
// row. Disabled while the row's action is in flight: every item of a busy
// row is disabled, and once the menu is open the trigger follows suit so a
// second click only ever closes it.
// While the menu is open, the wrapper stops keydown from bubbling on: the
// row no longer needs it (Table ignores events from outside its DOM), but
// the page's window-level shortcuts ("/" focuses search, "C" opens the
// create flow, page.tsx) would otherwise fire on a key typed inside the
// open menu. The wrapper sits above the DropdownMenu (not inside its
// children), so the panel div keeps handling ArrowUp/ArrowDown/Home/End/
// Escape before the event is stopped here.
function TaskRowActionsMenu({
  task,
  handlers,
}: {
  task: EnrichedTask;
  handlers: BacklogRowActionHandlers;
}) {
  const status = normalizeStatus(task.status);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const busy = handlers.busyTaskId === task.id;
  const triggerDisabled = busy && menuOpen;

  // Closing the menu removes the focused item, so focus goes back to the
  // trigger instead of falling to the page: the row stays when the action
  // keeps it in the current filter, and the Discard confirm dialog returns
  // focus to the trigger when it closes.
  const run = (fn: (task: EnrichedTask) => void) => () => {
    setMenuOpen(false);
    menuBtnRef.current?.focus();
    fn(task);
  };

  const blockedHint = status === "open" ? demoteBlockedHint(task) : null;

  return (
    <div
      className="tasks-row-actions"
      // Only while open: closed, the trigger's own Enter/Space guards below
      // are enough, and global key shortcuts keep working from the trigger.
      onKeyDown={menuOpen ? (e: KeyboardEvent<HTMLDivElement>) => e.stopPropagation() : undefined}
    >
      <button
        ref={menuBtnRef}
        type="button"
        className="tasks-row-actions-btn"
        disabled={triggerDisabled}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Actions for ${task.title}`}
        onClick={(e: MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        // Keep keyboard activation from bubbling to the Table row's
        // onKeyDown, which would navigate the row instead of opening the
        // menu (the button still activates natively on Enter/Space).
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
          if (e.key === "Enter" || e.key === " ") e.stopPropagation();
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>
      <DropdownMenu
        anchorRef={menuBtnRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        minWidth={180}
      >
        <div role="menu" aria-label={`Actions for ${task.title}`}>
          {status === "backlog" ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="app-dropdown-item"
                disabled={busy}
                onClick={run(handlers.onPromote)}
              >
                Promote
              </button>
              <button
                type="button"
                role="menuitem"
                className="app-dropdown-item app-dropdown-item-danger"
                disabled={busy}
                onClick={run(handlers.onDiscard)}
              >
                Discard
              </button>
            </>
          ) : blockedHint !== null ? (
            // The hint is this menu's only content, so it is a disabled menu
            // item the keyboard can reach (role + aria-disabled keep it in
            // the panel's arrow-key cycle, see DropdownMenu.getFocusableItems;
            // tabIndex -1 makes it focusable while open; the panel never
            // activates an aria-disabled item).
            <p
              className="app-dropdown-item app-dropdown-item-disabled"
              role="menuitem"
              aria-disabled="true"
              tabIndex={-1}
              title={blockedHint}
            >
              {DEMOTE_LABEL}: {blockedHint}
            </p>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="app-dropdown-item"
              disabled={busy}
              onClick={run(handlers.onDemote)}
            >
              {DEMOTE_LABEL}
            </button>
          )}
        </div>
      </DropdownMenu>
    </div>
  );
}
