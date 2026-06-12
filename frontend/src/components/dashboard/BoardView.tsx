"use client";

// Board view: 4-column kanban layout per the Quiet Precision mockup.
// Card anatomy: PriorityLabel + confidence badge + (optional) PR chip | title
// | footer (labels, due, avatar). Column header: status dot + title + tinted
// count Badge + add-task (+) button.
// Geometry in .db-col-*, .db-card-* classes in globals.css.

import { memo, useState } from "react";
import ConfidenceBadge from "../ConfidenceBadge";
import { Badge, type BadgeTone } from "../ui/Badge";
import { Icon } from "../ui/Icon";
import { PriorityLabel } from "../ui/PriorityLabel";
import { calculateConfidence } from "../../lib/confidence";
import { STATUS_LABELS } from "../../lib/status";
import {
  normalizeStatus,
  isOverdue,
  toDateLabel,
  getAssigneeName,
  PRIORITY_RANK,
} from "../../lib/taskDisplay";
import { DONE_BOARD_VISIBLE_LIMIT } from "../../lib/dashboardPrefs";
import type { Task, TaskTemplate } from "../../lib/api";
import { formatAbsoluteDate } from "../../lib/time";

const STATUSES = ["open", "in_progress", "review", "done"] as const;
type Status = (typeof STATUSES)[number];

// Badge tone per column status.
const COLUMN_BADGE_TONE: Record<string, BadgeTone> = {
  open: "status-open",
  "in-progress": "status-in-progress",
  review: "status-review",
  done: "status-done",
};

function getInitials(task: Task): string {
  const name = task.claimedByUser?.name ?? task.claimedByUser?.login ?? task.claimedByAgent?.name ?? "";
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function sortColumnTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const overdueDiff = Number(isOverdue(b)) - Number(isOverdue(a));
    if (overdueDiff !== 0) return overdueDiff;
    const priorityDiff = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
    if (priorityDiff !== 0) return priorityDiff;
    if (a.dueAt || b.dueAt) {
      const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
      const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue - bDue;
    }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

// ── TaskCard ──────────────────────────────────────────────────────

interface TaskCardProps {
  task: Task;
  active: boolean;
  /** Project task template, for the client-side confidence score. */
  templateFields: TaskTemplate["fields"] | null;
  onSelect: (taskId: string) => void;
}

const TaskCard = memo(function TaskCard({ task, active, templateFields, onSelect }: TaskCardProps) {
  const overdue = isOverdue(task);
  const isDone = task.status === "done";
  const hasAssignee = !!(task.claimedByUser || task.claimedByAgent);
  const labels = task.labels ?? [];
  const firstLabel = labels[0];
  const extraLabelCount = labels.length - 1;

  return (
    <button
      type="button"
      className={[
        "db-card",
        active ? "db-card--active" : "",
        isDone ? "db-card--done" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => onSelect(task.id)}
    >
      {/* Top row: priority + confidence + (optional) PR chip */}
      <div className="db-card-top">
        <PriorityLabel priority={task.priority} />
        <ConfidenceBadge
          score={
            calculateConfidence({
              title: task.title,
              description: task.description,
              templateData: task.templateData,
              templateFields,
            }).score
          }
          tabIndex={-1}
        />
        {task.prNumber != null && (
          <span className="db-card-pr-chip">
            <Icon name="pr" size={11} />
            #{task.prNumber}
          </span>
        )}
      </div>

      {/* Title: 2-line clamp */}
      <h3 className="db-card-title">{task.title}</h3>

      {/* Footer: labels + meta-right (due date, avatar) */}
      {(firstLabel || task.dueAt || hasAssignee) && (
        <div className="db-card-foot">
          {firstLabel && (
            <Badge tone="neutral">{firstLabel}</Badge>
          )}
          {extraLabelCount > 0 && (
            <Badge tone="neutral">+{extraLabelCount}</Badge>
          )}

          <div className="db-card-meta-right">
            {task.dueAt && (
              <span
                className={`db-card-due${overdue ? " db-card-due--overdue" : ""}`}
                title={overdue ? "Overdue" : formatAbsoluteDate(task.dueAt)}
              >
                <Icon name="calendar" size={12} />
                {toDateLabel(task.dueAt)}
              </span>
            )}
            {hasAssignee && (
              <span
                className="db-card-avatar"
                title={getAssigneeName(task)}
                aria-label={`Assigned to ${getAssigneeName(task)}`}
              >
                {getInitials(task)}
              </span>
            )}
          </div>
        </div>
      )}
    </button>
  );
});

// ── BoardView ─────────────────────────────────────────────────────

interface BoardViewProps {
  tasks: Task[];
  activeTaskId: string | null;
  /** Project task template, threaded to each card's confidence score. */
  templateFields: TaskTemplate["fields"] | null;
  onSelectTask: (taskId: string) => void;
  onAddTask?: (status: Status) => void;
}

export default function BoardView({
  tasks,
  activeTaskId,
  templateFields,
  onSelectTask,
  onAddTask,
}: BoardViewProps) {
  const [showAllDone, setShowAllDone] = useState(false);

  return (
    <div className="db-board" aria-label="Board">
      {STATUSES.map((status) => {
        const normStatus = normalizeStatus(status);
        const columnLabel = STATUS_LABELS[normStatus] ?? normStatus;
        const columnTasks = sortColumnTasks(tasks.filter((t) => t.status === status));
        const capped = status === "done" && !showAllDone && columnTasks.length > DONE_BOARD_VISIBLE_LIMIT;
        const visibleTasks = capped ? columnTasks.slice(0, DONE_BOARD_VISIBLE_LIMIT) : columnTasks;
        const overflowCount = columnTasks.length - visibleTasks.length;
        const badgeTone = COLUMN_BADGE_TONE[normStatus] ?? "neutral";

        return (
          <section
            key={status}
            className={`db-col db-col--${normStatus}`}
            aria-label={`${columnLabel}, ${columnTasks.length} task${columnTasks.length !== 1 ? "s" : ""}`}
          >
            <header className="db-col-head">
              <span className="db-col-dot" aria-hidden="true" />
              <span className="db-col-title">{columnLabel}</span>
              <Badge tone={badgeTone}>{columnTasks.length}</Badge>
              <button
                type="button"
                className="db-col-add"
                aria-label={`Add task to ${columnLabel}`}
                onClick={() => onAddTask?.(status)}
              >
                <Icon name="plus" size={13} />
              </button>
            </header>

            <div className="db-col-cards">
              {columnTasks.length === 0 ? (
                <div className="db-col-empty">No tasks</div>
              ) : (
                <>
                  {visibleTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      active={task.id === activeTaskId}
                      templateFields={templateFields}
                      onSelect={onSelectTask}
                    />
                  ))}
                  {status === "done" && columnTasks.length > DONE_BOARD_VISIBLE_LIMIT && (
                    <button
                      type="button"
                      className="db-col-expander"
                      onClick={() => setShowAllDone((v) => !v)}
                    >
                      {showAllDone ? "Show less" : `… ${overflowCount} more`}
                    </button>
                  )}
                </>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
