"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  updateTask,
  deleteTask,
  claimTask,
  releaseTask,
  createComment,
  deleteComment,
  addDependency,
  removeDependency,
  reviewTask,
  type User,
  type Task,
  type Comment,
  type TemplateData,
} from "../lib/api";
import { calculateConfidence } from "../lib/confidence";
import ConfidenceBadge from "./ConfidenceBadge";
import { Button } from "./ui/Button";
import ConfirmDialog from "./ui/ConfirmDialog";
import FormField from "./ui/FormField";
import Modal from "./ui/Modal";

type Status = "open" | "in_progress" | "review" | "done";
type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

const STATUSES: readonly Status[] = ["open", "in_progress", "review", "done"];
const STATUS_LABELS: Record<Status, string> = {
  open: "Open",
  in_progress: "In Progress",
  review: "In Review",
  done: "Done",
};

const PRIORITY_COLORS: Record<Priority, string> = {
  LOW: "#6b7280",
  MEDIUM: "#f59e0b",
  HIGH: "#ef4444",
  CRITICAL: "#be123c",
};

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

export interface TaskDetailModalProps {
  task: Task;
  tasks: Task[];
  user: User | null;
  templateFields: { goal?: boolean; acceptanceCriteria?: boolean; context?: boolean; constraints?: boolean } | null;
  confidenceThreshold: number;
  onUpdate: (task: Task) => void;
  onDelete: (taskId: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

export default function TaskDetailModal({
  task,
  tasks,
  user,
  templateFields,
  confidenceThreshold,
  onUpdate,
  onDelete,
  onClose,
  onError,
}: TaskDetailModalProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [deletingTask, setDeletingTask] = useState(false);
  const [showDeleteTaskConfirm, setShowDeleteTaskConfirm] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewComment, setReviewComment] = useState("");
  const [depPickerValue, setDepPickerValue] = useState("");
  const [commentText, setCommentText] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);

  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState<Priority>("MEDIUM");
  const [editStatus, setEditStatus] = useState<Status>("open");
  const [editDueAt, setEditDueAt] = useState("");
  const [editGoal, setEditGoal] = useState("");
  const [editAcceptanceCriteria, setEditAcceptanceCriteria] = useState("");
  const [editContext, setEditContext] = useState("");
  const [editConstraints, setEditConstraints] = useState("");

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
  }, [task]);

  // Reset modal state when task changes
  useEffect(() => {
    setIsEditing(false);
    setCommentText("");
    setDepPickerValue("");
    setShowDeleteTaskConfirm(false);
  }, [task]);

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
      editConstraints !== (task.templateData?.constraints ?? "")
    );
  }, [isEditing, editTitle, editDescription, editPriority, editStatus, editDueAt, editGoal, editAcceptanceCriteria, editContext, editConstraints, task]);

  function startEditing() {
    initEditState();
    setIsEditing(true);
  }

  function cancelEditing() {
    if (isDirty) {
      setShowDiscardPrompt(true);
    } else {
      setIsEditing(false);
    }
  }

  function discardChanges() {
    setShowDiscardPrompt(false);
    setIsEditing(false);
  }

  function handleClose() {
    if (isEditing && isDirty) {
      setShowDiscardPrompt(true);
    } else {
      onClose();
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // 'e' to enter edit mode (only when no input/textarea focused)
      if (e.key === "e" && !isEditing) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        startEditing();
      }
      // Escape to cancel editing
      if (e.key === "Escape" && isEditing) {
        e.preventDefault();
        cancelEditing();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  async function handleSaveTask() {
    setSavingTask(true);
    try {
      const editTplData: TemplateData = {};
      if (editGoal.trim()) editTplData.goal = editGoal.trim();
      if (editAcceptanceCriteria.trim()) editTplData.acceptanceCriteria = editAcceptanceCriteria.trim();
      if (editContext.trim()) editTplData.context = editContext.trim();
      if (editConstraints.trim()) editTplData.constraints = editConstraints.trim();

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

  const webhookEvents = (task.comments ?? []).filter((c: Comment) => c.content.startsWith("[webhook]"));
  const userComments = (task.comments ?? []).filter((c: Comment) => !c.content.startsWith("[webhook]"));

  return (
    <>
      <Modal
        open
        onClose={handleClose}
        title="Task Details"
        actions={isEditing ? (
          <div style={{ display: "flex", gap: "0.45rem" }}>
            <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={savingTask}>Cancel</Button>
            <Button onClick={() => void handleSaveTask()} disabled={savingTask} loading={savingTask} size="sm">
              {savingTask ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : undefined}
      >
        {/* Header actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.45rem", marginBottom: "var(--space-3)" }}>
          {!isEditing && (
            <Button variant="secondary" size="sm" onClick={startEditing}>Edit</Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowDeleteTaskConfirm(true)}
            disabled={savingTask || deletingTask}
            style={{ color: "var(--danger)" }}
          >
            {deletingTask ? "Deleting…" : "Delete"}
          </Button>
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
              <h2 style={{ fontSize: "var(--text-md)", fontWeight: 700, color: "var(--text)", marginBottom: "0.5rem", lineHeight: 1.3 }}>
                {task.title}
              </h2>
              {/* Metadata chip row */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.65rem" }}>
                <span className="status-chip">{STATUS_LABELS[task.status as Status]}</span>
                <span className="status-chip" style={{ color: PRIORITY_COLORS[task.priority] }}>{task.priority}</span>
                <span className="status-chip">{task.dueAt ? `Due ${toDateInputValue(task.dueAt)}` : "No due date"}</span>
                <span className="status-chip">{isOverdue(task) ? "Overdue" : "On track"}</span>
                <span className="status-chip">{getClaimLabel(task)}</span>
              </div>
              {/* Description */}
              {task.description ? (
                <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, color: "var(--text)", fontSize: "var(--text-sm)" }}>
                  {task.description}
                </p>
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem", marginBottom: "0.5rem" }}>
              <FormField label="Status">
                <select value={editStatus} onChange={(e) => setEditStatus(e.target.value as Status)} style={{ width: "100%" }}>
                  {STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
                </select>
              </FormField>
              <FormField label="Priority">
                <select value={editPriority} onChange={(e) => setEditPriority(e.target.value as Priority)} style={{ width: "100%" }}>
                  <option value="LOW">LOW</option>
                  <option value="MEDIUM">MEDIUM</option>
                  <option value="HIGH">HIGH</option>
                  <option value="CRITICAL">CRITICAL</option>
                </select>
              </FormField>
            </div>
            <FormField label="Due Date">
              <input type="date" value={editDueAt} onChange={(e) => setEditDueAt(e.target.value)} style={{ width: "100%" }} />
            </FormField>
          </section>
        )}

        {/* ── Dependencies ──────────────────────────────────────────── */}
        {(isEditing || (task.blockedBy?.length ?? 0) > 0 || (task.blocks?.length ?? 0) > 0) && (
          <section style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Dependencies</p>
            {isEditing ? (
              <>
                {(task.blockedBy?.length ?? 0) === 0 && (task.blocks?.length ?? 0) === 0 ? (
                  <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.4rem" }}>No dependencies.</p>
                ) : (
                  <div style={{ display: "grid", gap: "0.3rem", marginBottom: "0.4rem" }}>
                    {task.blockedBy?.map((dep) => (
                      <div key={dep.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "var(--text-sm)", border: "1px solid var(--border)", borderRadius: "6px", padding: "0.3rem 0.5rem" }}>
                        <span>
                          <span style={{ color: dep.status === "done" ? "var(--success, #22c55e)" : "var(--danger)" }}>
                            {dep.status === "done" ? "done" : "blocks this"}
                          </span>
                          {" "}{dep.title}
                        </span>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await removeDependency(task.id, dep.id);
                              onUpdate({ ...task, blockedBy: task.blockedBy?.filter((d) => d.id !== dep.id) });
                            } catch (err) {
                              onError((err as Error).message);
                            }
                          }}
                          style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: "var(--text-xs)" }}
                        >
                          Remove
                        </button>
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
                  <select
                    value={depPickerValue}
                    onChange={(e) => setDepPickerValue(e.target.value)}
                    style={{ flex: 1, fontSize: "var(--text-sm)" }}
                  >
                    <option value="" disabled>Add blocker...</option>
                    {tasks
                      .filter((t) => t.id !== task.id && t.projectId === task.projectId && !task.blockedBy?.some((d) => d.id === t.id))
                      .map((t) => (
                        <option key={t.id} value={t.id}>{t.title}</option>
                      ))}
                  </select>
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
              </>
            ) : (
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
            )}
          </section>
        )}

        {/* ── Agent Template ──────────────────────────────────────────── */}
        {templateFields && (
          <section style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Agent Template</p>
            {(() => {
              const conf = calculateConfidence({
                title: isEditing ? editTitle : task.title,
                description: isEditing ? (editDescription || null) : (task.description ?? null),
                templateData: isEditing
                  ? { goal: editGoal || undefined, acceptanceCriteria: editAcceptanceCriteria || undefined, context: editContext || undefined, constraints: editConstraints || undefined }
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
                {templateFields.goal && task.templateData?.goal && (
                  <div>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Goal</span>
                    <p style={{ whiteSpace: "pre-wrap", fontSize: "var(--text-sm)", lineHeight: 1.5, color: "var(--text)", marginTop: "0.15rem" }}>{task.templateData.goal}</p>
                  </div>
                )}
                {templateFields.acceptanceCriteria && task.templateData?.acceptanceCriteria && (
                  <div>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Acceptance Criteria</span>
                    <p style={{ whiteSpace: "pre-wrap", fontSize: "var(--text-sm)", lineHeight: 1.5, color: "var(--text)", marginTop: "0.15rem" }}>{task.templateData.acceptanceCriteria}</p>
                  </div>
                )}
                {templateFields.context && task.templateData?.context && (
                  <div>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Context</span>
                    <p style={{ whiteSpace: "pre-wrap", fontSize: "var(--text-sm)", lineHeight: 1.5, color: "var(--text)", marginTop: "0.15rem" }}>{task.templateData.context}</p>
                  </div>
                )}
                {templateFields.constraints && task.templateData?.constraints && (
                  <div>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Constraints</span>
                    <p style={{ whiteSpace: "pre-wrap", fontSize: "var(--text-sm)", lineHeight: 1.5, color: "var(--text)", marginTop: "0.15rem" }}>{task.templateData.constraints}</p>
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
                    style={{ fontSize: "var(--text-sm)" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {task.prNumber ? `#${task.prNumber}` : task.prUrl}
                  </a>
                </div>
              )}
              {task.result && (
                <div style={{ fontSize: "var(--text-sm)" }}>
                  <span style={{ color: "var(--muted)", display: "block", marginBottom: "var(--space-1)" }}>Result</span>
                  <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                    {task.result}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Divider ──────────────────────────────────────────────── */}
        <div style={{ borderTop: "1px solid var(--border)", margin: "0.6rem 0" }} />

        {/* ── Review ──────────────────────────────────────────────── */}
        {task.status === "review" && task.claimedByUserId === user?.id && (
          <section style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Review</p>
            <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.4rem" }}>This is your task. Once review is complete, mark it done.</p>
            <Button
              size="sm"
              disabled={reviewBusy}
              loading={reviewBusy}
              onClick={async () => {
                setReviewBusy(true);
                try {
                  const updated = await updateTask(task.id, { status: "done" });
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
          </section>
        )}

        {task.status === "review" && task.claimedByUserId !== user?.id && (
          <section style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Review</p>
            <div style={{ marginBottom: "0.4rem" }}>
              <textarea
                value={reviewComment}
                onChange={(e) => setReviewComment(e.target.value)}
                placeholder="Review feedback (optional)"
                rows={2}
                style={{ width: "100%", resize: "vertical", fontSize: "var(--text-sm)" }}
              />
            </div>
            <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
              <Button
                size="sm"
                disabled={reviewBusy}
                loading={reviewBusy}
                onClick={async () => {
                  setReviewBusy(true);
                  try {
                    const updated = await reviewTask(task.id, "approve", reviewComment);
                    onUpdate(updated);
                    setReviewComment("");
                  } catch (err) {
                    onError((err as Error).message);
                  } finally {
                    setReviewBusy(false);
                  }
                }}
              >
                Approve
              </Button>
              <Button
                variant="outline-danger"
                size="sm"
                disabled={reviewBusy}
                loading={reviewBusy}
                onClick={async () => {
                  setReviewBusy(true);
                  try {
                    const updated = await reviewTask(task.id, "request_changes", reviewComment);
                    onUpdate(updated);
                    setReviewComment("");
                  } catch (err) {
                    onError((err as Error).message);
                  } finally {
                    setReviewBusy(false);
                  }
                }}
              >
                Request Changes
              </Button>
            </div>
          </section>
        )}

        {/* ── Ownership ──────────────────────────────────────────── */}
        {!isEditing && (
          <section style={{ marginBottom: "0.8rem" }}>
            <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
              {!task.claimedByUserId && !task.claimedByAgentId && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleClaim()}
                  disabled={claimBusy}
                  loading={claimBusy}
                >
                  {claimBusy ? "Claiming…" : "Claim for me"}
                </Button>
              )}
              {task.claimedByUserId === user?.id && (
                <Button
                  variant="outline-danger"
                  size="sm"
                  onClick={() => void handleRelease()}
                  disabled={claimBusy}
                  loading={claimBusy}
                >
                  {claimBusy ? "Releasing…" : "Release"}
                </Button>
              )}
            </div>
          </section>
        )}

        {/* ── Activity ──────────────────────────────────────────── */}
        {webhookEvents.length > 0 && (
          <section>
            <p className="section-kicker">Activity</p>
            <div style={{ display: "grid", gap: "0.25rem", marginBottom: "0.5rem" }}>
              {webhookEvents.map((event: Comment) => {
                const message = event.content.replace(/^\[webhook]\s*/, "");
                const isTransition = message.includes("merged") || message.includes("in_progress") || message.includes("→");
                const isReview = message.includes("approved") || message.includes("Changes requested") || message.includes("dismissed");
                const dotColor = isTransition ? "var(--success, #22c55e)" : isReview ? "var(--warning, #eab308)" : "var(--muted)";
                return (
                  <div key={event.id} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", padding: "0.35rem 0.5rem", fontSize: "var(--text-xs)", color: "var(--text-secondary)", borderLeft: `2px solid ${dotColor}`, background: "var(--surface)", borderRadius: "0 6px 6px 0" }}>
                    <span style={{ flex: 1, lineHeight: 1.4 }}>{message}</span>
                    <span style={{ color: "var(--muted)", whiteSpace: "nowrap", flexShrink: 0 }}>
                      {new Date(event.createdAt).toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

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
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                          {new Date(comment.createdAt).toLocaleString()}
                        </span>
                        {isOwn && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await deleteComment(task.id, comment.id);
                                onUpdate({ ...task, comments: task.comments?.filter((co) => co.id !== comment.id) });
                              } catch (err) {
                                onError((err as Error).message);
                              }
                            }}
                            style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: "var(--text-xs)", padding: "0" }}
                          >
                            Delete
                          </button>
                        )}
                      </span>
                    </div>
                    <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.4, color: "var(--text)" }}>{comment.content}</p>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Write a comment..."
              rows={2}
              style={{ flex: 1, resize: "vertical", fontSize: "var(--text-sm)" }}
            />
            <Button
              size="sm"
              disabled={!commentText.trim() || submittingComment}
              loading={submittingComment}
              onClick={async () => {
                if (!commentText.trim()) return;
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
              }}
            >
              Send
            </Button>
          </div>
        </section>
      </Modal>

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
