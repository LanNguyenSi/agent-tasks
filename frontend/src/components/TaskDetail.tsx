"use client";

// TaskDetail: orchestration layer for the task detail surface.
//
// Renders in two contexts:
//   variant="modal" (default) — inside a Modal overlay, title carried by
//     the Modal's own <h3>; the TaskHeader component renders only the
//     action row.
//   variant="page" — on /tasks/[id]; TaskHeader renders breadcrumb + H1 +
//     action row; no Modal wrapper.
//
// WORKFLOW GATE: status changes only happen through the gated transition
// buttons (handleAdvance). The status Select has been intentionally removed
// from edit mode to prevent bypassing workflow gate policies via raw PATCH.
// This closes the gate bypass documented in the UI overhaul audit (HIGH).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import {
  updateTask,
  deleteTask,
  claimTask,
  releaseTask,
  startTask,
  createComment,
  deleteComment,
  addDependency,
  removeDependency,
  reviewTask,
  transitionTask,
  adminReleaseClaim,
  ApiRequestError,
  type User,
  type Task,
  type Comment,
  type WorkflowTransition,
} from "../lib/api";
import {
  calculateConfidence,
  TASK_TYPES,
  type TaskType,
  type TemplateFields,
} from "../lib/confidence";
import { parseChecklistProgress } from "../lib/checklist";
import { isHttpUrl, parsePrNumberFromUrl } from "../lib/pr";
import { buildSavedTemplateData } from "../lib/templateData";
import type { TemplateDataEdits } from "../lib/templateData";
import { formatRelativeTime, formatAbsoluteDate } from "../lib/time";
import ConfidenceBadge from "./ConfidenceBadge";
import Markdown from "./Markdown";
import TaskArtifactsSection from "./TaskArtifactsSection";
import TaskAttachmentsSection from "./TaskAttachmentsSection";
import { Button } from "./ui/Button";
import CollapsibleSection from "./ui/CollapsibleSection";
import ConfirmDialog from "./ui/ConfirmDialog";
import FormField from "./ui/FormField";
import InlineConfirmDelete from "./ui/InlineConfirmDelete";
import Modal from "./ui/Modal";
import Select from "@/components/ui/Select";
import { Icon } from "./ui/Icon";
import { KeyHint } from "./ui/KeyHint";
import TaskHeader, { type AdvanceAction, type StatusOverrideResult } from "./task-detail/TaskHeader";
import TaskMetaSidebar from "./task-detail/TaskMetaSidebar";
import ReviewPanel from "./task-detail/ReviewPanel";
import CommentList from "./task-detail/CommentList";

type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

// ── Template field config ──────────────────────────────────────────────────
// One entry per editable templateData key. Drives BOTH view and edit rendering,
// replacing the 9 copy-pasted blocks that existed before.
// agentPrompt uses kind:'text' → rendered as <pre> in view, mono textarea in edit.
// All other markdown fields use kind:'markdown' → rendered with <Markdown>.

type FieldKind = "text" | "markdown";

interface TemplateFieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  rows?: number;
  mono?: boolean;
}

const TEMPLATE_FIELD_DEFS: TemplateFieldDef[] = [
  { key: "goal",               label: "Goal",                kind: "markdown", rows: 2 },
  { key: "acceptanceCriteria", label: "Acceptance Criteria", kind: "markdown", rows: 3 },
  { key: "context",            label: "Context",             kind: "markdown", rows: 2 },
  { key: "constraints",        label: "Constraints",         kind: "markdown", rows: 2 },
  { key: "scope",              label: "Scope",               kind: "markdown", rows: 2 },
  { key: "outOfScope",         label: "Out of Scope",        kind: "markdown", rows: 2 },
  { key: "dependencies",       label: "Dependencies",        kind: "markdown", rows: 2 },
  { key: "risk",               label: "Risk",                kind: "markdown", rows: 2 },
  { key: "agentPrompt",        label: "Agent Prompt",        kind: "text",     rows: 4, mono: true },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function toDateInputValue(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function toIsoDateOrNull(value: string): string | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00`).toISOString();
}

function buildEdits(
  td: Record<string, string>,
  taskType: TaskType | "",
): TemplateDataEdits {
  return {
    goal:               td.goal               ?? "",
    acceptanceCriteria: td.acceptanceCriteria  ?? "",
    context:            td.context             ?? "",
    constraints:        td.constraints         ?? "",
    scope:              td.scope               ?? "",
    outOfScope:         td.outOfScope          ?? "",
    dependencies:       td.dependencies        ?? "",
    risk:               td.risk                ?? "",
    agentPrompt:        td.agentPrompt         ?? "",
    taskType,
  };
}

// ── Component ──────────────────────────────────────────────────────────────

export interface TaskDetailProps {
  task: Task;
  tasks: Task[];
  user: User | null;
  templateFields: TemplateFields | null;
  confidenceThreshold: number;
  requireDistinctReviewer?: boolean;
  /** True for a human who is a team ADMIN or a per-project PROJECT_ADMIN
   * (derived from `project.accessRole`, which — unlike `team?.role` —
   * also covers per-project-only admins). Gates the status-override and
   * admin claim-release controls in TaskHeader / TaskMetaSidebar. Defaults
   * to false so callers that don't thread it (e.g. the dashboard board
   * modal, which currently only has the project *list* projection without
   * `accessRole`) simply don't expose the admin controls, rather than
   * erroring. */
  isProjectAdmin?: boolean;
  /** Effective-workflow edges, used to constrain the admin status-override
   * dropdown to targets the backend will accept (force bypasses `requires`
   * gates, not edge existence). null = not loaded → fall back to base states. */
  workflowTransitions?: WorkflowTransition[] | null;
  /** Open directly in edit mode (e.g. from the create-confidence panel's
   *  "Edit task"), so the user lands on the editors for the missing fields. */
  initialEditing?: boolean;
  onUpdate: (task: Task) => void;
  onDelete: (taskId: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
  /**
   * "modal" (default) renders inside the Modal primitive.
   * "page" renders the bare detail for the full-page /tasks/[id] route.
   */
  variant?: "modal" | "page";
  // Breadcrumb data — supplied by the page context only
  teamName?: string;
  teamId?: string;
  projectName?: string;
  projectId?: string;
}

export default function TaskDetail({
  task,
  tasks,
  user,
  templateFields,
  confidenceThreshold,
  requireDistinctReviewer = false,
  isProjectAdmin = false,
  workflowTransitions = null,
  onUpdate,
  onDelete,
  onClose,
  onError,
  variant = "modal",
  initialEditing = false,
  teamName,
  teamId,
  projectName,
  projectId,
}: TaskDetailProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [deletingTask, setDeletingTask] = useState(false);
  const [showDeleteTaskConfirm, setShowDeleteTaskConfirm] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [advanceBusy, setAdvanceBusy] = useState(false);
  const [adminReleaseBusy, setAdminReleaseBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [reviewComment, setReviewComment] = useState("");
  const [depPickerValue, setDepPickerValue] = useState("");
  const [commentText, setCommentText] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);
  const [resultOverflows, setResultOverflows] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const reviewSectionRef = useRef<HTMLElement>(null);

  // Edit-mode field state (status intentionally excluded — transitions only
  // happen through the gated advance buttons, never via direct status PATCH).
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState<Priority>("MEDIUM");
  const [editDueAt, setEditDueAt] = useState("");
  const [editBranchName, setEditBranchName] = useState("");
  const [editPrUrl, setEditPrUrl] = useState("");
  const [editTaskType, setEditTaskType] = useState<TaskType | "">("");
  // All 9 string templateData fields consolidated into one record.
  const [editTemplateData, setEditTemplateData] = useState<Record<string, string>>({});

  const getField = (key: string): string => editTemplateData[key] ?? "";
  const setField = (key: string, value: string): void =>
    setEditTemplateData((prev) => ({ ...prev, [key]: value }));

  const initEditState = useCallback(() => {
    setEditTitle(task.title);
    setEditDescription(task.description ?? "");
    setEditPriority(task.priority);
    setEditDueAt(toDateInputValue(task.dueAt));
    setEditBranchName(task.branchName ?? "");
    setEditPrUrl(task.prUrl ?? "");
    setEditTaskType(task.templateData?.taskType ?? "");
    const td = task.templateData as Record<string, string | undefined> | null;
    setEditTemplateData({
      goal:               td?.goal               ?? "",
      acceptanceCriteria: td?.acceptanceCriteria  ?? "",
      context:            td?.context             ?? "",
      constraints:        td?.constraints         ?? "",
      scope:              td?.scope               ?? "",
      outOfScope:         td?.outOfScope          ?? "",
      dependencies:       td?.dependencies        ?? "",
      risk:               td?.risk                ?? "",
      agentPrompt:        td?.agentPrompt         ?? "",
    });
  }, [task]);

  // Reset state when switching to a different task (not on every poll refresh).
  useEffect(() => {
    if (initialEditing) {
      initEditState();
      setIsEditing(true);
    } else {
      setIsEditing(false);
    }
    setCommentText("");
    setDepPickerValue("");
    setShowDeleteTaskConfirm(false);
    setResultExpanded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  // Only show the result Show-more toggle when the collapsed box actually overflows.
  useEffect(() => {
    const el = resultRef.current;
    if (!el || resultExpanded) return;
    setResultOverflows(el.scrollHeight > el.clientHeight + 4);
  }, [task.result, task.id, resultExpanded]);

  const submitReview = useCallback(
    async (outcome: "approve" | "request_changes") => {
      setReviewBusy(true);
      try {
        const updated = await reviewTask(task.id, outcome, reviewComment);
        onUpdate(updated);
        setReviewComment("");
      } catch (err) {
        onError((err as Error).message);
      } finally {
        setReviewBusy(false);
      }
    },
    [task.id, reviewComment, onUpdate, onError],
  );

  const handleMarkDone = useCallback(async () => {
    setReviewBusy(true);
    try {
      const updated = await transitionTask(task.id, "done");
      onUpdate(updated);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setReviewBusy(false);
    }
  }, [task.id, onUpdate, onError]);

  const submitComment = useCallback(async () => {
    if (!commentText.trim() || submittingComment) return;
    setSubmittingComment(true);
    try {
      const newComment = await createComment(task.id, commentText.trim());
      onUpdate({ ...task, comments: [...(task.comments ?? []), newComment] });
      setCommentText("");
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSubmittingComment(false);
    }
  }, [commentText, submittingComment, task, onUpdate, onError]);

  const deleteCommentConfirmed = useCallback(
    async (commentId: string) => {
      try {
        await deleteComment(task.id, commentId);
        onUpdate({ ...task, comments: task.comments?.filter((co) => co.id !== commentId) });
      } catch (err) {
        onError((err as Error).message);
      }
    },
    [task, onUpdate, onError],
  );

  const removeDependencyConfirmed = useCallback(
    async (depId: string) => {
      try {
        await removeDependency(task.id, depId);
        onUpdate({ ...task, blockedBy: task.blockedBy?.filter((d) => d.id !== depId) });
      } catch (err) {
        onError((err as Error).message);
      }
    },
    [task, onUpdate, onError],
  );

  const [showDiscardPrompt, setShowDiscardPrompt] = useState(false);

  const isDirty = useMemo(() => {
    if (!isEditing) return false;
    const td = task.templateData as Record<string, string | undefined> | null;
    const templateDataDirty = TEMPLATE_FIELD_DEFS.some(
      ({ key }) => (editTemplateData[key] ?? "") !== (td?.[key] ?? ""),
    );
    return (
      editTitle !== task.title ||
      editDescription !== (task.description ?? "") ||
      editPriority !== task.priority ||
      editDueAt !== toDateInputValue(task.dueAt) ||
      editBranchName !== (task.branchName ?? "") ||
      editPrUrl !== (task.prUrl ?? "") ||
      editTaskType !== (task.templateData?.taskType ?? "") ||
      templateDataDirty
    );
  }, [isEditing, editTitle, editDescription, editPriority, editDueAt, editBranchName, editPrUrl, editTaskType, editTemplateData, task]);

  const editedTemplateData = useMemo(
    () => buildSavedTemplateData(task.templateData, buildEdits(editTemplateData, editTaskType)),
    [task.templateData, editTemplateData, editTaskType],
  );

  // Live confidence score (reflects edit state in edit mode).
  const confidenceScore = useMemo(() => {
    if (!templateFields) return null;
    const conf = calculateConfidence({
      title: isEditing ? editTitle : task.title,
      description: isEditing ? (editDescription || null) : (task.description ?? null),
      templateData: isEditing ? editedTemplateData : task.templateData,
      templateFields,
    });
    return conf.score;
  }, [templateFields, isEditing, editTitle, editDescription, editedTemplateData, task]);

  const startEditing = useCallback(() => {
    initEditState();
    setIsEditing(true);
  }, [initEditState]);

  const cancelEditing = useCallback(() => {
    if (isDirty) {
      setShowDiscardPrompt(true);
    } else {
      setIsEditing(false);
    }
  }, [isDirty]);

  function discardChanges() {
    setShowDiscardPrompt(false);
    setIsEditing(false);
  }

  const handleClose = useCallback(() => {
    if (isEditing && isDirty) {
      setShowDiscardPrompt(true);
    } else {
      onClose();
    }
  }, [isEditing, isDirty, onClose]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (showDiscardPrompt || showDeleteTaskConfirm) return;
      if (e.key === "e" && !isEditing) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        startEditing();
      }
      if (e.key === "Escape") {
        if (isEditing) {
          e.preventDefault();
          cancelEditing();
        } else if (variant === "modal") {
          e.preventDefault();
          handleClose();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isEditing, startEditing, cancelEditing, handleClose, showDiscardPrompt, showDeleteTaskConfirm, variant]);

  async function handleSaveTask() {
    setSavingTask(true);
    try {
      const branchName = editBranchName.trim() || null;
      const prUrl = editPrUrl.trim() || null;
      // prNumber follows prUrl: derive it when the URL changed, clear it when
      // the URL was cleared, and leave it untouched when the URL is unchanged
      // (an agent may have set a number the URL alone does not encode).
      const prUrlChanged = prUrl !== (task.prUrl ?? null);
      const updated = await updateTask(task.id, {
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        priority: editPriority,
        dueAt: toIsoDateOrNull(editDueAt),
        branchName,
        prUrl,
        ...(prUrlChanged
          ? { prNumber: prUrl ? parsePrNumberFromUrl(prUrl) : null }
          : {}),
        templateData: editedTemplateData,
      });
      onUpdate(updated);
      setIsEditing(false);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSavingTask(false);
    }
  }

  async function handleDeleteTask() {
    setDeletingTask(true);
    try {
      await deleteTask(task.id);
      onDelete(task.id);
      onClose();
      setShowDeleteTaskConfirm(false);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setDeletingTask(false);
    }
  }

  async function handleClaim() {
    setClaimBusy(true);
    try {
      const updated = await claimTask(task.id);
      onUpdate(updated);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setClaimBusy(false);
    }
  }

  async function handleRelease() {
    setClaimBusy(true);
    try {
      const updated = await releaseTask(task.id);
      onUpdate(updated);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setClaimBusy(false);
    }
  }

  // Gate-respecting workflow advance.
  async function handleAdvance(action: AdvanceAction) {
    setAdvanceBusy(true);
    try {
      const updated =
        action === "start"
          ? await startTask(task.id)
          : action === "submit_review"
            ? await transitionTask(task.id, "review")
            : await transitionTask(task.id, "done");
      onUpdate(updated);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setAdvanceBusy(false);
    }
  }

  // Admin status override (TaskHeader owns the target/forceReason UI state;
  // this handler owns the actual fetch, mirroring handleAdvance above). On a
  // 422 precondition_failed it returns the failing rules + canForce instead
  // of calling onError, so TaskHeader can render them inline with a retry
  // affordance rather than a dead-end toast. Any other error still goes
  // through onError like every other handler in this file.
  const handleStatusOverride = useCallback(
    async (
      target: string,
      options?: { force?: boolean; forceReason?: string },
    ): Promise<StatusOverrideResult> => {
      try {
        const updated = await transitionTask(task.id, target, options);
        onUpdate(updated);
        return { kind: "success" };
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === "precondition_failed") {
          return {
            kind: "blocked",
            message: err.message,
            failed: err.failed ?? [],
            canForce: err.canForce ?? false,
          };
        }
        // A 400 bad_request means the target is not a defined edge of the
        // effective workflow (force bypasses `requires` preconditions, NOT
        // edge existence). Surface it inline in the same blocked panel with
        // canForce=false instead of a bare toast — so the admin sees WHY the
        // pick did nothing rather than hitting a silent dead end.
        if (err instanceof ApiRequestError && err.code === "bad_request") {
          return {
            kind: "blocked",
            message: err.message,
            failed: [],
            canForce: false,
          };
        }
        onError((err as Error).message);
        return { kind: "error" };
      }
    },
    [task.id, onUpdate, onError],
  );

  // Admin claim release (work and/or review claim, held by anyone).
  const handleAdminRelease = useCallback(
    async (opts: { releaseWorkClaim?: boolean; releaseReviewClaim?: boolean }): Promise<boolean> => {
      setAdminReleaseBusy(true);
      try {
        const { task: updated } = await adminReleaseClaim(task.id, opts);
        onUpdate(updated);
        return true;
      } catch (err) {
        onError((err as Error).message);
        return false;
      } finally {
        setAdminReleaseBusy(false);
      }
    },
    [task.id, onUpdate, onError],
  );

  const webhookEvents = (task.comments ?? []).filter((c: Comment) =>
    c.content.startsWith("[webhook]"),
  );
  const userComments = (task.comments ?? []).filter(
    (c: Comment) => !c.content.startsWith("[webhook]"),
  );

  const resultClamped = !resultExpanded;
  const showResultToggle = resultOverflows || resultExpanded;

  // ── Edit mode footer ───────────────────────────────────────────────────────
  const editFooter = isEditing ? (
    <div className="td-edit-footer">
      <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={savingTask}>
        Cancel
      </Button>
      <Button onClick={() => void handleSaveTask()} disabled={savingTask} loading={savingTask} size="sm">
        {savingTask ? "Saving…" : "Save"}
      </Button>
    </div>
  ) : null;

  // ── Header component ───────────────────────────────────────────────────────
  const header = (
    <TaskHeader
      task={task}
      user={user}
      variant={variant}
      teamName={teamName}
      teamId={teamId}
      projectName={projectName}
      projectId={projectId}
      isEditing={isEditing}
      advanceBusy={advanceBusy}
      onStartEditing={startEditing}
      onAdvance={(action) => void handleAdvance(action)}
      onDeleteRequest={() => setShowDeleteTaskConfirm(true)}
      onScrollToReview={() =>
        reviewSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
      }
      isProjectAdmin={isProjectAdmin}
      statusOverrideTargets={
        workflowTransitions
          ? workflowTransitions
              .filter((t) => t.from === task.status)
              .map((t) => t.to)
          : null
      }
      onOverrideStatus={handleStatusOverride}
    />
  );

  // ── Main column ────────────────────────────────────────────────────────────
  const mainColumn = (
    <div className="td-main">

      {/* ── Description ─────────────────────────────────────── */}
      <section className="td-section">
        {isEditing ? (
          <>
            <p className="section-kicker">Overview</p>
            <div className="td-field-row">
              <FormField label="Title">
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="td-form-input"
                />
              </FormField>
            </div>
            <FormField label="Description">
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={5}
                className="td-form-textarea"
              />
            </FormField>
          </>
        ) : (
          <>
            <div className="td-section-head">
              <h2 className="td-section-title">
                Description
                {task.description && (() => {
                  const p = parseChecklistProgress(task.description);
                  if (!p) return null;
                  return (
                    <span
                      className="td-checklist-progress num"
                      title={`Checklist in description: ${p.checked} of ${p.total} items checked`}
                    >
                      <Icon name="check" size={12} aria-hidden="true" />
                      <span className="td-checklist-bar">
                        {/* dynamic: progress bar width = percentage */}
                        <span
                          className="td-checklist-bar-fill"
                          // eslint-disable-next-line no-restricted-syntax
                          style={{ width: `${Math.round((p.checked / p.total) * 100)}%` }}
                        />
                      </span>
                      <span className="sr-only">checklist </span>
                      {p.checked} of {p.total} checked
                    </span>
                  );
                })()}
              </h2>
            </div>
            {task.description ? (
              <Markdown>{task.description}</Markdown>
            ) : (
              <p className="td-empty-desc">No description</p>
            )}
          </>
        )}
      </section>

      {/* ── Workflow (edit mode: priority + due date) ─── */}
      {isEditing && (
        <section className="td-section">
          <p className="section-kicker">Workflow</p>
          <div className="td-field-row">
            <FormField label="Priority">
              <Select
                value={editPriority}
                onChange={(v) => setEditPriority(v as Priority)}
                options={[
                  { value: "LOW",      label: "LOW" },
                  { value: "MEDIUM",   label: "MEDIUM" },
                  { value: "HIGH",     label: "HIGH" },
                  { value: "CRITICAL", label: "CRITICAL" },
                ]}
                className="td-form-input"
              />
            </FormField>
          </div>
          <div className="td-field-row">
            <FormField label="Due Date">
              <input
                type="date"
                value={editDueAt}
                onChange={(e) => setEditDueAt(e.target.value)}
                className="td-form-input"
              />
            </FormField>
          </div>
          <div className="td-field-row">
            <FormField label="Branch">
              <input
                value={editBranchName}
                onChange={(e) => setEditBranchName(e.target.value)}
                className="td-form-input"
                placeholder="feature/my-branch"
              />
            </FormField>
          </div>
          <FormField
            label="PR URL"
            hint="GitHub pull-request URL; the PR number is derived automatically."
          >
            <input
              type="url"
              value={editPrUrl}
              onChange={(e) => setEditPrUrl(e.target.value)}
              className="td-form-input"
              placeholder="https://github.com/owner/repo/pull/123"
            />
          </FormField>
        </section>
      )}

      {/* ── Agent Template ───────────────────────────────── */}
      {templateFields && (
        <section className="td-section">
          <div className="td-section-head">
            <h2 className="td-section-title">Agent Template</h2>
          </div>
          {(() => {
            const conf = calculateConfidence({
              title: isEditing ? editTitle : task.title,
              description: isEditing ? editDescription || null : task.description ?? null,
              templateData: isEditing ? editedTemplateData : task.templateData,
              templateFields,
            });
            return (
              <div className="td-conf-section">
                <div className="td-conf-badge-row">
                  <ConfidenceBadge score={conf.score} size="md" />
                  {conf.score < confidenceThreshold && (
                    <span className="td-conf-threshold-warn">
                      Below threshold ({confidenceThreshold}) — agents cannot claim this task
                    </span>
                  )}
                </div>
                {conf.missing.length > 0 && (
                  <p className="td-conf-missing">
                    Missing: {conf.missing.join(", ")}
                  </p>
                )}
              </div>
            );
          })()}

          {isEditing ? (
            <>
              {TEMPLATE_FIELD_DEFS.map(({ key, label, rows, mono }) => {
                if (!templateFields[key as keyof TemplateFields]) return null;
                return (
                  <div key={key} className="td-field-row">
                    <FormField label={label}>
                      <textarea
                        value={getField(key)}
                        onChange={(e) => setField(key, e.target.value)}
                        rows={rows ?? 2}
                        className={["td-form-textarea", mono ? "td-form-textarea--mono" : ""].filter(Boolean).join(" ")}
                      />
                    </FormField>
                  </div>
                );
              })}
              <div className="td-field-row">
                <FormField label="Task Type">
                  <Select
                    value={editTaskType}
                    onChange={(v) => setEditTaskType(v as TaskType | "")}
                    options={[
                      { value: "", label: "— none —" },
                      ...TASK_TYPES.map((t) => ({ value: t, label: t })),
                    ]}
                    ariaLabel="Task type"
                    className="td-form-input"
                  />
                </FormField>
              </div>
            </>
          ) : (
            <div className="td-template-fields-view">
              {TEMPLATE_FIELD_DEFS.map(({ key, label, kind }) => {
                if (!templateFields[key as keyof TemplateFields]) return null;
                const value = (task.templateData as Record<string, string | undefined> | null)?.[key];
                if (!value) return null;
                return (
                  <div key={key}>
                    <span className="td-template-field-kicker">{label}</span>
                    {kind === "text" ? (
                      <pre className="td-template-field-pre">{value}</pre>
                    ) : (
                      <Markdown className="td-template-field-prose">{value}</Markdown>
                    )}
                  </div>
                );
              })}
              {task.templateData?.taskType && (
                <div>
                  <span className="td-template-field-kicker">Task Type</span>
                  <div className="td-template-field-text">{task.templateData.taskType}</div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── Dependencies ──────────────────────────────────── */}
      {isEditing ? (
        <section className="td-section">
          <p className="section-kicker">Dependencies</p>
          {(task.blockedBy?.length ?? 0) === 0 && (task.blocks?.length ?? 0) === 0 ? (
            <p className="td-dep-empty">No dependencies.</p>
          ) : (
            <div className="td-dep-edit-list">
              {task.blockedBy?.map((dep) => (
                <div key={dep.id} className="td-dep-edit-row">
                  <span className="td-dep-edit-row-left">
                    <span className={["td-dep-status-dot", dep.status === "done" ? "td-dep-status-dot--done" : "td-dep-status-dot--blocked"].join(" ")} />
                    <span>{dep.title}</span>
                    <span className="td-dep-status">({dep.status})</span>
                  </span>
                  <InlineConfirmDelete
                    label="Remove"
                    onConfirm={() => void removeDependencyConfirmed(dep.id)}
                  />
                </div>
              ))}
              {task.blocks?.map((dep) => (
                <div key={dep.id} className="td-dep-blocks-line">
                  blocks: {dep.title} ({dep.status})
                </div>
              ))}
            </div>
          )}
          <div className="td-dep-picker-row">
            <Select
              value={depPickerValue}
              onChange={(v) => setDepPickerValue(v)}
              options={[
                { value: "", label: "Add blocker..." },
                ...tasks
                  .filter(
                    (t) =>
                      t.id !== task.id &&
                      t.projectId === task.projectId &&
                      !task.blockedBy?.some((d) => d.id === t.id),
                  )
                  .map((t) => ({ value: t.id, label: t.title })),
              ]}
              className="td-dep-picker-select"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!depPickerValue}
              onClick={async () => {
                if (!depPickerValue) return;
                try {
                  await addDependency(task.id, depPickerValue);
                  const blockerTask = tasks.find((t) => t.id === depPickerValue);
                  if (blockerTask) {
                    onUpdate({
                      ...task,
                      blockedBy: [
                        ...(task.blockedBy ?? []),
                        { id: blockerTask.id, title: blockerTask.title, status: blockerTask.status },
                      ],
                    });
                  }
                  setDepPickerValue("");
                } catch (err) {
                  onError((err as Error).message);
                }
              }}
            >
              Add
            </Button>
          </div>
        </section>
      ) : (task.blockedBy?.length ?? 0) > 0 || (task.blocks?.length ?? 0) > 0 ? (
        <CollapsibleSection
          key={task.id}
          title="Dependencies"
          count={(task.blockedBy?.length ?? 0) + (task.blocks?.length ?? 0)}
        >
          <div className="td-dep-view-list">
            {task.blockedBy?.map((dep) => (
              <div key={dep.id} className="td-dep-view-row">
                <span className={["td-dep-status-dot", dep.status === "done" ? "td-dep-status-dot--done" : "td-dep-status-dot--blocked"].join(" ")} />
                <span>{dep.title}</span>
                <span className="td-dep-status">({dep.status})</span>
              </div>
            ))}
            {task.blocks?.map((dep) => (
              <div key={dep.id} className="td-dep-view-blocks">
                blocks: {dep.title} ({dep.status})
              </div>
            ))}
          </div>
        </CollapsibleSection>
      ) : null}

      {/* ── Agent Output (branch / PR / result) ─────────────── */}
      {(task.branchName || task.prUrl || task.result) && (
        <section className="td-section">
          <div className="td-section-head">
            <h2 className="td-section-title">Agent Output</h2>
          </div>
          <div className="td-output-list">
            {task.branchName && (
              <div className="td-output-row">
                <span className="td-output-label">Branch</span>
                <code className="td-output-code">{task.branchName}</code>
              </div>
            )}
            {task.prUrl && (
              <div className="td-output-row">
                <span className="td-output-label">PR</span>
                {isHttpUrl(task.prUrl) ? (
                  <a
                    href={task.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {task.prNumber ? `#${task.prNumber}` : "Open PR"}
                  </a>
                ) : (
                  <span>{task.prNumber ? `#${task.prNumber}` : "PR"}</span>
                )}
              </div>
            )}
            {task.result && (
              <div>
                <span className="td-output-label td-output-label-block">Result</span>
                <div
                  ref={resultRef}
                  className={[
                    "prose-markdown td-result-section",
                    resultClamped ? "td-result--clamped" : "",
                    resultClamped && resultOverflows ? "td-result--masked" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <ReactMarkdown>{task.result}</ReactMarkdown>
                </div>
                {showResultToggle && (
                  <button
                    type="button"
                    className="td-result-toggle"
                    onClick={() => setResultExpanded((v) => !v)}
                  >
                    {resultExpanded ? "Show less" : "Show more"}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Review panel ─────────────────────────────────────── */}
      {task.status === "review" && (
        <section className="td-section">
          <ReviewPanel
            task={task}
            user={user}
            requireDistinctReviewer={requireDistinctReviewer}
            reviewComment={reviewComment}
            onReviewCommentChange={setReviewComment}
            reviewBusy={reviewBusy}
            onSubmitReview={(outcome) => void submitReview(outcome)}
            onMarkDone={() => void handleMarkDone()}
            reviewSectionRef={reviewSectionRef}
          />
        </section>
      )}

      {/* ── Attachments ──────────────────────────────────────── */}
      <section className="td-section">
        <TaskAttachmentsSection
          taskId={task.id}
          initial={task.attachments}
          user={user}
          onError={onError}
        />
      </section>

      {/* ── Artifacts ────────────────────────────────────────── */}
      <section className="td-section">
        <TaskArtifactsSection
          taskId={task.id}
          initial={task.artifacts}
          user={user}
          onError={onError}
        />
      </section>

      {/* ── Activity (webhook events) ─────────────────────────── */}
      {webhookEvents.length > 0 && (
        <section className="td-section">
          <CollapsibleSection key={task.id} title="Activity" count={webhookEvents.length}>
            <div className="td-activity-list">
              {webhookEvents.map((event: Comment) => {
                const message = event.content.replace(/^\[webhook]\s*/, "");
                const isTransition =
                  message.includes("merged") ||
                  message.includes("in_progress") ||
                  message.includes("→");
                const isReview =
                  message.includes("approved") ||
                  message.includes("Changes requested") ||
                  message.includes("dismissed");
                const eventKind = isTransition
                  ? "transition"
                  : isReview
                    ? "review"
                    : "default";
                const eventLabel = isTransition
                  ? "Transition event"
                  : isReview
                    ? "Review event"
                    : "Activity event";
                return (
                  <div key={event.id} className="td-activity-item">
                    <span
                      aria-label={eventLabel}
                      className={[
                        "td-activity-dot",
                        eventKind !== "default" ? `td-activity-dot--${eventKind}` : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    />
                    <span className="td-activity-message">{message}</span>
                    <span
                      title={formatAbsoluteDate(event.createdAt)}
                      className="td-activity-time"
                    >
                      {formatRelativeTime(event.createdAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          </CollapsibleSection>
        </section>
      )}

      {/* ── Comments ─────────────────────────────────────────── */}
      <section className="td-section">
        <div className="td-section-head">
          <h2 className="td-section-title">Comments</h2>
          {userComments.length > 0 && (
            <span className="td-section-count num">{userComments.length}</span>
          )}
        </div>
        <CommentList
          comments={userComments}
          user={user}
          onConfirmDelete={(id) => void deleteCommentConfirmed(id)}
        />
        {/* Composer */}
        <div className="td-composer">
          <textarea
            className="td-composer-input"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submitComment();
              }
            }}
            aria-label="Write a comment"
            placeholder="Leave a comment… markdown supported"
          />
          <div className="td-composer-foot">
            <span className="td-composer-hint">
              <KeyHint>⌘</KeyHint> <KeyHint>↵</KeyHint> to post
            </span>
            <span className="td-composer-spacer" />
            <Button
              size="sm"
              disabled={!commentText.trim() || submittingComment}
              loading={submittingComment}
              onClick={() => void submitComment()}
            >
              Comment
            </Button>
          </div>
        </div>
      </section>

    </div>
  );

  // ── Sidebar ────────────────────────────────────────────────────────────────
  const sidebar = (
    <aside className="td-sidebar" aria-label="Task properties">
      <TaskMetaSidebar
        task={task}
        user={user}
        confidenceScore={confidenceScore}
        onClaim={() => void handleClaim()}
        onRelease={() => void handleRelease()}
        claimBusy={claimBusy}
        isProjectAdmin={isProjectAdmin}
        onAdminRelease={handleAdminRelease}
        adminReleaseBusy={adminReleaseBusy}
      />
    </aside>
  );

  // ── Layout ────────────────────────────────────────────────────────────────
  const layout = (
    <div className="td-layout">
      {mainColumn}
      {sidebar}
    </div>
  );

  return (
    <>
      {variant === "page" ? (
        <div className="td-page">
          {header}
          {layout}
          {editFooter && (
            <div className="task-detail-page-actions">{editFooter}</div>
          )}
        </div>
      ) : (
        <Modal
          open
          onClose={handleClose}
          closeOnEscape={false}
          title={task.title}
          actions={editFooter}
          headerActions={
            !isEditing ? (
              <Link
                href={`/tasks/${task.id}`}
                className="modal-maximize"
                aria-label="Open as full page"
                title="Open as full page"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              </Link>
            ) : undefined
          }
        >
          {header}
          {layout}
        </Modal>
      )}

      <ConfirmDialog
        open={showDiscardPrompt}
        title="Discard changes?"
        message="You have unsaved changes. Do you want to discard them?"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        tone="danger"
        onConfirm={discardChanges}
        onCancel={() => setShowDiscardPrompt(false)}
      />

      <ConfirmDialog
        open={showDeleteTaskConfirm}
        title="Delete task?"
        message={`Task "${task.title}" will be permanently removed.`}
        confirmLabel="Delete task"
        cancelLabel="Keep task"
        tone="danger"
        busy={deletingTask}
        onConfirm={() => void handleDeleteTask()}
        onCancel={() => {
          if (deletingTask) return;
          setShowDeleteTaskConfirm(false);
        }}
      />
    </>
  );
}
