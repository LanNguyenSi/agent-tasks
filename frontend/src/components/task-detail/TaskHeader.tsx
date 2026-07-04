"use client";

// Task detail header: breadcrumb (page context) + H1 title (page context) +
// action row (StatusChip · gated transition button · Edit · overflow menu).
//
// In the MODAL context the modal's own <h3> carries the task title, so this
// component only renders the action row (variant="modal").
// In the PAGE context the full breadcrumb + H1 + action row render.

import { useRef, useState } from "react";
import Link from "next/link";
import type { Task, User, TransitionRuleFailure } from "@/lib/api";
import { normalizeStatus } from "@/lib/status";
import { StatusChip } from "@/components/ui/StatusChip";
import { Icon } from "@/components/ui/Icon";
import DropdownMenu from "@/components/ui/DropdownMenu";
import Select from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import FormField from "@/components/ui/FormField";

export type AdvanceAction = "start" | "submit_review" | "mark_done";

/** Result of an admin status-override attempt, returned by the
 * `onOverrideStatus` handler (implemented in TaskDetail.tsx, which owns the
 * actual `transitionTask` call). `"blocked"` carries the 422
 * `precondition_failed` body so this component can render the failing
 * rules and, when `canForce` is true, the forceReason retry form.
 * `"error"` means a non-precondition error was already surfaced via
 * `onError` upstream; this component has nothing further to render. */
export type StatusOverrideResult =
  | { kind: "success" }
  | { kind: "blocked"; message: string; failed: TransitionRuleFailure[]; canForce: boolean }
  | { kind: "error" };

// Fallback state list used when the caller hasn't threaded the project's
// effective workflow states through to the task detail surface. Covers the
// built-in default workflow; a follow-up could fetch getEffectiveWorkflow()
// here to offer the project's actual custom states instead of these four.
const BASE_STATES = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In Progress" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
];

const MIN_FORCE_REASON_LENGTH = 10;

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
  /** True for a human who is a team ADMIN or a per-project PROJECT_ADMIN.
   * Gates the admin status-override control below; false renders it
   * disabled with an inline reason (never hidden). */
  isProjectAdmin: boolean;
  /** Attempts `transitionTask(task.id, target, options)`. Implemented in
   * TaskDetail.tsx so the actual fetch + task refresh stays alongside the
   * other status-mutating handlers (handleAdvance, handleClaim, ...). */
  onOverrideStatus: (
    target: string,
    options?: { force?: boolean; forceReason?: string },
  ) => Promise<StatusOverrideResult>;
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
  isProjectAdmin,
  onOverrideStatus,
}: TaskHeaderProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLButtonElement>(null);

  // ── Admin status override ─────────────────────────────────────────────
  const [overrideTarget, setOverrideTarget] = useState("");
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [blocked, setBlocked] = useState<
    { target: string; message: string; failed: TransitionRuleFailure[]; canForce: boolean } | null
  >(null);
  const [showForceForm, setShowForceForm] = useState(false);
  const [forceReason, setForceReason] = useState("");

  const statusOptions = BASE_STATES.filter((s) => s.value !== task.status);

  async function submitOverride(target: string, options?: { force?: boolean; forceReason?: string }) {
    setOverrideBusy(true);
    try {
      const result = await onOverrideStatus(target, options);
      if (result.kind === "success") {
        setBlocked(null);
        setShowForceForm(false);
        setForceReason("");
        setOverrideTarget("");
      } else if (result.kind === "blocked") {
        setBlocked({ target, message: result.message, failed: result.failed, canForce: result.canForce });
      }
      // "error": already surfaced via onError upstream; nothing to do here.
    } finally {
      setOverrideBusy(false);
    }
  }

  function cancelForceForm() {
    setShowForceForm(false);
    setForceReason("");
    setBlocked(null);
  }

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
      // Distinguish "nothing recorded yet" from "URL saved but no PR number
      // derived" (non-canonical URL), so the hint stays actionable.
      const gateHint = hasWorkArtifacts
        ? undefined
        : task.prUrl && task.prNumber == null
          ? "PR URL must be the canonical github.com/owner/repo/pull/N form, re-save it via Edit"
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

      {/* Admin status override: visible to every human, disabled with a
          reason for non-admins — surfacing the boundary is the point, not
          hiding it. Never rendered mid-edit (mirrors the other controls above). */}
      {!isEditing && (
        <div className="td-admin-row">
          <span className="td-admin-row-kicker">Admin</span>
          {isProjectAdmin ? (
            <>
              <Select
                value={overrideTarget}
                onChange={setOverrideTarget}
                options={statusOptions}
                placeholder="Change status to…"
                ariaLabel="Change task status (admin override)"
                className="td-admin-select"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={!overrideTarget || overrideBusy}
                loading={overrideBusy}
                onClick={() => void submitOverride(overrideTarget)}
              >
                Set status
              </Button>
            </>
          ) : (
            <button
              type="button"
              className="td-btn-transition"
              disabled
              title="Only project admins can override task status"
            >
              Change status
            </button>
          )}
          {!isProjectAdmin && (
            <span className="td-transition-hint">
              Only project admins can override task status
            </span>
          )}

          {blocked && (
            <div className="td-admin-blocked">
              <p className="td-admin-blocked-message">{blocked.message}</p>
              {blocked.failed.length > 0 && (
                <ul className="td-admin-blocked-list">
                  {blocked.failed.map((f) => (
                    <li key={f.rule}>
                      {f.message}
                      {f.error ? ` (${f.error})` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {!blocked.canForce ? (
                <span className="td-transition-hint">This transition cannot be forced.</span>
              ) : !showForceForm ? (
                <Button
                  size="sm"
                  variant="outline-danger"
                  onClick={() => setShowForceForm(true)}
                >
                  Override anyway…
                </Button>
              ) : (
                <div className="td-force-form">
                  <FormField
                    label="Reason for override"
                    hint={`Required, at least ${MIN_FORCE_REASON_LENGTH} characters. This is audited as task.transitioned.forced.`}
                  >
                    <textarea
                      value={forceReason}
                      onChange={(e) => setForceReason(e.target.value)}
                      rows={2}
                      className="td-form-textarea"
                    />
                  </FormField>
                  <div className="td-force-form-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={cancelForceForm}
                      disabled={overrideBusy}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={forceReason.trim().length < MIN_FORCE_REASON_LENGTH || overrideBusy}
                      loading={overrideBusy}
                      onClick={() =>
                        void submitOverride(blocked.target, {
                          force: true,
                          forceReason: forceReason.trim(),
                        })
                      }
                    >
                      Confirm override
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
