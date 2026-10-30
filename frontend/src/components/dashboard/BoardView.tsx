"use client";

// Board view: a kanban layout in the Quiet Precision style whose columns come
// from the project's workflows (buildBoardColumns): backlog always first, then
// the workflow states, then one extra column per task status no column covers.
// With no columns passed (or workflows the page could not read) it is the
// built-in five: Backlog, Open, In Progress, Review, Done.
// Card anatomy: PriorityLabel + confidence badge + (optional) PR chip | title
// | footer (labels, due, avatar). Column header: status dot + h2 title +
// tinted count Badge + add-task (+) button (an empty slot of the same size on
// the columns without one, so all heads are equally tall).
//
// Semantics: each card is an <article> whose <h3> holds the one interactive
// control, a button named by the task title. Priority, spec score, labels, due
// date (with the word "Overdue") and assignee are the button's accessible
// description (aria-describedby, a hidden sentence list: aria-label on the
// bare spans of the visible row is not reliably part of a description), so a
// screen reader hears the title first; the visible rows repeat that
// description, so they are aria-hidden. A
// click anywhere on the card opens it too (the article forwards the click);
// keyboard users use the title button, Enter or Space.
// Geometry in .db-col-*, .db-card-* classes in globals.css.

import { memo, useState } from "react";
import { Button } from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import ConfidenceBadge, { getConfidenceTier } from "../ConfidenceBadge";
import { Badge, type BadgeTone } from "../ui/Badge";
import { Icon } from "../ui/Icon";
import { PriorityLabel } from "../ui/PriorityLabel";
import { calculateConfidence, resolveEffectiveThreshold, type TaskTypeThresholds } from "../../lib/confidence";
import {
  normalizeStatus,
  isOverdue,
  toDateLabel,
  getAssigneeName,
  PRIORITY_RANK,
} from "../../lib/taskDisplay";
import { DONE_BOARD_VISIBLE_LIMIT } from "../../lib/dashboardPrefs";
import { buildBoardColumns, type BoardColumn } from "../../lib/boardColumns";
import type { Task, TaskTemplate } from "../../lib/api";
import { formatAbsoluteDate } from "../../lib/time";
import { apiTokensSettingsHref } from "../../lib/routes";

/** The only statuses a column's + can hand to the create modal: the pipeline
 *  starts at backlog (the human queue) or at the workflow's initial state,
 *  which is `open` (P5A). */
type Status = "backlog" | "open";

// Badge tone per column status.
const COLUMN_BADGE_TONE: Record<string, BadgeTone> = {
  backlog: "status-backlog",
  open: "status-open",
  "in-progress": "status-in-progress",
  review: "status-review",
  done: "status-done",
};

/** DOM id of a board column section; the jump bar links to it. */
export function columnDomId(status: string): string {
  return `db-col-${status}`;
}

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
  /** Project thresholds for the badge tier, same resolver TaskDetail uses,
   *  so a card and its task page show the same tier. */
  confidenceThreshold: number | null;
  taskTypeThresholds: TaskTypeThresholds | null;
  onSelect: (taskId: string) => void;
}

const TaskCard = memo(function TaskCard({
  task,
  active,
  templateFields,
  confidenceThreshold,
  taskTypeThresholds,
  onSelect,
}: TaskCardProps) {
  const overdue = isOverdue(task);
  const isDone = task.status === "done";
  const hasAssignee = !!(task.claimedByUser || task.claimedByAgent);
  const labels = task.labels ?? [];
  const firstLabel = labels[0];
  const extraLabelCount = labels.length - 1;
  const confidence = calculateConfidence({
    title: task.title,
    description: task.description,
    templateData: task.templateData,
    templateFields,
  });
  // Tier against the project's effective threshold (same resolver TaskDetail
  // uses). With no thresholds threaded from the page the badge keeps its own
  // global-default fallback and omits the threshold sentence from the tooltip.
  const effectiveThreshold =
    confidenceThreshold === null && taskTypeThresholds === null
      ? null
      : resolveEffectiveThreshold(
          confidence.inferredTaskType,
          taskTypeThresholds,
          confidenceThreshold,
        ).effectiveThreshold;

  const descId = `db-card-desc-${task.id}`;
  const hasFoot = !!(firstLabel || task.dueAt || hasAssignee);
  const description = [
    `Priority: ${task.priority.charAt(0).toUpperCase()}${task.priority.slice(1).toLowerCase()}`,
    !isDone && `Spec ${confidence.score}, ${getConfidenceTier(confidence.score, effectiveThreshold)}`,
    task.prNumber != null && `Pull request #${task.prNumber}`,
    labels.length > 0 && `Labels: ${labels.join(", ")}`,
    task.dueAt && `${overdue ? "Overdue, due" : "Due"} ${toDateLabel(task.dueAt)}`,
    hasAssignee && `Assigned to ${getAssigneeName(task)}`,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <article
      className={[
        "db-card",
        active ? "db-card--active" : "",
        isDone ? "db-card--done" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => onSelect(task.id)}
    >
      {/* Top row: priority + confidence + (optional) PR chip.
          Done-column cards show no spec badge; the score
          only steers work that is still live. */}
      <div className="db-card-top" aria-hidden="true">
        <PriorityLabel priority={task.priority} />
        {!isDone && (
          <ConfidenceBadge
            score={confidence.score}
            threshold={effectiveThreshold}
            tabIndex={-1}
          />
        )}
        {task.prNumber != null && (
          <span className="db-card-pr-chip">
            <Icon name="pr" size={11} />
            #{task.prNumber}
          </span>
        )}
      </div>

      {/* Title: the card's one control, described by the hidden sentence. */}
      <h3 className="db-card-title">
        <button type="button" className="db-card-open" aria-describedby={descId}>
          {task.title}
        </button>
      </h3>
      <span id={descId} hidden>
        {description}
      </span>

      {/* Footer: labels + meta-right (due date, avatar) */}
      {hasFoot && (
        <div className="db-card-foot" aria-hidden="true">
          {firstLabel && (
            <Badge tone="neutral">{firstLabel}</Badge>
          )}
          {extraLabelCount > 0 && (
            <Badge tone="neutral">
              +{extraLabelCount}
            </Badge>
          )}

          <div className="db-card-meta-right">
            {task.dueAt && (
              <span
                className={`db-card-due${overdue ? " db-card-due--overdue" : ""}`}
                title={formatAbsoluteDate(task.dueAt)}
              >
                <Icon name="calendar" size={12} />
                {overdue && <span className="db-card-due-word">Overdue</span>}
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
    </article>
  );
});

// ── BoardView ─────────────────────────────────────────────────────

interface BoardViewProps {
  tasks: Task[];
  /** The column list (buildBoardColumns): backlog, the project's workflow
   *  states, extra raw-status columns. Omitted reads as the built-in five,
   *  whatever the tasks are. */
  columns?: BoardColumn[];
  activeTaskId: string | null;
  /** Project task template, threaded to each card's confidence score. */
  templateFields: TaskTemplate["fields"] | null;
  /** Project thresholds threaded to each card's badge tier; omitted (or
   *  null) falls back to the global default, like every other caller. */
  confidenceThreshold?: number | null;
  taskTypeThresholds?: TaskTypeThresholds | null;
  onSelectTask: (taskId: string) => void;
  onAddTask?: (status: Status) => void;
}

export default function BoardView({
  tasks,
  columns,
  activeTaskId,
  templateFields,
  confidenceThreshold = null,
  taskTypeThresholds = null,
  onSelectTask,
  onAddTask,
}: BoardViewProps) {
  const boardColumns = columns ?? buildBoardColumns(undefined, []);
  const [showAllDone, setShowAllDone] = useState(false);

  // Jump-chip activation: scroll the column into view and move focus to its
  // heading (tabIndex -1), so the next Tab continues from the column instead
  // of the page top. The default anchor navigation is prevented, which keeps
  // the #db-col-* hash out of the URL entirely: nothing is left behind when
  // the view toggles to List (a hash written here survived that toggle
  // before). The href stays for click-free activation semantics (copy link,
  // middle click).
  const jumpToColumn = (status: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const column = document.getElementById(columnDomId(status));
    if (!column) return;
    column.scrollIntoView({ block: "start" });
    (column.querySelector(".db-col-title") as HTMLElement | null)?.focus();
  };

  const columnCounts = boardColumns.map((column) => ({
    status: column.status,
    label: column.label,
    count: tasks.filter((t) => t.status === column.status).length,
  }));

  return (
    <>
    {/* Column jump bar: only shown while the columns are stacked (the CSS
        hides it from the 761px width where they stop stacking). Activating
        a chip scrolls that column into view and focuses its heading; the
        href's hash is never written to the URL (see jumpToColumn). */}
    <nav className="db-jump" aria-label="Jump to column">
      {columnCounts.map(({ status, label, count }) => (
        <a
          key={status}
          className="db-jump-chip"
          href={`#${columnDomId(status)}`}
          onClick={jumpToColumn(status)}
          aria-label={`Jump to ${label}, ${count} task${count !== 1 ? "s" : ""}`}
        >
          {label}
          <span className="db-jump-count" aria-hidden="true">{count}</span>
        </a>
      ))}
    </nav>
    <div
      className="db-board"
      role="group"
      aria-label="Board"
      // eslint-disable-next-line no-restricted-syntax
      style={{ "--db-cols": boardColumns.length } as React.CSSProperties} /* dynamic: board column count */
    >
      {boardColumns.map((column) => {
        const { status, terminal } = column;
        const normStatus = normalizeStatus(status);
        const columnLabel = column.label;
        const columnTasks = sortColumnTasks(tasks.filter((t) => t.status === status));
        const capped = terminal && !showAllDone && columnTasks.length > DONE_BOARD_VISIBLE_LIMIT;
        const visibleTasks = capped ? columnTasks.slice(0, DONE_BOARD_VISIBLE_LIMIT) : columnTasks;
        const overflowCount = columnTasks.length - visibleTasks.length;
        const badgeTone = COLUMN_BADGE_TONE[normStatus] ?? "neutral";

        return (
          <section
            key={status}
            id={columnDomId(status)}
            className={`db-col db-col--${normStatus}${column.builtIn ? "" : " db-col--custom"}`}
            aria-label={`${columnLabel}, ${columnTasks.length} task${columnTasks.length !== 1 ? "s" : ""}`}
          >
            <header className="db-col-head">
              <span className="db-col-dot" aria-hidden="true" />
              {/* tabIndex -1: the jump bar moves focus here on activation. */}
              <h2 className="db-col-title" tabIndex={-1}>
                {columnLabel}
              </h2>
              <Badge tone={badgeTone}>{columnTasks.length}</Badge>
              {/* Column-gated create affordance (operator decision
                  2026-08-20): the + only appears where the pipeline can
                  legally start -- Backlog and Open. Every other column,
                  custom workflow states included, never gets one: the
                  initial state is locked to `open` by P5A, so no custom
                  column can be a legal start either. */}
              {status === "backlog" || status === "open" ? (
                <button
                  type="button"
                  className="db-col-add"
                  aria-label={`Add task to ${columnLabel}`}
                  onClick={() => onAddTask?.(status)}
                >
                  <Icon name="plus" size={13} />
                </button>
              ) : (
                /* Reserves the + slot so all heads are equally tall. */
                <span className="db-col-add db-col-add--slot" aria-hidden="true" />
              )}
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
                      confidenceThreshold={confidenceThreshold}
                      taskTypeThresholds={taskTypeThresholds}
                      onSelect={onSelectTask}
                    />
                  ))}
                  {terminal && columnTasks.length > DONE_BOARD_VISIBLE_LIMIT && (
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
    </>
  );
}

// ── First-run empty state ─────────────────────────────────────────

interface BoardEmptyStateProps {
  onNewTask: () => void;
  onImport: () => void;
  /** Team whose settings the "Connect an agent" link opens. */
  teamId?: string;
  /** False hides "Connect an agent" for a viewer who cannot create the
   *  team's agent tokens. Default true. */
  canConnectAgent?: boolean;
}

/** Shown instead of the empty columns when the project has no tasks at
 *  all (filters that hide every task still show the columns). */
export function BoardEmptyState({
  onNewTask,
  onImport,
  teamId,
  canConnectAgent = true,
}: BoardEmptyStateProps) {
  return (
    <div className="db-state-wrap">
      <EmptyState
        icon="box"
        title="No tasks yet"
        description="Create the first task, import existing ones, or connect an agent that creates and picks up tasks."
        dashed
        action={
          <div className="db-empty-actions">
            <Button size="sm" onClick={onNewTask}>
              <Icon name="plus" size={13} />
              New task
            </Button>
            <Button variant="ghost" size="sm" onClick={onImport}>
              Import
            </Button>
            {canConnectAgent && (
              <Button variant="ghost" size="sm" href={apiTokensSettingsHref(teamId)}>
                Connect an agent
              </Button>
            )}
          </div>
        }
      />
    </div>
  );
}
