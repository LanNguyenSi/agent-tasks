"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { PRIORITY_COLORS } from "../lib/priorityColors";
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
  type User,
  type Task,
  type Comment,
  type TaskType,
  type TemplateData,
} from "../lib/api";
import { calculateConfidence } from "../lib/confidence";
import { formatRelativeTime, formatAbsoluteDate, formatDueDate } from "../lib/time";
import ConfidenceBadge from "./ConfidenceBadge";
import TaskArtifactsSection from "./TaskArtifactsSection";
import TaskAttachmentsSection from "./TaskAttachmentsSection";
import { Button } from "./ui/Button";
import CollapsibleSection from "./ui/CollapsibleSection";
import ConfirmDialog from "./ui/ConfirmDialog";
import FormField from "./ui/FormField";
import Modal from "./ui/Modal";
import Select from "@/components/ui/Select";

type Status = "open" | "in_progress" | "review" | "done";
type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

const STATUSES: readonly Status[] = ["open", "in_progress", "review", "done"];
const STATUS_LABELS: Record<Status, string> = {
  open: "Open",
  in_progress: "In Progress",
  review: "In Review",
  done: "Done",
};

const TASK_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "No task type" },
  { value: "bugfix", label: "Bug fix" },
  { value: "feature", label: "Feature" },
  { value: "refactoring", label: "Refactoring" },
  { value: "security", label: "Security" },
  { value: "migration", label: "Migration" },
  { value: "docs", label: "Docs" },
];

// Agent results can run to thousands of characters; clamp the collapsed box
// to this height and measure whether the content actually overflows so the
// Show more/less toggle only appears when it does something.
const RESULT_CLAMP_HEIGHT = "16rem";
// Fades the clamped content to transparent regardless of the modal's
// background colour (no overlay element needed).
const RESULT_FADE_MASK = "linear-gradient(to bottom, #000 70%, transparent)";

function isOverdue(task: Task): boolean {
  if (!task.dueAt || task.status === "done") return false;
  return new Date(task.dueAt).getTime() < Date.now();
}

function toDateInputValue(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function toIsoDateOrNull(value: string): string | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00`).toISOString();
}

function getClaimLabel(task: Task): string {
  if (!task.claimedByUserId && !task.claimedByAgentId) return "Unassigned";
  if (task.claimedByUser) return task.claimedByUser.name ?? task.claimedByUser.login;
  if (task.claimedByAgent) return `Agent ${task.claimedByAgent.name}`;
  return "Assigned";
}

export interface TaskDetailProps {
  task: Task;
  tasks: Task[];
  user: User | null;
  templateFields: { goal?: boolean; acceptanceCriteria?: boolean; context?: boolean; constraints?: boolean } | null;
  confidenceThreshold: number;
  requireDistinctReviewer?: boolean;
  onUpdate: (task: Task) => void;
  onDelete: (taskId: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
  /**
   * "modal" (default) renders inside the Modal primitive with a maximize
   * affordance and a pinned footer. "page" renders the bare detail for the
   * full-page /tasks/[id] route (the page owns its own chrome); Escape no
   * longer closes, and Save/Cancel sticks to the bottom of the page.
   */
  variant?: "modal" | "page";
}

export default function TaskDetail({
  task,
  tasks,
  user,
  templateFields,
  confidenceThreshold,
  requireDistinctReviewer = false,
  onUpdate,
  onDelete,
  onClose,
  onError,
  variant = "modal",
}: TaskDetailProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [deletingTask, setDeletingTask] = useState(false);
  const [showDeleteTaskConfirm, setShowDeleteTaskConfirm] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [advanceBusy, setAdvanceBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [reviewComment, setReviewComment] = useState("");
  const [depPickerValue, setDepPickerValue] = useState("");
  const [commentText, setCommentText] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);
  const [confirmRemoveDepId, setConfirmRemoveDepId] = useState<string | null>(null);
  const [confirmDeleteCommentId, setConfirmDeleteCommentId] = useState<string | null>(null);
  const [resultOverflows, setResultOverflows] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const reviewSectionRef = useRef<HTMLElement>(null);

  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState<Priority>("MEDIUM");
  const [editStatus, setEditStatus] = useState<Status>("open");
  const [editDueAt, setEditDueAt] = useState("");
  const [editGoal, setEditGoal] = useState("");
  const [editAcceptanceCriteria, setEditAcceptanceCriteria] = useState("");
  const [editContext, setEditContext] = useState("");
  const [editConstraints, setEditConstraints] = useState("");
  const [editTaskType, setEditTaskType] = useState<TaskType | "">("");

  const initEditState = useCallback(() => {
    setEditTitle(task.title);
    setEditDescription(task.description ?? "");
    setEditPriority(task.priority);
    setEditStatus(task.status as Status);
    setEditDueAt(toDateInputValue(task.dueAt));
    setEditGoal(task.templateData?.goal ?? "");
    setEditAcceptanceCriteria(task.templateData?.acceptanceCriteria ?? "");
    setEditContext(task.templateData?.context ?? "");
    setEditConstraints(task.templateData?.constraints ?? "");
    setEditTaskType(task.templateData?.taskType ?? "");
  }, [task]);

  // Reset modal state when switching to a different task (not on every poll refresh)
  useEffect(() => {
    setIsEditing(false);
    setCommentText("");
    setDepPickerValue("");
    setShowDeleteTaskConfirm(false);
    setResultExpanded(false);
    setConfirmRemoveDepId(null);
    setConfirmDeleteCommentId(null);
  }, [task.id]);

  // Only show the result Show-more toggle when the collapsed box actually
  // overflows, instead of guessing from a character count that doesn't track
  // rendered height.
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
        setConfirmDeleteCommentId(null);
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
        setConfirmRemoveDepId(null);
      } catch (err) {
        onError((err as Error).message);
      }
    },
    [task, onUpdate, onError],
  );

  const [showDiscardPrompt, setShowDiscardPrompt] = useState(false);

  const isDirty = useMemo(() => {
    if (!isEditing) return false;
    return (
      editTitle !== task.title ||
      editDescription !== (task.description ?? "") ||
      editPriority !== task.priority ||
      editStatus !== (task.status as Status) ||
      editDueAt !== toDateInputValue(task.dueAt) ||
      editGoal !== (task.templateData?.goal ?? "") ||
      editAcceptanceCriteria !== (task.templateData?.acceptanceCriteria ?? "") ||
      editContext !== (task.templateData?.context ?? "") ||
      editConstraints !== (task.templateData?.constraints ?? "") ||
      editTaskType !== (task.templateData?.taskType ?? "")
    );
  }, [isEditing, editTitle, editDescription, editPriority, editStatus, editDueAt, editGoal, editAcceptanceCriteria, editContext, editConstraints, editTaskType, task]);

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
      // When a ConfirmDialog is open it owns Escape (it calls onCancel on
      // its own document listener), so defer: a single Escape must not fire
      // both handlers and race (this modal's handler would reopen the
      // discard prompt the dialog just closed).
      if (showDiscardPrompt || showDeleteTaskConfirm) return;
      // 'e' to enter edit mode (only when no input/textarea focused)
      if (e.key === "e" && !isEditing) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        startEditing();
      }
      // Escape cancels an in-progress edit, otherwise closes the modal
      // (which itself guards against discarding unsaved changes). This
      // modal owns its own Escape handling, so it opts the Modal
      // primitive out via closeOnEscape={false} to avoid double-firing.
      if (e.key === "Escape") {
        // On the full page there is nothing to close, so Escape only
        // cancels an in-progress edit; the modal additionally closes.
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
      const editTplData: TemplateData = { ...(task.templateData ?? {}) };
      if (editGoal.trim()) editTplData.goal = editGoal.trim();
      else delete editTplData.goal;
      if (editAcceptanceCriteria.trim()) editTplData.acceptanceCriteria = editAcceptanceCriteria.trim();
      else delete editTplData.acceptanceCriteria;
      if (editContext.trim()) editTplData.context = editContext.trim();
      else delete editTplData.context;
      if (editConstraints.trim()) editTplData.constraints = editConstraints.trim();
      else delete editTplData.constraints;
      if (editTaskType) editTplData.taskType = editTaskType;
      else delete editTplData.taskType;

      const updated = await updateTask(task.id, {
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        priority: editPriority,
        status: editStatus,
        dueAt: toIsoDateOrNull(editDueAt),
        templateData: Object.keys(editTplData).length > 0 ? editTplData : null,
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

  // Contextual one-click workflow advance (gate-respecting, unlike the
  // edit-mode status PATCH). `start` claims + moves open → in_progress;
  // `transition` moves in_progress → review. Both surface gate/precondition
  // failures via onError rather than swallowing them.
  async function handleAdvance(action: "start" | "submit_review") {
    setAdvanceBusy(true);
    try {
      const updated = action === "start"
        ? await startTask(task.id)
        : await transitionTask(task.id, "review");
      onUpdate(updated);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setAdvanceBusy(false);
    }
  }

  const webhookEvents = (task.comments ?? []).filter((c: Comment) => c.content.startsWith("[webhook]"));
  const userComments = (task.comments ?? []).filter((c: Comment) => !c.content.startsWith("[webhook]"));

  // The result box is clamped whenever it isn't expanded; the fade mask and
  // the Show more/less toggle only appear when the measured content overflows.
  const resultClamped = !resultExpanded;
  const showResultToggle = resultOverflows || resultExpanded;
  const canSubmitReview = Boolean(task.branchName && task.prUrl);

  const editFooter = isEditing ? (
    <div style={{ display: "flex", gap: "0.45rem" }}>
      <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={savingTask}>Cancel</Button>
      <Button onClick={() => void handleSaveTask()} disabled={savingTask} loading={savingTask} size="sm">
        {savingTask ? "Saving…" : "Save"}
      </Button>
    </div>
  ) : null;

  const content = (
    <>
        {/* Header actions */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.45rem", marginBottom: "var(--space-3)" }}>
          <div style={{ display: "flex", gap: "0.45rem" }}>
            {!isEditing && task.status === "open" && !task.claimedByUserId && !task.claimedByAgentId && (
              <Button size="sm" onClick={() => void handleAdvance("start")} disabled={advanceBusy} loading={advanceBusy}>
                Start
              </Button>
            )}
            {!isEditing && task.status === "in_progress" && task.claimedByUserId === user?.id && (
              <>
                <Button
                  size="sm"
                  onClick={() => void handleAdvance("submit_review")}
                  disabled={advanceBusy || !canSubmitReview}
                  loading={advanceBusy}
                  title={!canSubmitReview ? "Record a branch and PR before submitting for review" : undefined}
                >
                  Submit for review
                </Button>
                {!canSubmitReview && (
                  <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)", alignSelf: "center" }}>
                    Add a branch and PR first
                  </span>
                )}
              </>
            )}
            {!isEditing && task.status === "review" && (
              <button
                type="button"
                onClick={() => reviewSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
                style={{ background: "var(--warning-muted)", border: "1px solid color-mix(in srgb, var(--warning) 40%, var(--border) 60%)", borderRadius: "var(--radius-base)", color: "var(--warning)", cursor: "pointer", fontSize: "var(--text-xs)", fontWeight: 600, padding: "0.35rem 0.6rem" }}
              >
                Jump to review ↓
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: "0.45rem" }}>
            {!isEditing && (
              <Button variant="secondary" size="sm" onClick={startEditing}>Edit</Button>
            )}
            {/* Delete is intentionally only reachable from edit mode, so the
                view header can't trigger a destructive action by accident. */}
            {isEditing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteTaskConfirm(true)}
                disabled={savingTask || deletingTask}
                style={{ color: "var(--danger)" }}
              >
                {deletingTask ? "Deleting…" : "Delete"}
              </Button>
            )}
          </div>
        </div>

        {/* ── Overview ──────────────────────────────────────────────── */}
        <section style={{ marginBottom: "0.8rem" }}>
          {isEditing ? (
            <>
              <p className="section-kicker">Overview</p>
              <div style={{ marginBottom: "0.5rem" }}>
                <FormField label="Title">
                  <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={{ width: "100%" }} />
                </FormField>
              </div>
              <FormField label="Description">
                <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={5} style={{ width: "100%", resize: "vertical" }} />
              </FormField>
            </>
          ) : (
            <>
              <h2 className="text-break-anywhere" style={{ fontSize: "var(--text-md)", fontWeight: 700, color: "var(--text)", marginBottom: "0.5rem", lineHeight: 1.3 }}>
                {task.title}
              </h2>
              {/* Metadata chip row */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.65rem" }}>
                <span className="status-chip">{STATUS_LABELS[task.status as Status]}</span>
                <span className="status-chip" style={{ color: PRIORITY_COLORS[task.priority] }}>{task.priority}</span>
                <span className="status-chip">{task.dueAt ? `Due ${formatDueDate(task.dueAt)}` : "No due date"}</span>
                {isOverdue(task) && (
                  <span className="status-chip" style={{ color: "var(--danger)", borderColor: "color-mix(in srgb, var(--danger) 55%, var(--border) 45%)" }}>Overdue</span>
                )}
                <span className="status-chip" style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                  {getClaimLabel(task)}
                  {!task.claimedByUserId && !task.claimedByAgentId && task.status !== "open" && (
                    <Button variant="link" size="sm" onClick={() => void handleClaim()} disabled={claimBusy} loading={claimBusy} style={{ fontSize: "var(--text-xs)" }}>
                      Claim
                    </Button>
                  )}
                  {task.claimedByUserId === user?.id && (
                    <Button variant="link-danger" size="sm" onClick={() => void handleRelease()} disabled={claimBusy} loading={claimBusy} style={{ fontSize: "var(--text-xs)" }}>
                      Release
                    </Button>
                  )}
                </span>
              </div>
              <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.65rem" }}>
                <span title={formatAbsoluteDate(task.createdAt)}>Created {formatRelativeTime(task.createdAt)}</span>
                {" · "}
                <span title={formatAbsoluteDate(task.updatedAt)}>updated {formatRelativeTime(task.updatedAt)}</span>
              </p>
              {/* External Ref + Labels */}
              {(task.externalRef || (task.labels && task.labels.length > 0)) && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", marginBottom: "0.65rem" }}>
                  {task.externalRef && (
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--primary)", background: "var(--primary-muted)", borderRadius: "4px", padding: "0.15rem 0.4rem", fontWeight: 600, fontFamily: "monospace" }}>
                      {task.externalRef}
                    </span>
                  )}
                  {task.labels?.map((label) => (
                    <span key={label} style={{ fontSize: "var(--text-xs)", color: "var(--text)", background: "color-mix(in srgb, var(--muted) 20%, transparent)", borderRadius: "4px", padding: "0.15rem 0.4rem" }}>
                      {label}
                    </span>
                  ))}
                </div>
              )}
              {/* Description */}
              {task.description ? (
                <div className="prose-markdown">
                  <ReactMarkdown>{task.description}</ReactMarkdown>
                </div>
              ) : (
                <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", fontStyle: "italic" }}>No description</p>
              )}
            </>
          )}
        </section>

        {/* ── Workflow (edit mode only) ──────────────────────────────── */}
        {isEditing && (
          <section style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Workflow</p>
            <div className="collapsing-grid" style={{ gap: "0.4rem", marginBottom: "0.5rem" }}>
              <FormField label="Status">
                <Select value={editStatus} onChange={(v) => setEditStatus(v as Status)} options={STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] }))} style={{ width: "100%" }} />
              </FormField>
              <FormField label="Priority">
                <Select value={editPriority} onChange={(v) => setEditPriority(v as Priority)} options={[{value:"LOW",label:"LOW"},{value:"MEDIUM",label:"MEDIUM"},{value:"HIGH",label:"HIGH"},{value:"CRITICAL",label:"CRITICAL"}]} style={{ width: "100%" }} />
              </FormField>
            </div>
            <FormField label="Due Date">
              <input type="date" value={editDueAt} onChange={(e) => setEditDueAt(e.target.value)} style={{ width: "100%" }} />
            </FormField>
          </section>
        )}

        {/* ── Dependencies ──────────────────────────────────────────── */}
        {isEditing ? (
          <section style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Dependencies</p>
            {(task.blockedBy?.length ?? 0) === 0 && (task.blocks?.length ?? 0) === 0 ? (
              <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.4rem" }}>No dependencies.</p>
            ) : (
              <div style={{ display: "grid", gap: "0.3rem", marginBottom: "0.4rem" }}>
                {task.blockedBy?.map((dep) => (
                  <div key={dep.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "var(--text-sm)", border: "1px solid var(--border)", borderRadius: "6px", padding: "0.3rem 0.5rem" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: dep.status === "done" ? "var(--success, #22c55e)" : "var(--danger)", flexShrink: 0 }} />
                      <span style={{ color: "var(--text)" }}>{dep.title}</span>
                      <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>({dep.status})</span>
                    </span>
                    {confirmRemoveDepId === dep.id ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                        <Button variant="link-danger" size="sm" onClick={() => void removeDependencyConfirmed(dep.id)} style={{ fontSize: "var(--text-xs)" }}>Confirm?</Button>
                        <Button variant="link" size="sm" onClick={() => setConfirmRemoveDepId(null)} style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>Cancel</Button>
                      </span>
                    ) : (
                      <Button variant="link" size="sm" onClick={() => setConfirmRemoveDepId(dep.id)} style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>Remove</Button>
                    )}
                  </div>
                ))}
                {task.blocks?.map((dep) => (
                  <div key={dep.id} style={{ fontSize: "var(--text-xs)", color: "var(--muted)", padding: "0.2rem 0.5rem" }}>
                    blocks: {dep.title} ({dep.status})
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: "0.3rem" }}>
              <Select
                value={depPickerValue}
                onChange={(v) => setDepPickerValue(v)}
                options={[{value:"",label:"Add blocker..."},...tasks
                  .filter((t) => t.id !== task.id && t.projectId === task.projectId && !task.blockedBy?.some((d) => d.id === t.id))
                  .map((t) => ({value: t.id, label: t.title}))]}
                style={{ flex: 1, fontSize: "var(--text-sm)" }}
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
                      onUpdate({ ...task, blockedBy: [...(task.blockedBy ?? []), { id: blockerTask.id, title: blockerTask.title, status: blockerTask.status }] });
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
        ) : ((task.blockedBy?.length ?? 0) > 0 || (task.blocks?.length ?? 0) > 0) ? (
          <CollapsibleSection key={task.id} title="Dependencies" count={(task.blockedBy?.length ?? 0) + (task.blocks?.length ?? 0)}>
            <div style={{ display: "grid", gap: "0.3rem" }}>
              {task.blockedBy?.map((dep) => (
                <div key={dep.id} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "var(--text-sm)", padding: "0.25rem 0" }}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: dep.status === "done" ? "var(--success, #22c55e)" : "var(--danger)", flexShrink: 0 }} />
                  <span style={{ color: "var(--text)" }}>{dep.title}</span>
                  <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>({dep.status})</span>
                </div>
              ))}
              {task.blocks?.map((dep) => (
                <div key={dep.id} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "var(--text-xs)", color: "var(--muted)", padding: "0.2rem 0" }}>
                  <span>blocks: {dep.title} ({dep.status})</span>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        ) : null}

        {/* ── Agent Template ──────────────────────────────────────────── */}
        {templateFields && (
          <section style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Agent Template</p>
            {(() => {
              const conf = calculateConfidence({
                title: isEditing ? editTitle : task.title,
                description: isEditing ? (editDescription || null) : (task.description ?? null),
                templateData: isEditing
                  ? {
                      ...(task.templateData ?? {}),
                      goal: editGoal || undefined,
                      acceptanceCriteria: editAcceptanceCriteria || undefined,
                      context: editContext || undefined,
                      constraints: editConstraints || undefined,
                      taskType: editTaskType || undefined,
                    }
                  : task.templateData,
                templateFields,
              });
              return (
                <div style={{ marginBottom: "0.5rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
                    <ConfidenceBadge score={conf.score} size="md" />
                    {conf.score < confidenceThreshold && (
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--danger)" }}>
                        Below threshold ({confidenceThreshold}) — agents cannot claim this task
                      </span>
                    )}
                  </div>
                  {conf.missing.length > 0 && (
                    <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "0.5rem" }}>
                      Missing: {conf.missing.join(", ")}
                    </p>
                  )}
                </div>
              );
            })()}
            {isEditing ? (
              <>
                <div style={{ marginBottom: "0.5rem" }}>
                  <FormField label="Task Type">
                    <Select
                      value={editTaskType}
                      onChange={(value) => setEditTaskType(value as TaskType | "")}
                      options={TASK_TYPE_OPTIONS}
                      style={{ width: "100%" }}
                    />
                  </FormField>
                </div>
                {templateFields.goal && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Goal">
                      <textarea value={editGoal} onChange={(e) => setEditGoal(e.target.value)} rows={2} style={{ width: "100%", resize: "vertical" }} />
                    </FormField>
                  </div>
                )}
                {templateFields.acceptanceCriteria && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Acceptance Criteria">
                      <textarea value={editAcceptanceCriteria} onChange={(e) => setEditAcceptanceCriteria(e.target.value)} rows={3} style={{ width: "100%", resize: "vertical" }} />
                    </FormField>
                  </div>
                )}
                {templateFields.context && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Context">
                      <textarea value={editContext} onChange={(e) => setEditContext(e.target.value)} rows={2} style={{ width: "100%", resize: "vertical" }} />
                    </FormField>
                  </div>
                )}
                {templateFields.constraints && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Constraints">
                      <textarea value={editConstraints} onChange={(e) => setEditConstraints(e.target.value)} rows={2} style={{ width: "100%", resize: "vertical" }} />
                    </FormField>
                  </div>
                )}
              </>
            ) : (
              <div style={{ display: "grid", gap: "0.5rem" }}>
                {task.templateData?.taskType && (
                  <div>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Task Type</span>
                    <div style={{ marginTop: "0.15rem", fontSize: "var(--text-sm)", color: "var(--text)" }}>
                      {TASK_TYPE_OPTIONS.find((opt) => opt.value === task.templateData?.taskType)?.label ?? task.templateData.taskType}
                    </div>
                  </div>
                )}
                {templateFields.goal && task.templateData?.goal && (
                  <div>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Goal</span>
                    <div className="prose-markdown" style={{ marginTop: "0.15rem" }}><ReactMarkdown>{task.templateData.goal}</ReactMarkdown></div>
                  </div>
                )}
                {templateFields.acceptanceCriteria && task.templateData?.acceptanceCriteria && (
                  <div>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Acceptance Criteria</span>
                    <div className="prose-markdown" style={{ marginTop: "0.15rem" }}><ReactMarkdown>{task.templateData.acceptanceCriteria}</ReactMarkdown></div>
                  </div>
                )}
                {templateFields.context && task.templateData?.context && (
                  <div>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Context</span>
                    <div className="prose-markdown" style={{ marginTop: "0.15rem" }}><ReactMarkdown>{task.templateData.context}</ReactMarkdown></div>
                  </div>
                )}
                {templateFields.constraints && task.templateData?.constraints && (
                  <div>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Constraints</span>
                    <div className="prose-markdown" style={{ marginTop: "0.15rem" }}><ReactMarkdown>{task.templateData.constraints}</ReactMarkdown></div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* ── Agent Output ──────────────────────────────────────────── */}
        {(task.branchName || task.prUrl || task.result) && (
          <section style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Agent Output</p>
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              {task.branchName && (
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                  <span style={{ color: "var(--muted)", minWidth: "4rem" }}>Branch</span>
                  <code style={{ background: "var(--surface-secondary)", padding: "0.2rem 0.5rem", borderRadius: "var(--radius-sm)", fontSize: "var(--text-xs)", wordBreak: "break-all" }}>
                    {task.branchName}
                  </code>
                </div>
              )}
              {task.prUrl && (
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                  <span style={{ color: "var(--muted)", minWidth: "4rem" }}>PR</span>
                  <a
                    href={task.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: "var(--text-sm)", wordBreak: "break-all" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {task.prNumber ? `#${task.prNumber}` : "Open PR"}
                  </a>
                </div>
              )}
              {task.result && (
                <div style={{ fontSize: "var(--text-sm)" }}>
                  <span style={{ color: "var(--muted)", display: "block", marginBottom: "var(--space-1)" }}>Result</span>
                  <div
                    ref={resultRef}
                    className="prose-markdown"
                    style={{
                      fontSize: "var(--text-sm)",
                      maxHeight: resultClamped ? RESULT_CLAMP_HEIGHT : undefined,
                      overflow: resultClamped ? "hidden" : undefined,
                      maskImage: resultClamped && resultOverflows ? RESULT_FADE_MASK : undefined,
                      WebkitMaskImage: resultClamped && resultOverflows ? RESULT_FADE_MASK : undefined,
                    }}
                  >
                    <ReactMarkdown>{task.result}</ReactMarkdown>
                  </div>
                  {showResultToggle && (
                    <button
                      type="button"
                      onClick={() => setResultExpanded((v) => !v)}
                      style={{ background: "none", border: "none", padding: "0.25rem 0", color: "var(--primary)", cursor: "pointer", fontSize: "var(--text-xs)", fontWeight: 600 }}
                    >
                      {resultExpanded ? "Show less" : "Show more"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Divider ──────────────────────────────────────────────── */}
        <div style={{ borderTop: "1px solid var(--border)", margin: "0.6rem 0" }} />

        {/* ── Review ──────────────────────────────────────────────── */}
        {task.status === "review" && task.claimedByUserId === user?.id && (
          <section ref={reviewSectionRef} style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Review</p>
            {requireDistinctReviewer ? (
              <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.4rem" }}>
                This project requires a <strong>distinct reviewer</strong>. You claimed this task, so you cannot approve it yourself — a different user or agent must take the review lock and approve. Once approved, the task moves to done automatically.
              </p>
            ) : (
              <>
                <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.4rem" }}>This is your task. Once review is complete, mark it done.</p>
                <Button
                  size="sm"
                  disabled={reviewBusy}
                  loading={reviewBusy}
                  onClick={async () => {
                    setReviewBusy(true);
                    try {
                      // Route through /transition so the backend can enforce
                      // workflow rules, precondition gates, and (when the
                      // project has it on) the distinct-reviewer gate. The
                      // old code called PATCH directly, which bypassed all
                      // three.
                      const updated = await transitionTask(task.id, "done");
                      onUpdate(updated);
                    } catch (err) {
                      onError((err as Error).message);
                    } finally {
                      setReviewBusy(false);
                    }
                  }}
                >
                  Mark Done
                </Button>
              </>
            )}
          </section>
        )}

        {task.status === "review" && task.claimedByUserId !== user?.id && (
          <section ref={reviewSectionRef} style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Review</p>
            <div style={{ marginBottom: "0.4rem" }}>
              <textarea
                value={reviewComment}
                onChange={(e) => setReviewComment(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !reviewBusy) {
                    e.preventDefault();
                    void submitReview("approve");
                  }
                }}
                aria-label="Review feedback"
                placeholder="Review feedback (optional)"
                rows={2}
                style={{ width: "100%", resize: "vertical", fontSize: "var(--text-sm)" }}
              />
            </div>
            <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", margin: "0 0 0.4rem" }}>⌘/Ctrl+Enter to approve</p>
            <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
              <Button size="sm" disabled={reviewBusy} loading={reviewBusy} onClick={() => void submitReview("approve")}>
                Approve
              </Button>
              <Button variant="outline-danger" size="sm" disabled={reviewBusy} loading={reviewBusy} onClick={() => void submitReview("request_changes")}>
                Request Changes
              </Button>
            </div>
          </section>
        )}

        {/* ── Activity ──────────────────────────────────────────── */}
        {webhookEvents.length > 0 && (
          <CollapsibleSection key={task.id} title="Activity" count={webhookEvents.length}>
            <div style={{ display: "grid", gap: "0.25rem", marginBottom: "0.5rem" }}>
              {webhookEvents.map((event: Comment) => {
                const message = event.content.replace(/^\[webhook]\s*/, "");
                const isTransition = message.includes("merged") || message.includes("in_progress") || message.includes("→");
                const isReview = message.includes("approved") || message.includes("Changes requested") || message.includes("dismissed");
                const dotColor = isTransition ? "var(--success, #22c55e)" : isReview ? "var(--warning, #eab308)" : "var(--muted)";
                return (
                  <div key={event.id} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", padding: "0.35rem 0.5rem", fontSize: "var(--text-xs)", color: "var(--text-secondary)", background: "var(--surface)", borderRadius: "6px" }}>
                    <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: dotColor, flexShrink: 0, marginTop: "5px" }} />
                    <span style={{ flex: 1, lineHeight: 1.4 }}>{message}</span>
                    <span title={formatAbsoluteDate(event.createdAt)} style={{ color: "var(--muted)", whiteSpace: "nowrap", flexShrink: 0 }}>
                      {formatRelativeTime(event.createdAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          </CollapsibleSection>
        )}

        {/* ── Artifacts ─────────────────────────────────────────── */}
        <TaskArtifactsSection
          taskId={task.id}
          initial={task.artifacts}
          user={user}
          onError={onError}
        />

        {/* ── Attachments ───────────────────────────────────────── */}
        <TaskAttachmentsSection
          taskId={task.id}
          initial={task.attachments}
          user={user}
          onError={onError}
        />

        {/* ── Comments ──────────────────────────────────────────── */}
        <section>
          <p className="section-kicker">Comments</p>
          {userComments.length === 0 ? (
            <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.5rem" }}>No comments yet.</p>
          ) : (
            <div style={{ display: "grid", gap: "0.4rem", marginBottom: "0.5rem" }}>
              {userComments.map((comment: Comment) => {
                const authorName = comment.authorUser?.name ?? comment.authorUser?.login ?? (comment.authorAgent ? `Agent ${comment.authorAgent.name}` : "Unknown");
                const isOwn = comment.authorUser?.id === user?.id;
                return (
                  <div key={comment.id} style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.5rem", fontSize: "var(--text-sm)", background: "var(--surface)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
                      <span style={{ fontWeight: 600, fontSize: "var(--text-xs)", color: comment.authorAgent ? "var(--primary, #3b82f6)" : "var(--text)" }}>
                        {authorName}
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                        <span title={formatAbsoluteDate(comment.createdAt)} style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                          {formatRelativeTime(comment.createdAt)}
                        </span>
                        {isOwn && (
                          confirmDeleteCommentId === comment.id ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                              <Button variant="link-danger" size="sm" onClick={() => void deleteCommentConfirmed(comment.id)} style={{ fontSize: "var(--text-xs)" }}>Confirm?</Button>
                              <Button variant="link" size="sm" onClick={() => setConfirmDeleteCommentId(null)} style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>Cancel</Button>
                            </span>
                          ) : (
                            <Button variant="link-danger" size="sm" onClick={() => setConfirmDeleteCommentId(comment.id)} style={{ fontSize: "var(--text-xs)" }}>Delete</Button>
                          )
                        )}
                      </span>
                    </div>
                    <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.4, color: "var(--text)" }}>{comment.content}</p>
                  </div>
                );
              })}
            </div>
          )}
          <div>
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <textarea
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void submitComment();
                  }
                }}
                aria-label="Write a comment"
                placeholder="Write a comment..."
                rows={2}
                style={{ flex: 1, resize: "vertical", fontSize: "var(--text-sm)" }}
              />
              <Button
                size="sm"
                disabled={!commentText.trim() || submittingComment}
                loading={submittingComment}
                onClick={() => void submitComment()}
              >
                Send
              </Button>
            </div>
            <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", margin: "0.25rem 0 0" }}>⌘/Ctrl+Enter to send</p>
          </div>
        </section>
    </>
  );

  return (
    <>
      {variant === "page" ? (
        <>
          {content}
          {editFooter && <div className="task-detail-page-actions">{editFooter}</div>}
        </>
      ) : (
        <Modal
          open
          onClose={handleClose}
          closeOnEscape={false}
          title="Task Details"
          actions={editFooter}
          headerActions={
            // Hidden while editing: the maximize Link navigates immediately,
            // and the /tasks/[id] page opens in view mode, so showing it
            // mid-edit would silently drop unsaved changes — bypassing the
            // discard guard that the X / backdrop / Escape paths honour.
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
          {content}
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
