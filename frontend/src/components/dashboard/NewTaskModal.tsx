"use client";

// NewTaskModal: extracted from dashboard/page.tsx (Stage D2).
// Always-visible fields: Title, Description, Status, Priority, Due, Assignee.
// Agent-template fields collapse into CollapsibleSection (collapsed by default)
// with a live ConfidenceBadge in the section header.
// Submit Button is pinned in the Modal footer slot.
// All existing fields, validation, and create behavior are preserved.

import { useEffect, useMemo, useState } from "react";
import {
  createTask,
  claimTask,
  type EnforcementMode,
  type Task,
  type TaskTemplate,
  type TemplatePreset,
} from "../../lib/api";
import { calculateConfidence, TASK_TYPES, type TaskType } from "../../lib/confidence";
import { DEFAULT_CREATE_STATUS } from "../../lib/status";
import { buildSavedTemplateData } from "../../lib/templateData";
import ConfidenceBadge from "../ConfidenceBadge";
import CreateConfidencePanel from "../CreateConfidencePanel";
import CollapsibleSection from "../ui/CollapsibleSection";
import FormField from "../ui/FormField";
import Modal from "../ui/Modal";
import Select from "../ui/Select";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";

// Statuses this modal can actually create a task with -- the Status dropdown
// offers exactly these two, Backlog first. Supersedes D19 (operator decision
// 2026-08-20): backlog is now the default human create target too, not
// agent-only; human create no longer always targets "open".
type CreateStatus = "backlog" | "open";
type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

// Any status a caller might still pass in as a preset (e.g. a non-Open board
// column's + button -- that gating still exists until a follow-up task
// removes it). Anything other than "backlog" | "open" is clamped below since
// those are the only values the Status dropdown can submit.
type IncomingStatus = CreateStatus | "in_progress" | "review" | "done";

function resolveCreateStatus(value: IncomingStatus | undefined): CreateStatus {
  return value === "backlog" || value === "open" ? value : DEFAULT_CREATE_STATUS;
}

function toIsoDateOrNull(value: string): string | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00`).toISOString();
}

interface NewTaskModalProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  templateFields: TaskTemplate["fields"] | null;
  templatePresets: TemplatePreset[];
  /** M2 (task e32cee5f): the project's confidence-gate enforcement mode
   *  (`project.enforcementMode`), threaded through to CreateConfidencePanel
   *  so its below-threshold copy never claims a claim is blocked when the
   *  project isn't actually blocking it (see CreateConfidencePanel's own
   *  doc for the null/undefined-as-advisory default). */
  enforcementMode: EnforcementMode | null;
  /**
   * Initial status hint from the caller (e.g. a board column's + button).
   * Defaults to DEFAULT_CREATE_STATUS (backlog). Any value the Status
   * dropdown cannot offer is clamped to DEFAULT_CREATE_STATUS -- see
   * resolveCreateStatus.
   */
  initialStatus?: IncomingStatus;
  /**
   * Called after a task is successfully created. The parent adds the task
   * to its local list.
   */
  onTaskCreated: (task: Task) => void;
  /**
   * Called when the user clicks "Edit task" in the post-create confidence
   * panel. The parent should open the task in the detail view.
   */
  onEditTask: (taskId: string) => void;
}

export default function NewTaskModal({
  open,
  onClose,
  projectId,
  templateFields,
  templatePresets,
  enforcementMode,
  initialStatus,
  onTaskCreated,
  onEditTask,
}: NewTaskModalProps) {
  const { toast } = useToast();
  const resolvedInitialStatus = resolveCreateStatus(initialStatus);

  // ── Core fields (always visible) ──────────────────────────────
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<CreateStatus>(resolvedInitialStatus);
  const [priority, setPriority] = useState<Priority>("MEDIUM");
  const [dueAt, setDueAt] = useState("");
  const [assignee, setAssignee] = useState<"unassigned" | "me">("unassigned");

  // ── Agent-template fields (collapsible) ───────────────────────
  const [goal, setGoal] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [context, setContext] = useState("");
  const [constraints, setConstraints] = useState("");
  const [scope, setScope] = useState("");
  const [outOfScope, setOutOfScope] = useState("");
  const [dependencies, setDependencies] = useState("");
  const [risk, setRisk] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [taskType, setTaskType] = useState<TaskType | "">("");

  // ── Post-create confidence panel ──────────────────────────────
  const [creating, setCreating] = useState(false);
  const [createdConfidence, setCreatedConfidence] = useState<import("../../lib/api").CreateConfidence | null>(null);
  const [createdAssignmentError, setCreatedAssignmentError] = useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);

  // Reset all fields whenever the modal opens (including when initialStatus changes).
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setStatus(resolvedInitialStatus);
    setPriority("MEDIUM");
    setDueAt("");
    setAssignee("unassigned");
    setGoal("");
    setAcceptanceCriteria("");
    setContext("");
    setConstraints("");
    setScope("");
    setOutOfScope("");
    setDependencies("");
    setRisk("");
    setAgentPrompt("");
    setTaskType("");
    setCreating(false);
    setCreatedConfidence(null);
    setCreatedAssignmentError(null);
    setCreatedTaskId(null);
  }, [open, resolvedInitialStatus]);

  const templateData = useMemo(
    () =>
      buildSavedTemplateData(null, {
        goal,
        acceptanceCriteria,
        context,
        constraints,
        scope,
        outOfScope,
        dependencies,
        risk,
        agentPrompt,
        taskType,
      }),
    [goal, acceptanceCriteria, context, constraints, scope, outOfScope, dependencies, risk, agentPrompt, taskType],
  );

  const confidenceScore = useMemo(
    () =>
      calculateConfidence({
        title,
        description: description || null,
        templateData,
        templateFields,
      }).score,
    [title, description, templateData, templateFields],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setCreating(true);
    try {
      const { task: created, confidence } = await createTask(projectId, {
        title: title.trim(),
        description: description.trim() || undefined,
        status,
        priority,
        dueAt: toIsoDateOrNull(dueAt) ?? undefined,
        ...(templateData ? { templateData } : {}),
      });

      let task = created;
      let assignmentError: string | null = null;
      // Backlog tasks can't be claimed (POST /tasks/:id/claim 409s "backlog"
      // out); the Assignee "me" option is disabled while status is backlog,
      // so this should be unreachable, but guard the call itself too.
      if (assignee === "me" && status !== "backlog") {
        try {
          task = await claimTask(task.id);
        } catch (claimError) {
          assignmentError = `Self-assignment failed: ${(claimError as Error).message}`;
        }
      }

      // Notify parent to add the task to its list immediately.
      onTaskCreated(task);

      if (confidence) {
        setCreatedTaskId(task.id);
        setCreatedAssignmentError(assignmentError);
        setCreatedConfidence(confidence);
      } else {
        if (assignmentError) toast(assignmentError, "error");
        onClose();
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setCreating(false);
    }
  }

  function handleEditTask() {
    const id = createdTaskId;
    onClose();
    if (id) onEditTask(id);
  }

  function applyPreset(preset: TemplatePreset) {
    if (preset.description !== undefined) setDescription(preset.description);
    if (preset.goal !== undefined) setGoal(preset.goal);
    if (preset.acceptanceCriteria !== undefined) setAcceptanceCriteria(preset.acceptanceCriteria);
    if (preset.context !== undefined) setContext(preset.context);
    if (preset.constraints !== undefined) setConstraints(preset.constraints);
    if (preset.scope !== undefined) setScope(preset.scope);
    if (preset.outOfScope !== undefined) setOutOfScope(preset.outOfScope);
    if (preset.dependencies !== undefined) setDependencies(preset.dependencies);
    if (preset.risk !== undefined) setRisk(preset.risk);
    if (preset.agentPrompt !== undefined) setAgentPrompt(preset.agentPrompt);
    if (preset.taskType !== undefined) setTaskType(preset.taskType);
  }

  // ── Confidence badge shown in the collapsible header ──────────
  const templateHeaderBadge = templateFields ? (
    <ConfidenceBadge score={confidenceScore} size="sm" tabIndex={-1} />
  ) : null;

  // ── Modal body: confidence panel or form ──────────────────────
  const body = createdConfidence ? (
    <CreateConfidencePanel
      confidence={createdConfidence}
      enforcementMode={enforcementMode}
      status={status}
      assignmentError={createdAssignmentError}
      onEdit={handleEditTask}
      onClose={onClose}
    />
  ) : (
    <form id="ntm-form" onSubmit={(e) => void handleSubmit(e)}>
      <div className="ntm-form-body">
        {/* Title */}
        <div className="ntm-field-wrap">
          <FormField label="Title">
            <input
              className="ntm-w-full"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </FormField>
        </div>

        {/* Description */}
        <div className="ntm-field-wrap">
          <FormField label="Description">
            <textarea
              className="ntm-w-full ntm-resizable"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </FormField>
        </div>

        {/* Status / Priority / Due */}
        <div className="new-task-grid new-task-grid--gapped">
          <FormField label="Status">
            <Select
              className="ntm-w-full"
              value={status}
              onChange={(v) => {
                const next = v as CreateStatus;
                setStatus(next);
                // Review round 1 fix (task 31528564): a stale "me" pick from
                // Open would otherwise survive the switch to Backlog -- the
                // trigger is disabled and keeps showing "Assign to me" while
                // submit silently creates the task unassigned. Reset it here
                // so the visible state matches what will actually happen;
                // handleSubmit's own `status !== "backlog"` guard stays as
                // defense in depth regardless.
                if (next === "backlog") setAssignee("unassigned");
              }}
              options={[
                { value: "backlog", label: "Backlog" },
                { value: "open", label: "Open" },
              ]}
            />
          </FormField>
          <FormField label="Priority">
            <Select
              className="ntm-w-full"
              value={priority}
              onChange={(v) => setPriority(v as Priority)}
              options={[
                { value: "LOW", label: "LOW" },
                { value: "MEDIUM", label: "MEDIUM" },
                { value: "HIGH", label: "HIGH" },
                { value: "CRITICAL", label: "CRITICAL" },
              ]}
            />
          </FormField>
          <FormField label="Due Date">
            <input
              className="ntm-w-full"
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </FormField>
        </div>

        {/* Assignee -- "me" is disabled while status is backlog: claiming a
            backlog task 409s server-side (POST /tasks/:id/claim rejects
            "backlog"), so this guard keeps the post-create claim call from
            ever firing on one. */}
        <div className="ntm-assignee-wrap">
          <FormField
            label="Assignee"
            hint={
              status === "backlog"
                ? "Backlog tasks can't be claimed until they're promoted to Open."
                : undefined
            }
          >
            <Select
              className="ntm-w-full"
              value={assignee}
              onChange={(v) => setAssignee(v as "unassigned" | "me")}
              disabled={status === "backlog"}
              options={[
                { value: "unassigned", label: "Unassigned" },
                { value: "me", label: "Assign to me" },
              ]}
            />
          </FormField>
        </div>

        {/* Agent template: collapsible, collapsed by default */}
        {templateFields && (
          <div className="ntm-template-section">
            <CollapsibleSection
              title="Agent Template"
              defaultOpen={false}
              headerExtra={templateHeaderBadge}
            >
              {templatePresets.length > 0 && (
                <div className="ntm-preset-row">
                  {templatePresets.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className="filter-chip"
                      onClick={() => applyPreset(preset)}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              )}

              {templateFields.goal && (
                <div className="ntm-field-wrap">
                  <FormField label="Goal">
                    <textarea
                      className="ntm-w-full ntm-resizable"
                      value={goal}
                      onChange={(e) => setGoal(e.target.value)}
                      rows={2}
                      placeholder="What should be achieved?"
                    />
                  </FormField>
                </div>
              )}
              {templateFields.acceptanceCriteria && (
                <div className="ntm-field-wrap">
                  <FormField label="Acceptance Criteria">
                    <textarea
                      className="ntm-w-full ntm-resizable"
                      value={acceptanceCriteria}
                      onChange={(e) => setAcceptanceCriteria(e.target.value)}
                      rows={3}
                      placeholder="When is this task done?"
                    />
                  </FormField>
                </div>
              )}
              {templateFields.context && (
                <div className="ntm-field-wrap">
                  <FormField label="Context">
                    <textarea
                      className="ntm-w-full ntm-resizable"
                      value={context}
                      onChange={(e) => setContext(e.target.value)}
                      rows={2}
                      placeholder="Relevant files, links, dependencies…"
                    />
                  </FormField>
                </div>
              )}
              {templateFields.constraints && (
                <div className="ntm-field-wrap">
                  <FormField label="Constraints">
                    <textarea
                      className="ntm-w-full ntm-resizable"
                      value={constraints}
                      onChange={(e) => setConstraints(e.target.value)}
                      rows={2}
                      placeholder="What must not happen?"
                    />
                  </FormField>
                </div>
              )}
              {templateFields.scope && (
                <div className="ntm-field-wrap">
                  <FormField label="Scope">
                    <textarea
                      className="ntm-w-full ntm-resizable"
                      value={scope}
                      onChange={(e) => setScope(e.target.value)}
                      rows={2}
                      placeholder="Files, modules, or surfaces this may touch"
                    />
                  </FormField>
                </div>
              )}
              {templateFields.outOfScope && (
                <div className="ntm-field-wrap">
                  <FormField label="Out of Scope">
                    <textarea
                      className="ntm-w-full ntm-resizable"
                      value={outOfScope}
                      onChange={(e) => setOutOfScope(e.target.value)}
                      rows={2}
                      placeholder="What must NOT change"
                    />
                  </FormField>
                </div>
              )}
              {templateFields.dependencies && (
                <div className="ntm-field-wrap">
                  <FormField label="Dependencies">
                    <textarea
                      className="ntm-w-full ntm-resizable"
                      value={dependencies}
                      onChange={(e) => setDependencies(e.target.value)}
                      rows={2}
                      placeholder="Prerequisite work, or 'none'"
                    />
                  </FormField>
                </div>
              )}
              {templateFields.risk && (
                <div className="ntm-field-wrap">
                  <FormField label="Risk">
                    <textarea
                      className="ntm-w-full ntm-resizable"
                      value={risk}
                      onChange={(e) => setRisk(e.target.value)}
                      rows={2}
                      placeholder="Risk / blast radius (low / medium / high, and why)"
                    />
                  </FormField>
                </div>
              )}
              {templateFields.agentPrompt && (
                <div className="ntm-field-wrap">
                  <FormField label="Agent Prompt">
                    <textarea
                      className="ntm-w-full ntm-resizable ntm-mono-area"
                      value={agentPrompt}
                      onChange={(e) => setAgentPrompt(e.target.value)}
                      rows={4}
                      placeholder="Step-by-step instructions a weak agent can execute verbatim"
                    />
                  </FormField>
                </div>
              )}
              <div className="ntm-field-wrap">
                <FormField label="Task Type">
                  <Select
                    className="ntm-w-full"
                    value={taskType}
                    onChange={(v) => setTaskType(v as TaskType | "")}
                    options={[{ value: "", label: "— none —" }, ...TASK_TYPES.map((t) => ({ value: t, label: t }))]}
                    ariaLabel="Task type"
                  />
                </FormField>
              </div>
            </CollapsibleSection>
          </div>
        )}
      </div>
    </form>
  );

  // Footer: submit button pinned in the Modal footer slot.
  // Hidden in the confidence-panel view (that view has its own action buttons).
  const footer = createdConfidence ? undefined : (
    <Button
      type="submit"
      form="ntm-form"
      disabled={creating}
      loading={creating}
      size="sm"
    >
      {creating ? "Creating…" : "Create task"}
    </Button>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={createdConfidence ? "Task created" : "New Task"}
      footer={footer}
    >
      {body}
    </Modal>
  );
}
