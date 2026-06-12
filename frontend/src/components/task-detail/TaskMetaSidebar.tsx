// Properties sidebar for the task detail two-column layout.
// Shows: status chip, priority, assignee (with claim/release), labels,
// branch chip, due date, created date, confidence bar (if templateFields exist).
// Below a divider: next-workflow-step note.
//
// Confidence score is passed pre-calculated by the parent (TaskDetail) so it
// reflects the live editing state without this component importing calculateConfidence.

import type { Task, User } from "@/lib/api";
import { normalizeStatus } from "@/lib/status";
import { StatusChip } from "@/components/ui/StatusChip";
import { PriorityLabel } from "@/components/ui/PriorityLabel";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { formatAbsoluteDate, formatDueDate } from "@/lib/time";

interface TaskMetaSidebarProps {
  task: Task;
  user: User | null;
  confidenceScore: number | null;
  onClaim: () => void;
  onRelease: () => void;
  claimBusy: boolean;
}

function isOverdue(task: Task): boolean {
  if (!task.dueAt || task.status === "done") return false;
  return new Date(task.dueAt).getTime() < Date.now();
}

function getAssigneeLabel(task: Task): string {
  if (!task.claimedByUserId && !task.claimedByAgentId) return "Unassigned";
  if (task.claimedByUser) return task.claimedByUser.name ?? task.claimedByUser.login;
  if (task.claimedByAgent) return `Agent ${task.claimedByAgent.name}`;
  return "Assigned";
}

function getAssigneeInitials(task: Task): string {
  const name = task.claimedByUser?.name ?? task.claimedByUser?.login;
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// Maps in_progress to the workflow-note text (what the next step is).
const NEXT_STEP: Record<string, string> = {
  open: "can be started",
  in_progress: "can move to Review",
  review: "awaits review decision",
  done: "complete",
};

export default function TaskMetaSidebar({
  task,
  user,
  confidenceScore,
  onClaim,
  onRelease,
  claimBusy,
}: TaskMetaSidebarProps) {
  const overdue = isOverdue(task);
  const assigned = Boolean(task.claimedByUserId || task.claimedByAgentId);
  const isOwnTask = task.claimedByUserId === user?.id;
  const canClaim = !assigned && task.status !== "open";
  const nextStep = NEXT_STEP[task.status] ?? "in an unknown state";

  return (
    <div>
      <p className="td-props-kicker">Properties</p>
      <div className="td-props">

        {/* Status */}
        <span className="td-prop-label">Status</span>
        <span className="td-prop-value">
          <StatusChip status={normalizeStatus(task.status)} />
        </span>

        {/* Priority */}
        <span className="td-prop-label">Priority</span>
        <span className="td-prop-value">
          <PriorityLabel priority={task.priority} />
        </span>

        {/* Assignee + claim/release */}
        <span className="td-prop-label">Assignee</span>
        <span className="td-prop-value">
          <span className="td-assignee-row">
            {assigned ? (
              <>
                <span className="td-avatar" aria-hidden="true">
                  {task.claimedByAgent ? "AI" : getAssigneeInitials(task)}
                </span>
                <span>{getAssigneeLabel(task)}</span>
                {/* Never offer Release on a terminal task: the release route
                    resets to the workflow's initial state, which would
                    silently reopen completed work. */}
                {isOwnTask && task.status !== "done" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onRelease}
                    disabled={claimBusy}
                    loading={claimBusy}
                  >
                    Release
                  </Button>
                )}
              </>
            ) : (
              <>
                <span className="td-prop-label">Unassigned</span>
                {canClaim && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onClaim}
                    disabled={claimBusy}
                    loading={claimBusy}
                  >
                    Claim
                  </Button>
                )}
              </>
            )}
          </span>
        </span>

        {/* Labels */}
        {task.labels && task.labels.length > 0 && (
          <>
            <span className="td-prop-label">Labels</span>
            <span className="td-prop-value">
              {task.labels.map((label) => (
                <span key={label} className="badge badge--neutral">
                  {label}
                </span>
              ))}
            </span>
          </>
        )}

        {/* Branch */}
        {task.branchName && (
          <>
            <span className="td-prop-label">Branch</span>
            <span className="td-prop-value">
              <span className="td-branch-chip" title={task.branchName}>
                <Icon name="branch" size={11} aria-hidden />
                {task.branchName}
              </span>
            </span>
          </>
        )}

        {/* PR */}
        {task.prUrl && (
          <>
            <span className="td-prop-label">PR</span>
            <span className="td-prop-value">
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="td-branch-chip"
                onClick={(e) => e.stopPropagation()}
              >
                <Icon name="pr" size={11} aria-hidden />
                {task.prNumber ? `#${task.prNumber}` : "Open PR"}
              </a>
            </span>
          </>
        )}

        {/* Due date */}
        <span className="td-prop-label">Due date</span>
        <span className="td-prop-value">
          {task.dueAt ? (
            <span
              className={["td-due-val", overdue ? "td-due-val--overdue" : ""]
                .filter(Boolean)
                .join(" ")}
              title={formatAbsoluteDate(task.dueAt)}
            >
              <Icon name="calendar" size={12} aria-hidden />
              {formatDueDate(task.dueAt)}
              {overdue && " · Overdue"}
            </span>
          ) : (
            <span className="td-prop-label">None</span>
          )}
        </span>

        {/* Created */}
        <span className="td-prop-label">Created</span>
        <span className="td-prop-value td-prop-value--muted num">
          {new Date(task.createdAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </span>

        {/* Confidence */}
        {confidenceScore !== null && (
          <>
            <span className="td-prop-label">Confidence</span>
            <span className="td-prop-value">
              <span className="td-conf">
                <span className="td-conf-bar" aria-hidden="true">
                  <span
                    className="td-conf-bar-fill"
                    // eslint-disable-next-line no-restricted-syntax
                    style={{ width: `${confidenceScore}%` }} /* dynamic: confidence percentage width */
                  />
                </span>
                <span className="td-conf-num num">{confidenceScore}/100</span>
              </span>
            </span>
          </>
        )}

      </div>

      <div className="td-aside-divider" />
      <p className="td-next-transition">
        Workflow: this task {nextStep}.{" "}
        {task.status === "in_progress" && (
          <>
            Next:{" "}
            <span className="td-next-transition-to">Review</span>.
          </>
        )}
        {task.status === "open" && (
          <>
            Claim and start to begin work.
          </>
        )}
        {task.status === "review" && (
          <>
            Awaiting{" "}
            <span className="td-next-transition-to">approval</span>{" "}
            or change request.
          </>
        )}
      </p>
    </div>
  );
}
