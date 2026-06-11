"use client";

// List view for the dashboard: semantic <table> using the shared .table-*
// CSS classes from globals.css (same classes the Table primitive uses).
// Row clicks open the TaskDetail modal via onSelectTask — not navigation,
// so we build the rows ourselves rather than relying on Table's rowHref
// mechanism (which wraps the title cell in an <a>).
//
// Columns: title, status (StatusChip), priority (PriorityLabel), assignee,
// due, updated. All columns are sortable; sort state is owned here so it
// doesn't conflict with external pagination.

import { useEffect, useState } from "react";
import { StatusChip } from "../ui/StatusChip";
import { PriorityLabel } from "../ui/PriorityLabel";
import { Icon } from "../ui/Icon";
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

interface ColDef {
  key: SortKey;
  label: string;
}

const COLUMNS: ColDef[] = [
  { key: "title", label: "Task" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "assignee", label: "Assignee" },
  { key: "dueAt", label: "Due" },
  { key: "updatedAt", label: "Updated" },
];

const NATURAL_DIR: Record<SortKey, SortDir> = {
  title: "asc",
  status: "asc",
  priority: "desc",
  assignee: "asc",
  dueAt: "asc",
  updatedAt: "desc",
};

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

interface TaskListViewProps {
  tasks: Task[];
  onSelectTask: (taskId: string) => void;
  /** Current page (1-based) — drives slice before rendering. */
  page: number;
  pageSize: number;
  /** Called when page changes (parent drives pagination). */
  onPageChange: (page: number) => void;
}

const SORT_KEYS: readonly SortKey[] = ["title", "status", "priority", "assignee", "dueAt", "updatedAt"];

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

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      onPageChange(1); // L1 fix: reset page when reversing direction
    } else {
      setSortKey(key);
      setSortDir(NATURAL_DIR[key]);
      onPageChange(1);
    }
  }

  const sorted = sortTasks(tasks, sortKey, sortDir);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="db-list-wrap">
      <div className="table-wrapper">
        <table className="table" aria-label="Task list">
          <thead>
            <tr className="table-head-row">
              {COLUMNS.map((col) => {
                const isActive = sortKey === col.key;
                const ariaSort = isActive
                  ? sortDir === "asc"
                    ? ("ascending" as const)
                    : ("descending" as const)
                  : ("none" as const);
                return (
                  <th
                    key={col.key}
                    className="table-th"
                    aria-sort={ariaSort}
                    data-col={col.key}
                  >
                    <button
                      type="button"
                      className={[
                        "table-sort-btn",
                        isActive ? "table-sort-btn--active" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => toggleSort(col.key)}
                    >
                      {col.label}
                      <span
                        className={[
                          "table-sort-icon",
                          isActive && sortDir === "asc" ? "table-sort-icon--up" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        aria-hidden="true"
                      >
                        <Icon
                          name={
                            isActive && sortDir === "desc"
                              ? "chevron-down"
                              : "chevron-right"
                          }
                          size={12}
                        />
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr className="table-tr table-tr--state">
                <td colSpan={COLUMNS.length} className="table-td table-td--state">
                  No tasks match the current filters.
                </td>
              </tr>
            ) : (
              paged.map((task) => (
                <tr
                  key={task.id}
                  className="table-tr table-tr--link"
                  onClick={() => onSelectTask(task.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectTask(task.id);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open task: ${task.title}`}
                >
                  <td className="table-td" data-col="title" data-label="Task">
                    <span className="db-list-cell-title">{task.title}</span>
                  </td>
                  <td className="table-td" data-col="status" data-label="Status">
                    <StatusChip status={normalizeStatus(task.status)} />
                  </td>
                  <td className="table-td" data-col="priority" data-label="Priority">
                    <PriorityLabel priority={task.priority} />
                  </td>
                  <td className="table-td task-list-cell-muted" data-col="assignee" data-label="Assignee">
                    {getAssigneeName(task)}
                  </td>
                  <td className="table-td task-list-cell-muted num" data-col="dueAt" data-label="Due">
                    {task.dueAt ? toDateLabel(task.dueAt) : "—"}
                  </td>
                  <td
                    className="table-td task-list-cell-updated"
                    data-col="updatedAt"
                    data-label="Updated"
                    title={formatAbsoluteDate(task.updatedAt)}
                  >
                    {formatRelativeTime(task.updatedAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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
