"use client";

// Task detail header: breadcrumb (page context) + H1 title (page context) +
// action row (StatusChip · gated transition button · Edit · overflow menu).
//
// In the MODAL context the modal's own <h3> carries the task title, so this
// component only renders the action row (variant="modal").
// In the PAGE context the full breadcrumb + H1 + action row render.

import { useRef, useState } from "react";
import Link from "next/link";
import type { Task, User } from "@/lib/api";
import { normalizeStatus } from "@/lib/status";
import { StatusChip } from "@/components/ui/StatusChip";
import { Icon } from "@/components/ui/Icon";
import DropdownMenu from "@/components/ui/DropdownMenu";

export type AdvanceAction = "start" | "submit_review" | "mark_done";

interface TaskHeaderProps {
  task: Task;
  user: User | null;
  variant: "modal" | "page";
  /** Team display name (page context only) */
  teamName?: string;
  /** Team id — used to build breadcrumb link */
  teamId?: string;
  /** Project display name (page context only) */
  projectName?: string;
  /** Project id — used to build breadcrumb link */
  projectId?: string;
  isEditing: boolean;
  advanceBusy: boolean;
  onStartEditing: () => void;
  onAdvance: (action: AdvanceAction) => void;
  /** Opens the delete task confirm dialog */
  onDeleteRequest: () => void;
  /** Scrolls to the review panel section */
  onScrollToReview: () => void;
}

export default function TaskHeader({
  task,
  user,
  variant,
  teamName,
  teamId,
  projectName,
  projectId,
  isEditing,
  advanceBusy,
  onStartEditing,
  onAdvance,
  onDeleteRequest,
  onScrollToReview,
}: TaskHeaderProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLButtonElement>(null);

  // Mirrors the backend branchPresent + prPresent gates exactly: prPresent
  // requires the PR number too (the edit form derives it from the PR URL).
  const hasWorkArtifacts = Boolean(
    task.branchName && task.prUrl && task.prNumber != null,
  );

  // The gated-workflow transitions allowed from the current state. The
  // default workflow allows BOTH review and done from in_progress; the
  // sidebar's Release covers the third edge (back to open, claim cleared).
  interface TransitionDef {
    action: AdvanceAction;
    label: string;
    disabled: boolean;
    hint: string | undefined;
  }
  const transitions: TransitionDef[] = [];
  if (!isEditing) {
    if (
      task.status === "open" &&
      !task.claimedByUserId &&
      !task.claimedByAgentId
    ) {
      transitions.push({
        action: "start",
        label: "Start",
        disabled: false,
        hint: undefined,
      });
    } else if (
      task.status === "in_progress" &&
      task.claimedByUserId === user?.id
    ) {
      const gateHint = hasWorkArtifacts
        ? undefined
        : "Record branch and PR URL via Edit first";
      transitions.push({
        action: "submit_review",
        label: "Move to Review",
        disabled: !hasWorkArtifacts,
        hint: gateHint,
      });
      transitions.push({
        action: "mark_done",
        label: "Mark done",
        disabled: !hasWorkArtifacts,
        hint: gateHint,
      });
    }
  }
  const transitionHint = transitions.find((t) => t.hint)?.hint;

  const boardHref =
    teamId && projectId
      ? `/dashboard?teamId=${teamId}&projectId=${projectId}`
      : teamId
        ? `/dashboard?teamId=${teamId}`
        : "/dashboard";

  return (
    <div>
      {/* Breadcrumb: page context only, rendered when project data is supplied */}
      {variant === "page" && teamId && (
        <nav className="td-breadcrumb" aria-label="Breadcrumb">
          {teamName && (
            <>
              <Link href={`/dashboard?teamId=${teamId}`}>{teamName}</Link>
              <span className="td-breadcrumb-sep" aria-hidden="true">
                /
              </span>
            </>
          )}
          {projectName && projectId && (
            <>
              <Link href={boardHref}>{projectName}</Link>
              <span className="td-breadcrumb-sep" aria-hidden="true">
                /
              </span>
            </>
          )}
          <span>Task</span>
        </nav>
      )}

      {/* Task title H1: page context only (modal uses its own h3 slot) */}
      {variant === "page" && !isEditing && (
        <h1 className="td-title">{task.title}</h1>
      )}

      {/* Action row: always rendered (view mode and edit mode) */}
      <div className="td-head-row">
        <StatusChip status={normalizeStatus(task.status)} />

        {/* Gated transition buttons (view mode only) */}
        {!isEditing && transitions.length > 0 && (
          <>
            {transitions.map((t) => (
              <button
                key={t.action}
                type="button"
                className="td-btn-transition"
                onClick={() => void onAdvance(t.action)}
                disabled={advanceBusy || t.disabled}
                title={t.hint}
                aria-busy={advanceBusy || undefined}
              >
                <Icon name="arrow-right" size={13} aria-hidden />
                {t.label}
              </button>
            ))}
            {transitionHint && (
              <span className="td-transition-hint">{transitionHint}</span>
            )}
          </>
        )}

        {/* Review state: scroll affordance (view mode only) */}
        {!isEditing && task.status === "review" && (
          <button
            type="button"
            className="td-btn-transition"
            onClick={onScrollToReview}
          >
            <Icon name="arrow-right" size={13} aria-hidden />
            Jump to review
          </button>
        )}

        {/* Right-aligned: Edit + overflow menu (view mode) */}
        {!isEditing && (
          <div className="td-head-right">
            <button
              type="button"
              className="td-btn-edit"
              onClick={onStartEditing}
              aria-label="Edit"
            >
              <Icon name="edit" size={13} aria-hidden />
              Edit
            </button>

            <button
              ref={overflowRef}
              type="button"
              className="td-btn-icon"
              aria-label="More actions"
              aria-expanded={overflowOpen}
              onClick={() => setOverflowOpen((v) => !v)}
            >
              <Icon name="dots" size={14} aria-hidden />
            </button>

            <DropdownMenu
              anchorRef={overflowRef}
              open={overflowOpen}
              onClose={() => setOverflowOpen(false)}
              align="end"
            >
              <button
                type="button"
                className="app-dropdown-item app-dropdown-item-danger"
                onClick={() => {
                  setOverflowOpen(false);
                  onDeleteRequest();
                }}
              >
                Delete task
              </button>
            </DropdownMenu>
          </div>
        )}
      </div>
    </div>
  );
}
