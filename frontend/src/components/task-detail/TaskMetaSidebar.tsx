// Properties sidebar for the task detail two-column layout.
// Shows: status chip, priority, assignee (with claim/release), labels,
// branch chip, due date, created date, confidence bar (if templateFields exist).
// Below a divider: next-workflow-step note.
//
// Confidence score is passed pre-calculated by the parent (TaskDetail) so it
// reflects the live editing state without this component importing calculateConfidence.

import { useState } from "react";
import type { Task, User } from "@/lib/api";
import { normalizeStatus } from "@/lib/status";
import { StatusChip } from "@/components/ui/StatusChip";
import { PriorityLabel } from "@/components/ui/PriorityLabel";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { formatAbsoluteDate, formatDueDate } from "@/lib/time";
import { isHttpUrl } from "@/lib/pr";

type AdminReleaseKind = "work" | "review";

interface TaskMetaSidebarProps {
  task: Task;
  user: User | null;
  confidenceScore: number | null;
  onClaim: () => void;
  onRelease: () => void;
  claimBusy: boolean;
  /** True for a human who is a team ADMIN or a per-project PROJECT_ADMIN.
   * Gates the admin claim-release controls below (see TaskHeader's
   * isProjectAdmin doc for the same derivation). */
  isProjectAdmin: boolean;
  /** Force-releases a claim held by anyone via `adminReleaseClaim`
   * (implemented in TaskDetail.tsx). Resolves `true` on success so this
   * component knows whether to close the confirm dialog. */
  onAdminRelease: (opts: { releaseWorkClaim?: boolean; releaseReviewClaim?: boolean }) => Promise<boolean>;
  adminReleaseBusy: boolean;
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

function getReviewerLabel(task: Task): string {
  if (!task.reviewClaimedByUserId && !task.reviewClaimedByAgentId) return "Unassigned";
  if (task.reviewClaimedByUser) return task.reviewClaimedByUser.name ?? task.reviewClaimedByUser.login;
  if (task.reviewClaimedByAgent) return `Agent ${task.reviewClaimedByAgent.name}`;
  // The backend task-fetch include now resolves reviewClaimedByUser/Agent
  // (symmetric with the work claim), so the branches above normally win.
  // This truncated-id fallback is defensive, for a response that predates the
  // include or omits it — still names *something* in the release confirm.
  if (task.reviewClaimedByUserId) return `User ${task.reviewClaimedByUserId.slice(0, 8)}…`;
  if (task.reviewClaimedByAgentId) return `Agent ${task.reviewClaimedByAgentId.slice(0, 8)}…`;
  return "Assigned";
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
  isProjectAdmin,
  onAdminRelease,
  adminReleaseBusy,
}: TaskMetaSidebarProps) {
  const overdue = isOverdue(task);
  const assigned = Boolean(task.claimedByUserId || task.claimedByAgentId);
  const isOwnTask = task.claimedByUserId === user?.id;
  const canClaim = !assigned && task.status !== "open";
  const nextStep = NEXT_STEP[task.status] ?? "in an unknown state";
  const hasReviewClaim = Boolean(task.reviewClaimedByUserId || task.reviewClaimedByAgentId);

  // Admin release: which confirm dialog (if any) is open. Self-service
  // release (above) already covers "the claimant releases their own work
  // claim", so the admin control here is scoped to claims held by someone
  // else (or an agent, which has no self-service release affordance at all)
  // — the case the self-service Release button can't reach.
  const [adminReleaseConfirm, setAdminReleaseConfirm] = useState<AdminReleaseKind | null>(null);

  async function confirmAdminRelease() {
    if (!adminReleaseConfirm) return;
    const ok = await onAdminRelease(
      adminReleaseConfirm === "review" ? { releaseReviewClaim: true } : { releaseWorkClaim: true },
    );
    if (ok) setAdminReleaseConfirm(null);
  }

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
                {/* Admin escape hatch: releases a claim the claimant can't
                    (someone else's, or an agent's — self-service Release
                    above only ever covers the current human's own claim).
                    Shown DISABLED with a reason to non-admins rather than
                    hidden, so the boundary is visible, not a dead end. */}
                {!isOwnTask && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAdminReleaseConfirm("work")}
                    disabled={!isProjectAdmin || adminReleaseBusy}
                    title={
                      isProjectAdmin
                        ? "Release this claim as a project admin"
                        : "Only project admins can release another actor's claim"
                    }
                  >
                    Release (admin)
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

        {/* Reviewer (review claim) + admin release */}
        {hasReviewClaim && (
          <>
            <span className="td-prop-label">Reviewer</span>
            <span className="td-prop-value">
              <span className="td-assignee-row">
                <span>{getReviewerLabel(task)}</span>
                {/* Disabled-with-reason for non-admins, mirroring the work
                    claim + status-override controls (never hidden). */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAdminReleaseConfirm("review")}
                  disabled={!isProjectAdmin || adminReleaseBusy}
                  title={
                    isProjectAdmin
                      ? "Release this review claim as a project admin"
                      : "Only project admins can release another actor's claim"
                  }
                >
                  Release
                </Button>
              </span>
            </span>
          </>
        )}

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
              {isHttpUrl(task.prUrl) ? (
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
              ) : (
                <span className="td-branch-chip">
                  <Icon name="pr" size={11} aria-hidden />
                  {task.prNumber ? `#${task.prNumber}` : "PR"}
                </span>
              )}
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

      <ConfirmDialog
        open={adminReleaseConfirm !== null}
        title={adminReleaseConfirm === "review" ? "Release review claim?" : "Release claim?"}
        message={
          adminReleaseConfirm === "review"
            ? `${getReviewerLabel(task)} currently holds the review claim on this task. Releasing it may interrupt an in-progress review.`
            : `${getAssigneeLabel(task)} currently holds the work claim on this task. Releasing it may interrupt work in progress.`
        }
        confirmLabel="Release"
        cancelLabel="Cancel"
        tone="danger"
        busy={adminReleaseBusy}
        onConfirm={() => void confirmAdminRelease()}
        onCancel={() => {
          if (!adminReleaseBusy) setAdminReleaseConfirm(null);
        }}
      />
    </div>
  );
}
