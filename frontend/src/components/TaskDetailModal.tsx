"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
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
  transitionTask,
  type User,
  type Task,
  type Comment,
  type TemplateData,
} from "../lib/api";
import { calculateConfidence } from "../lib/confidence";
import ConfidenceBadge from "./ConfidenceBadge";
import TaskArtifactsSection from "./TaskArtifactsSection";
import { Button } from "./ui/Button";
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

const PRIORITY_COLORS: Record<Priority, string> = {
  LOW: "#8d99ab",
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
  requireDistinctReviewer?: boolean;
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
  requireDistinctReviewer = false,
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

  // Reset modal state when switching to a different task (not on every poll refresh)
  useEffect(() => {
    setIsEditing(false);
    setCommentText("");
    setDepPickerValue("");
    setShowDeleteTaskConfirm(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

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
  }, [isEditing, startEditing, cancelEditing]);

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
              <h2 className="text-break-anywhere" style={{ fontSize: "var(--text-md)", fontWeight: 700, color: "var(--text)", marginBottom: "0.5rem", lineHeight: 1.3 }}>
                {task.title}
              </h2>
              {/* Metadata chip row */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.65rem" }}>
                <span className="status-chip">{STATUS_LABELS[task.status as Status]}</span>
                <span className="status-chip" style={{ color: PRIORITY_COLORS[task.priority] }}>{task.priority}</span>
                <span className="status-chip">{task.dueAt ? `Due ${toDateInputValue(task.dueAt)}` : "No due date"}</span>
                <span className="status-chip">{isOverdue(task) ? "Overdue" : "On track"}</span>
                <span className="status-chip" style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                  {getClaimLabel(task)}
                  {!task.claimedByUserId && !task.claimedByAgentId && (
                    <button
                      type="button"
                      onClick={() => void handleClaim()}
                      disabled={claimBusy}
                      style={{ background: "none", border: "none", color: "var(--primary)", cursor: "pointer", fontSize: "var(--text-xs)", padding: 0, fontWeight: 600 }}
                    >
                      {claimBusy ? "…" : "Claim"}
                    </button>
                  )}
                  {task.claimedByUserId === user?.id && (
                    <button
                      type="button"
                      onClick={() => void handleRelease()}
                      disabled={claimBusy}
                      style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: "var(--text-xs)", padding: 0, fontWeight: 600 }}
                    >
                      {claimBusy ? "…" : "Release"}
                    </button>
                  )}
                </span>
              </div>
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem", marginBottom: "0.5rem" }}>
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
                  <div key={event.id} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", padding: "0.35rem 0.5rem", fontSize: "var(--text-xs)", color: "var(--text-secondary)", background: "var(--surface)", borderRadius: "6px" }}>
                    <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: dotColor, flexShrink: 0, marginTop: "5px" }} />
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

        {/* ── Artifacts ─────────────────────────────────────────── */}
        <TaskArtifactsSection
          taskId={task.id}
          initial={task.artifacts}
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
