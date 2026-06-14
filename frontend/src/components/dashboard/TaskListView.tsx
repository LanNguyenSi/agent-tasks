"use client";

// Dashboard list view: renders via the shared ui/Table primitive.
// Sort state is owned here (client-side sort over the full task set) and
// persisted to localStorage. Controlled-sort props bridge Table's header
// clicks back to this component's state.

import { useEffect, useState } from "react";
import { StatusChip } from "../ui/StatusChip";
import { PriorityLabel } from "../ui/PriorityLabel";
import { Table, type ColumnDef } from "../ui/Table";
import type { Task } from "../../lib/api";
import { formatRelativeTime, formatAbsoluteDate } from "../../lib/time";
import { readStoredSort, storeSort } from "../../lib/dashboardPrefs";
import {
  normalizeStatus,
  getAssigneeName,
  toDateLabel,
  PRIORITY_RANK,
} from "../../lib/taskDisplay";

type SortKey = "title" | "status" | "priority" | "assignee" | "dueAt" | "updatedAt";
type SortDir = "asc" | "desc";

const STATUS_RANK: Record<string, number> = { open: 0, in_progress: 1, review: 2, done: 3 };

const NATURAL_DIR: Record<SortKey, SortDir> = {
  title: "asc",
  status: "asc",
  priority: "desc",
  assignee: "asc",
  dueAt: "asc",
  updatedAt: "desc",
};

const SORT_KEYS: readonly SortKey[] = ["title", "status", "priority", "assignee", "dueAt", "updatedAt"];

function sortTasks(tasks: Task[], key: SortKey, dir: SortDir): Task[] {
  const d = dir === "asc" ? 1 : -1;
  return [...tasks].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "title":
        cmp = a.title.localeCompare(b.title);
        break;
      case "status":
        cmp = (STATUS_RANK[a.status] ?? 0) - (STATUS_RANK[b.status] ?? 0);
        break;
      case "priority":
        cmp = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
        break;
      case "assignee":
        cmp = getAssigneeName(a).localeCompare(getAssigneeName(b));
        break;
      case "dueAt": {
        const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
        const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
        cmp = aDue - bDue;
        break;
      }
      case "updatedAt":
        cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        break;
    }
    return cmp * d;
  });
}

// Column definitions are static; render functions close over only imports.
// Widths are required, not cosmetic: `.db-list-wrap .table` uses
// `table-layout: fixed` (globals.css) so the title cell clamps with an
// ellipsis instead of growing and crowding the metadata columns. Without
// per-column widths, fixed layout would distribute all columns equally.
const TASK_LIST_COLS: ColumnDef<Task>[] = [
  {
    key: "title",
    header: "Task",
    sortable: true,
    width: "34%",
    render: (t) => <span className="db-list-cell-title">{t.title}</span>,
  },
  {
    key: "status",
    header: "Status",
    sortable: true,
    width: "12%",
    render: (t) => <StatusChip status={normalizeStatus(t.status)} />,
  },
  {
    key: "priority",
    header: "Priority",
    sortable: true,
    width: "12%",
    render: (t) => <PriorityLabel priority={t.priority} />,
  },
  {
    key: "assignee",
    header: "Assignee",
    sortable: true,
    width: "16%",
    render: (t) => <span className="table-cell-secondary">{getAssigneeName(t)}</span>,
  },
  {
    key: "dueAt",
    header: "Due",
    sortable: true,
    width: "13%",
    render: (t) => (
      <span className="table-cell-secondary num">{t.dueAt ? toDateLabel(t.dueAt) : "—"}</span>
    ),
  },
  {
    key: "updatedAt",
    header: "Updated",
    sortable: true,
    width: "13%",
    render: (t) => (
      <span className="table-cell-secondary num" title={formatAbsoluteDate(t.updatedAt)}>
        {formatRelativeTime(t.updatedAt)}
      </span>
    ),
  },
];

interface TaskListViewProps {
  tasks: Task[];
  onSelectTask: (taskId: string) => void;
  /** Current page (1-based) — drives slice before rendering. */
  page: number;
  pageSize: number;
  /** Called when page changes (parent drives pagination). */
  onPageChange: (page: number) => void;
}

export default function TaskListView({
  tasks,
  onSelectTask,
  page,
  pageSize,
  onPageChange,
}: TaskListViewProps) {
  // Restore persisted sort on mount; fall back to updatedAt desc.
  const stored = readStoredSort(SORT_KEYS);
  const [sortKey, setSortKey] = useState<SortKey>((stored?.column as SortKey | undefined) ?? "updatedAt");
  const [sortDir, setSortDir] = useState<SortDir>(stored?.direction ?? "desc");

  // Persist sort whenever it changes.
  useEffect(() => {
    storeSort({ column: sortKey, direction: sortDir });
  }, [sortKey, sortDir]);

  function handleSortChange(key: string) {
    const newKey = key as SortKey;
    if (sortKey === newKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(newKey);
      setSortDir(NATURAL_DIR[newKey]);
    }
    onPageChange(1);
  }

  const sorted = sortTasks(tasks, sortKey, sortDir);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const sortOptions = TASK_LIST_COLS.filter((c) => c.sortable).map((c) => ({
    value: c.key,
    label: c.header,
  }));

  return (
    <div className="db-list-wrap">
      <Table
        columns={TASK_LIST_COLS}
        rows={paged}
        rowKey={(t) => t.id}
        onRowClick={(t) => onSelectTask(t.id)}
        sortKey={sortKey}
        sortDirection={sortDir === "asc" ? "ascending" : "descending"}
        onSortChange={handleSortChange}
        emptyLabel="No tasks match the current filters."
        compactSort={
          <select
            className="table-sort-native"
            aria-label="Sort by"
            value={`${sortKey}:${sortDir}`}
            onChange={(e) => {
              const [col, dir] = e.target.value.split(":");
              if (col !== sortKey) {
                setSortKey(col as SortKey);
                setSortDir((dir as SortDir) ?? NATURAL_DIR[col as SortKey]);
              } else {
                setSortDir(dir as SortDir);
              }
              onPageChange(1);
            }}
          >
            {sortOptions.map((opt) => (
              <optgroup key={opt.value} label={opt.label}>
                <option value={`${opt.value}:asc`}>{opt.label}: A to Z</option>
                <option value={`${opt.value}:desc`}>{opt.label}: Z to A</option>
              </optgroup>
            ))}
          </select>
        }
      />

      {totalPages > 1 && (
        <div className="db-list-pagination">
          <span className="db-list-page-info num">
            Page {safePage} of {totalPages}
          </span>
          <div className="db-list-page-btns">
            <button
              type="button"
              className="btn-ghost btn--box btn--sm"
              disabled={safePage <= 1}
              onClick={() => onPageChange(safePage - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn-ghost btn--box btn--sm"
              disabled={safePage >= totalPages}
              onClick={() => onPageChange(safePage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
