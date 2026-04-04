"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeams,
  getProjects,
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  claimTask,
  releaseTask,
  updateProject,
  type User,
  type Team,
  type Project,
  type Task,
  type TaskTemplate,
  type TemplateData,
  type TemplatePreset,
} from "../../lib/api";
import { calculateConfidence } from "../../lib/confidence";
import AppHeader from "../../components/AppHeader";
import ConfidenceBadge from "../../components/ConfidenceBadge";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import DropdownMenu from "../../components/ui/DropdownMenu";
import EmptyState from "../../components/ui/EmptyState";
import FormField from "../../components/ui/FormField";
import Modal from "../../components/ui/Modal";
import Pagination from "../../components/ui/Pagination";

const STATUSES = ["open", "in_progress", "review", "done"] as const;
type Status = (typeof STATUSES)[number];

type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type ListSort = "updated_desc" | "priority_desc" | "due_asc" | "title_asc";

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

const PRIORITY_RANK: Record<Priority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};
const LIST_PAGE_SIZE = 12;

function isOverdue(task: Task): boolean {
  if (!task.dueAt || task.status === "done") return false;
  return new Date(task.dueAt).getTime() < Date.now();
}

function sortTasksForBoardColumn(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const overdueDiff = Number(isOverdue(b)) - Number(isOverdue(a));
    if (overdueDiff !== 0) return overdueDiff;

    const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (priorityDiff !== 0) return priorityDiff;

    if (a.dueAt || b.dueAt) {
      const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
      const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue - bDue;
    }

    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function toDateInputValue(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function toIsoDateOrNull(value: string): string | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00`).toISOString();
}

function updateUrl(teamId: string, projectId?: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("teamId", teamId);
  if (projectId) {
    url.searchParams.set("projectId", projectId);
  } else {
    url.searchParams.delete("projectId");
  }
  window.history.replaceState({}, "", url.toString());
}

function getTeamProjectStorageKey(teamId: string): string {
  return `dashboard:lastProject:${teamId}`;
}

function readStoredProjectId(teamId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(getTeamProjectStorageKey(teamId));
  } catch {
    return null;
  }
}

function storeProjectId(teamId: string, projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(getTeamProjectStorageKey(teamId), projectId);
  } catch {
    // No-op for blocked storage contexts.
  }
}

function getAssigneeName(task: Task): string {
  if (task.claimedByUser) return task.claimedByUser.name ?? task.claimedByUser.login;
  if (task.claimedByAgent) return `Agent ${task.claimedByAgent.name}`;
  return "Unassigned";
}

function getClaimLabel(task: Task): string {
  if (!task.claimedByUserId && !task.claimedByAgentId) return "Unassigned";
  return `Assignee: ${getAssigneeName(task)}`;
}

function TaskCard({
  task,
  active,
  onSelect,
}: {
  task: Task;
  active: boolean;
  onSelect: (taskId: string) => void;
}) {
  return (
    <button
      className="task-card"
      type="button"
      onClick={() => onSelect(task.id)}
      style={{
        width: "100%",
        textAlign: "left",
        background: active ? "#202b3d" : "var(--surface)",
        border: `1px solid ${active ? "#30435f" : "var(--border)"}`,
        borderRadius: "10px",
        padding: "0.75rem",
        marginBottom: "0.5rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", marginBottom: "0.25rem" }}>
        <p style={{ fontWeight: 600, fontSize: "var(--text-base)", lineHeight: 1.35, color: "var(--text)" }}>{task.title}</p>
        <span
          style={{
            width: "9px",
            height: "9px",
            borderRadius: "50%",
            background: PRIORITY_COLORS[task.priority],
            flexShrink: 0,
            marginTop: "4px",
          }}
          title={task.priority}
        />
      </div>
      {task.description && (
        <p
          style={{
            color: "var(--muted)",
            fontSize: "var(--text-xs)",
            lineHeight: 1.35,
            marginBottom: "0.35rem",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {task.description}
        </p>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
          <span className="status-chip" style={{ color: PRIORITY_COLORS[task.priority] }}>{task.priority}</span>
          <ConfidenceBadge score={calculateConfidence({ title: task.title, description: task.description, templateData: task.templateData }).score} />
          {isOverdue(task) && (
            <span className="status-chip" style={{ color: "var(--danger)", borderColor: "color-mix(in srgb, var(--danger) 55%, var(--border) 45%)" }}>
              Overdue
            </span>
          )}
        </div>
        <div style={{ textAlign: "right", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
          <div>{getAssigneeName(task)}</div>
          <div>{task.dueAt ? `Due ${toDateInputValue(task.dueAt)}` : "No due date"}</div>
        </div>
      </div>
    </button>
  );
}

function BoardColumns({
  tasks,
  activeTaskId,
  onSelectTask,
}: {
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}) {
  return (
    <div className="board-columns" style={{ alignItems: "start" }}>
      {STATUSES.map((status) => {
        const columnTasks = sortTasksForBoardColumn(tasks.filter((task) => task.status === status));
        return (
          <section key={status}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
              <h3 style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>
                {STATUS_LABELS[status]}
              </h3>
              <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>{columnTasks.length}</span>
            </div>
            {columnTasks.length === 0 ? (
              <div style={{ border: "1px dashed var(--border)", borderRadius: "10px", padding: "1rem", color: "var(--muted)", textAlign: "center", fontSize: "var(--text-xs)" }}>
                No tasks
              </div>
            ) : (
              columnTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  active={task.id === activeTaskId}
                  onSelect={onSelectTask}
                />
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [tasks, setTasks] = useState<Task[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showNewTask, setShowNewTask] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDescription, setNewTaskDescription] = useState("");
  const [newTaskStatus, setNewTaskStatus] = useState<Status>("open");
  const [newTaskPriority, setNewTaskPriority] = useState<Priority>("MEDIUM");
  const [newTaskDueAt, setNewTaskDueAt] = useState("");
  const [newTaskAssignee, setNewTaskAssignee] = useState<"unassigned" | "me">("unassigned");
  const [newTaskGoal, setNewTaskGoal] = useState("");
  const [newTaskAcceptanceCriteria, setNewTaskAcceptanceCriteria] = useState("");
  const [newTaskContext, setNewTaskContext] = useState("");
  const [newTaskConstraints, setNewTaskConstraints] = useState("");
  const [taskQuery, setTaskQuery] = useState("");
  const [taskScope, setTaskScope] = useState<"all" | "mine" | "overdue" | "unassigned">("all");
  const [hideDone, setHideDone] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"board" | "list">("board");
  const [listSort, setListSort] = useState<ListSort>("updated_desc");
  const [listPage, setListPage] = useState(1);
  const projectTriggerRef = useRef<HTMLButtonElement | null>(null);
  const selectedTeam = useMemo(
    () => teams.find((team) => team.id === selectedTeamId) ?? null,
    [teams, selectedTeamId],
  );

  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const activeTask = useMemo(
    () => tasks.find((task) => task.id === activeTaskId) ?? null,
    [tasks, activeTaskId],
  );
  const filteredTasks = useMemo(() => {
    const normalizedQuery = taskQuery.trim().toLowerCase();

    return tasks.filter((task) => {
      if (hideDone && task.status === "done") return false;
      if (taskScope === "mine" && task.claimedByUserId !== user?.id) return false;
      if (taskScope === "unassigned" && (task.claimedByUserId || task.claimedByAgentId)) return false;
      if (taskScope === "overdue" && !isOverdue(task)) return false;
      if (!normalizedQuery) return true;
      return `${task.title} ${task.description ?? ""}`.toLowerCase().includes(normalizedQuery);
    });
  }, [tasks, taskQuery, taskScope, hideDone, user?.id]);

  const statusSummary = useMemo(() => {
    return STATUSES.reduce<Record<Status, number>>((acc, status) => {
      acc[status] = filteredTasks.filter((task) => task.status === status).length;
      return acc;
    }, { open: 0, in_progress: 0, review: 0, done: 0 });
  }, [filteredTasks]);
  const hasActiveFilters = taskQuery.trim().length > 0 || taskScope !== "all" || hideDone;

  const listSortedTasks = useMemo(() => {
    return [...filteredTasks].sort((a, b) => {
      if (listSort === "title_asc") return a.title.localeCompare(b.title);

      if (listSort === "priority_desc") {
        const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
      }

      if (listSort === "due_asc") {
        const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
        const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
        if (aDue !== bDue) return aDue - bDue;
      }

      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [filteredTasks, listSort]);

  const listTotalPages = Math.max(1, Math.ceil(listSortedTasks.length / LIST_PAGE_SIZE));
  const currentListPage = Math.min(listPage, listTotalPages);
  const listPageTasks = useMemo(() => {
    const start = (currentListPage - 1) * LIST_PAGE_SIZE;
    return listSortedTasks.slice(start, start + LIST_PAGE_SIZE);
  }, [currentListPage, listSortedTasks]);

  const [savingTask, setSavingTask] = useState(false);
  const [deletingTask, setDeletingTask] = useState(false);
  const [showDeleteTaskConfirm, setShowDeleteTaskConfirm] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);

  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState<Priority>("MEDIUM");
  const [editStatus, setEditStatus] = useState<Status>("open");
  const [editDueAt, setEditDueAt] = useState("");
  const [editGoal, setEditGoal] = useState("");
  const [editAcceptanceCriteria, setEditAcceptanceCriteria] = useState("");
  const [editContext, setEditContext] = useState("");
  const [editConstraints, setEditConstraints] = useState("");

  // Project settings modal
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [settingsTemplateEnabled, setSettingsTemplateEnabled] = useState(false);
  const [settingsThreshold, setSettingsThreshold] = useState(60);
  const [settingsFieldGoal, setSettingsFieldGoal] = useState(true);
  const [settingsFieldAC, setSettingsFieldAC] = useState(true);
  const [settingsFieldContext, setSettingsFieldContext] = useState(true);
  const [settingsFieldConstraints, setSettingsFieldConstraints] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsPresets, setSettingsPresets] = useState<TemplatePreset[]>([]);

  function closeNewTaskModal() {
    setShowNewTask(false);
    setNewTaskTitle("");
    setNewTaskDescription("");
    setNewTaskStatus("open");
    setNewTaskPriority("MEDIUM");
    setNewTaskDueAt("");
    setNewTaskAssignee("unassigned");
    setNewTaskGoal("");
    setNewTaskAcceptanceCriteria("");
    setNewTaskContext("");
    setNewTaskConstraints("");
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const templateFields = selectedProject?.taskTemplate?.fields ?? null;

  useEffect(() => {
    void (async () => {
      try {
        const me = await getCurrentUser();
        if (!me) {
          router.replace("/auth");
          return;
        }
        setUser(me);

        const userTeams = await getTeams();
        setTeams(userTeams);
        if (userTeams.length === 0) {
          router.replace("/onboarding");
          return;
        }

        const params = new URLSearchParams(window.location.search);
        const requestedTeamId = params.get("teamId");
        const requestedProjectId = params.get("projectId");

        const resolvedTeam =
          userTeams.find((team) => team.id === requestedTeamId) ?? userTeams[0]!;
        setSelectedTeamId(resolvedTeam.id);

        const teamProjects = await getProjects(resolvedTeam.id);
        setProjects(teamProjects);

        if (teamProjects.length === 0) {
          setSelectedProjectId("");
          setTasks([]);
          updateUrl(resolvedTeam.id);
          setLoading(false);
          return;
        }

        const storedProjectId = readStoredProjectId(resolvedTeam.id);
        const preferredProjectId = requestedProjectId ?? storedProjectId;
        const resolvedProject =
          teamProjects.find((project) => project.id === preferredProjectId) ?? teamProjects[0]!;
        setSelectedProjectId(resolvedProject.id);
        storeProjectId(resolvedTeam.id, resolvedProject.id);

        const projectTasks = await getTasks(resolvedProject.id);
        setTasks(projectTasks);
        setActiveTaskId(null);

        updateUrl(resolvedTeam.id, resolvedProject.id);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  useEffect(() => {
    if (!activeTask) return;
    setEditTitle(activeTask.title);
    setEditDescription(activeTask.description ?? "");
    setEditPriority(activeTask.priority);
    setEditStatus(activeTask.status as Status);
    setEditDueAt(toDateInputValue(activeTask.dueAt));
    setEditGoal(activeTask.templateData?.goal ?? "");
    setEditAcceptanceCriteria(activeTask.templateData?.acceptanceCriteria ?? "");
    setEditContext(activeTask.templateData?.context ?? "");
    setEditConstraints(activeTask.templateData?.constraints ?? "");
  }, [activeTask]);

  useEffect(() => {
    if (!activeTask) setShowDeleteTaskConfirm(false);
  }, [activeTask]);

  useEffect(() => {
    setListPage(1);
  }, [selectedProjectId, taskQuery, taskScope, hideDone, listSort, viewMode]);

  async function handleProjectChange(projectId: string) {
    if (!selectedTeamId) return;
    setSelectedProjectId(projectId);
    setError(null);
    setLoading(true);
    try {
      const projectTasks = await getTasks(projectId);
      setTasks(projectTasks);
      setActiveTaskId(null);
      storeProjectId(selectedTeamId, projectId);
      updateUrl(selectedTeamId, projectId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProjectId || !newTaskTitle.trim()) return;

    setCreatingTask(true);
    setError(null);
    try {
      const tplData: TemplateData = {};
      if (newTaskGoal.trim()) tplData.goal = newTaskGoal.trim();
      if (newTaskAcceptanceCriteria.trim()) tplData.acceptanceCriteria = newTaskAcceptanceCriteria.trim();
      if (newTaskContext.trim()) tplData.context = newTaskContext.trim();
      if (newTaskConstraints.trim()) tplData.constraints = newTaskConstraints.trim();
      const hasTemplateData = Object.keys(tplData).length > 0;

      let task = await createTask(selectedProjectId, {
        title: newTaskTitle.trim(),
        description: newTaskDescription.trim() || undefined,
        status: newTaskStatus,
        priority: newTaskPriority,
        dueAt: toIsoDateOrNull(newTaskDueAt) ?? undefined,
        ...(hasTemplateData ? { templateData: tplData } : {}),
      });

      if (newTaskAssignee === "me") {
        try {
          task = await claimTask(task.id);
        } catch (claimError) {
          setError(`Task created, but assignment failed: ${(claimError as Error).message}`);
        }
      }

      setTasks((prev) => [task, ...prev]);
      setActiveTaskId(null);
      closeNewTaskModal();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingTask(false);
    }
  }

  async function handleSaveTask() {
    if (!activeTask) return;
    setSavingTask(true);
    setError(null);
    try {
      const editTplData: TemplateData = {};
      if (editGoal.trim()) editTplData.goal = editGoal.trim();
      if (editAcceptanceCriteria.trim()) editTplData.acceptanceCriteria = editAcceptanceCriteria.trim();
      if (editContext.trim()) editTplData.context = editContext.trim();
      if (editConstraints.trim()) editTplData.constraints = editConstraints.trim();

      const updated = await updateTask(activeTask.id, {
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        priority: editPriority,
        status: editStatus,
        dueAt: toIsoDateOrNull(editDueAt),
        templateData: Object.keys(editTplData).length > 0 ? editTplData : null,
      });
      setTasks((prev) => prev.map((task) => (task.id === updated.id ? updated : task)));
      setActiveTaskId(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingTask(false);
    }
  }

  async function handleDeleteTask() {
    if (!activeTask) return;
    setDeletingTask(true);
    setError(null);
    try {
      await deleteTask(activeTask.id);
      setTasks((prev) => prev.filter((task) => task.id !== activeTask.id));
      setActiveTaskId(null);
      setShowDeleteTaskConfirm(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingTask(false);
    }
  }

  async function handleClaimActiveTask() {
    if (!activeTask) return;
    setClaimBusy(true);
    setError(null);
    try {
      const updated = await claimTask(activeTask.id);
      setTasks((prev) => prev.map((task) => (task.id === updated.id ? updated : task)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClaimBusy(false);
    }
  }

  async function handleReleaseActiveTask() {
    if (!activeTask) return;
    setClaimBusy(true);
    setError(null);
    try {
      const updated = await releaseTask(activeTask.id);
      setTasks((prev) => prev.map((task) => (task.id === updated.id ? updated : task)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClaimBusy(false);
    }
  }

  return (
    <main className="page-shell">
      <AppHeader
        user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null}
        boardHref={selectedTeamId && selectedProjectId ? `/dashboard?teamId=${selectedTeamId}&projectId=${selectedProjectId}` : "/dashboard"}
      />

      <section
        className="dashboard-select-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(220px, 360px) auto",
          gap: "0.6rem",
          marginBottom: "1rem",
          alignItems: "end",
        }}
      >
        <div className="project-select-wrap">
          <FormField label="Project">
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
            <button
              ref={projectTriggerRef}
              type="button"
              disabled={loading || !selectedTeamId || projects.length === 0}
              onClick={() => setProjectMenuOpen((value) => !value)}
              style={{
                width: "100%",
                background: "var(--surface)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: "8px",
                padding: "0.5rem 0.75rem",
                textAlign: "left",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.5rem",
                opacity: loading || !selectedTeamId || projects.length === 0 ? 0.7 : 1,
              }}
              aria-haspopup="menu"
              aria-expanded={projectMenuOpen}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {projects.find((project) => project.id === selectedProjectId)?.name ?? "Select a project"}
              </span>
              <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>{projectMenuOpen ? "▲" : "▼"}</span>
            </button>
            {selectedProjectId && (
              <>
              <Link
                href={`/projects/workflows?projectId=${selectedProjectId}`}
                className="project-settings-icon"
                aria-label="Workflow settings"
                title="Workflow settings"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="2.5" />
                  <path d="M6.83 2.17a.5.5 0 0 1 .49-.4h1.36a.5.5 0 0 1 .49.4l.2 1.1a4.5 4.5 0 0 1 1.09.63l1.05-.35a.5.5 0 0 1 .58.2l.68 1.18a.5.5 0 0 1-.1.6l-.84.75a4.5 4.5 0 0 1 0 1.26l.84.75a.5.5 0 0 1 .1.6l-.68 1.18a.5.5 0 0 1-.58.2l-1.05-.35a4.5 4.5 0 0 1-1.09.63l-.2 1.1a.5.5 0 0 1-.49.4H7.32a.5.5 0 0 1-.49-.4l-.2-1.1a4.5 4.5 0 0 1-1.09-.63l-1.05.35a.5.5 0 0 1-.58-.2l-.68-1.18a.5.5 0 0 1 .1-.6l.84-.75a4.5 4.5 0 0 1 0-1.26l-.84-.75a.5.5 0 0 1-.1-.6l.68-1.18a.5.5 0 0 1 .58-.2l1.05.35a4.5 4.5 0 0 1 1.09-.63l.2-1.1z" />
                </svg>
              </Link>
              <button
                type="button"
                className="project-settings-icon"
                aria-label="Template settings"
                title="Agent template & confidence settings"
                onClick={() => {
                  const proj = projects.find((p) => p.id === selectedProjectId);
                  const tpl = proj?.taskTemplate;
                  setSettingsTemplateEnabled(!!tpl);
                  setSettingsThreshold(proj?.confidenceThreshold ?? 60);
                  setSettingsFieldGoal(tpl?.fields?.goal ?? true);
                  setSettingsFieldAC(tpl?.fields?.acceptanceCriteria ?? true);
                  setSettingsFieldContext(tpl?.fields?.context ?? true);
                  setSettingsFieldConstraints(tpl?.fields?.constraints ?? true);
                  setSettingsPresets(tpl?.presets ? [...tpl.presets] : []);
                  setShowProjectSettings(true);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                  <path d="M5 6h6M5 8h4M5 10h5" />
                </svg>
              </button>
              </>
            )}
            </div>
          </FormField>
          <DropdownMenu
            anchorRef={projectTriggerRef}
            open={projectMenuOpen}
            onClose={() => setProjectMenuOpen(false)}
            align="start"
            minWidth={220}
            className="project-picker-menu"
          >
            <div role="menu" className="menu-scroll" style={{ maxHeight: "300px" }}>
              {projects.map((project) => {
                const active = project.id === selectedProjectId;
                return (
                  <button
                    key={project.id}
                    type="button"
                    role="menuitem"
                    className={`menu-option ${active ? "menu-option-active" : ""}`}
                    onClick={() => {
                      setProjectMenuOpen(false);
                      if (project.id !== selectedProjectId) {
                        void handleProjectChange(project.id);
                      }
                    }}
                    title={project.name}
                  >
                    {project.name}
                  </button>
                );
              })}
            </div>
          </DropdownMenu>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "end", gap: "0.5rem", flexWrap: "wrap" }}>
          <div>
            <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.25rem" }}>View</p>
            <div className="view-toggle" aria-label="Task view mode">
              <button
                type="button"
                className={viewMode === "board" ? "view-toggle-active" : ""}
                aria-pressed={viewMode === "board"}
                onClick={() => setViewMode("board")}
              >
                Board view
              </button>
              <button
                type="button"
                className={viewMode === "list" ? "view-toggle-active" : ""}
                aria-pressed={viewMode === "list"}
                onClick={() => setViewMode("list")}
              >
                List view
              </button>
            </div>
          </div>
          <Button
            onClick={() => {
              setError(null);
              setShowNewTask(true);
            }}
            disabled={!selectedProjectId}
          >
            + New Task
          </Button>
        </div>
      </section>

      <Modal open={showNewTask} onClose={closeNewTaskModal} title="New Task">
        <form onSubmit={(e) => void handleCreateTask(e)}>
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ marginBottom: "0.5rem" }}>
              <FormField label="Title">
                <input value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} required style={{ width: "100%" }} />
              </FormField>
            </div>

            <div style={{ marginBottom: "0.5rem" }}>
              <FormField label="Description">
                <textarea value={newTaskDescription} onChange={(e) => setNewTaskDescription(e.target.value)} rows={5} style={{ width: "100%", resize: "vertical" }} />
              </FormField>
            </div>

            <div className="new-task-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.5rem" }}>
              <FormField label="Status">
                <select value={newTaskStatus} onChange={(e) => setNewTaskStatus(e.target.value as Status)} style={{ width: "100%" }}>
                  {STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
                </select>
              </FormField>
              <FormField label="Priority">
                <select value={newTaskPriority} onChange={(e) => setNewTaskPriority(e.target.value as Priority)} style={{ width: "100%" }}>
                  <option value="LOW">LOW</option>
                  <option value="MEDIUM">MEDIUM</option>
                  <option value="HIGH">HIGH</option>
                  <option value="CRITICAL">CRITICAL</option>
                </select>
              </FormField>
              <FormField label="Due Date">
                <input type="date" value={newTaskDueAt} onChange={(e) => setNewTaskDueAt(e.target.value)} style={{ width: "100%" }} />
              </FormField>
            </div>
            <div style={{ marginTop: "0.5rem" }}>
              <FormField label="Assignee">
                <select
                  value={newTaskAssignee}
                  onChange={(e) => setNewTaskAssignee(e.target.value as "unassigned" | "me")}
                  style={{ width: "100%" }}
                >
                  <option value="unassigned">Unassigned</option>
                  <option value="me">Assign to me</option>
                </select>
              </FormField>
            </div>

            {templateFields && (
              <div style={{ marginTop: "0.75rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
                <p style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text)" }}>Agent Template</p>
                {(selectedProject?.taskTemplate?.presets?.length ?? 0) > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", marginBottom: "0.5rem" }}>
                    {selectedProject!.taskTemplate!.presets!.map((preset) => (
                      <button
                        key={preset.name}
                        type="button"
                        className="filter-chip"
                        onClick={() => {
                          if (preset.goal !== undefined) setNewTaskGoal(preset.goal);
                          if (preset.acceptanceCriteria !== undefined) setNewTaskAcceptanceCriteria(preset.acceptanceCriteria);
                          if (preset.context !== undefined) setNewTaskContext(preset.context);
                          if (preset.constraints !== undefined) setNewTaskConstraints(preset.constraints);
                        }}
                      >
                        {preset.name}
                      </button>
                    ))}
                  </div>
                )}
                {templateFields.goal && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Goal">
                      <textarea value={newTaskGoal} onChange={(e) => setNewTaskGoal(e.target.value)} rows={2} style={{ width: "100%", resize: "vertical" }} placeholder="What should be achieved?" />
                    </FormField>
                  </div>
                )}
                {templateFields.acceptanceCriteria && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Acceptance Criteria">
                      <textarea value={newTaskAcceptanceCriteria} onChange={(e) => setNewTaskAcceptanceCriteria(e.target.value)} rows={3} style={{ width: "100%", resize: "vertical" }} placeholder="When is this task done?" />
                    </FormField>
                  </div>
                )}
                {templateFields.context && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Context">
                      <textarea value={newTaskContext} onChange={(e) => setNewTaskContext(e.target.value)} rows={2} style={{ width: "100%", resize: "vertical" }} placeholder="Relevant files, links, dependencies…" />
                    </FormField>
                  </div>
                )}
                {templateFields.constraints && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Constraints">
                      <textarea value={newTaskConstraints} onChange={(e) => setNewTaskConstraints(e.target.value)} rows={2} style={{ width: "100%", resize: "vertical" }} placeholder="What must not happen?" />
                    </FormField>
                  </div>
                )}
                <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                  Confidence:{" "}
                  <ConfidenceBadge
                    score={calculateConfidence({
                      title: newTaskTitle,
                      description: newTaskDescription || null,
                      templateData: { goal: newTaskGoal || undefined, acceptanceCriteria: newTaskAcceptanceCriteria || undefined, context: newTaskContext || undefined, constraints: newTaskConstraints || undefined },
                    }).score}
                  />
                </div>
              </div>
            )}
          </div>

          <Button type="submit" disabled={creatingTask} loading={creatingTask} size="sm">
            {creatingTask ? "Creating…" : "Create task"}
          </Button>
        </form>
      </Modal>

      <Card padding="sm" style={{ marginBottom: "0.9rem" }}>
        {viewMode === "list" && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.65rem" }}>
            <select
              value={listSort}
              onChange={(e) => setListSort(e.target.value as ListSort)}
              style={{ minWidth: "210px" }}
            >
              <option value="updated_desc">Sort: Recently updated</option>
              <option value="priority_desc">Sort: Priority</option>
              <option value="due_asc">Sort: Due date</option>
              <option value="title_asc">Sort: Title A-Z</option>
            </select>
          </div>
        )}
        <div className="board-toolbar">
          <input
            value={taskQuery}
            onChange={(e) => setTaskQuery(e.target.value)}
            placeholder="Search tasks..."
            style={{ width: "100%" }}
          />
        </div>
        <div className="scope-chip-row">
          <button type="button" className={`filter-chip ${taskScope === "all" ? "filter-chip-active" : ""}`} onClick={() => setTaskScope("all")}>
            All tasks
          </button>
          <button type="button" className={`filter-chip ${taskScope === "mine" ? "filter-chip-active" : ""}`} onClick={() => setTaskScope("mine")}>
            Assigned to me
          </button>
          <button type="button" className={`filter-chip ${taskScope === "overdue" ? "filter-chip-active" : ""}`} onClick={() => setTaskScope("overdue")}>
            Overdue
          </button>
          <button type="button" className={`filter-chip ${taskScope === "unassigned" ? "filter-chip-active" : ""}`} onClick={() => setTaskScope("unassigned")}>
            Unassigned
          </button>
          <button type="button" className={`filter-chip ${hideDone ? "filter-chip-active" : ""}`} onClick={() => setHideDone((value) => !value)}>
            Hide done
          </button>
          {hasActiveFilters && (
            <button
              type="button"
              className="filter-chip filter-chip-clear"
              onClick={() => {
                setTaskQuery("");
                setTaskScope("all");
                setHideDone(false);
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        {viewMode === "list" && (
          <div className="status-summary">
            {STATUSES.map((status) => (
              <span key={status} className="status-chip">
                {STATUS_LABELS[status]}: {statusSummary[status]}
              </span>
            ))}
          </div>
        )}
      </Card>

      {loading ? (
        <div style={{ color: "var(--muted)", padding: "2rem", textAlign: "center" }}>Loading…</div>
      ) : error ? (
        <AlertBanner tone="danger" title="Error">
          {error}
        </AlertBanner>
      ) : !selectedTeamId ? (
        <EmptyState message="Select a team to continue." />
      ) : !selectedProjectId ? (
        <EmptyState message={`Select a project to view tasks for ${selectedTeam?.name ?? "this team"}.`} />
      ) : (
        <div className="dashboard-grid">
          <section style={{ minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem", gap: "0.5rem", flexWrap: "wrap" }}>
              <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
                {filteredTasks.length} / {tasks.length} Tasks
              </p>
              <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
                {projects.find((project) => project.id === selectedProjectId)?.name}
              </p>
            </div>
            {viewMode === "board" ? (
              <BoardColumns tasks={filteredTasks} activeTaskId={activeTaskId} onSelectTask={setActiveTaskId} />
            ) : (
              <div className="task-list-shell">
                <div className="task-list-head">
                  <span>Task</span>
                  <span>Assignee</span>
                  <span>Due</span>
                  <span>Priority</span>
                </div>
                {listPageTasks.length === 0 ? (
                  <div style={{ padding: "1rem", color: "var(--muted)", textAlign: "center" }}>No tasks in this list view.</div>
                ) : (
                  listPageTasks.map((task, index) => (
                    <button
                      key={task.id}
                      type="button"
                      className="task-list-row"
                      onClick={() => setActiveTaskId(task.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        border: "none",
                        background: "transparent",
                        color: "var(--text)",
                        padding: "0.72rem 0.78rem",
                        borderBottom: index < listPageTasks.length - 1 ? "1px solid var(--border)" : "none",
                      }}
                    >
                      <span className="task-list-cell-main">
                        <span style={{ display: "block", fontSize: "var(--text-sm)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {task.title}
                        </span>
                        <span style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                          {STATUS_LABELS[task.status as Status]}
                        </span>
                      </span>
                      <span className="task-list-cell-muted">
                        {getAssigneeName(task)}
                      </span>
                      <span className="task-list-cell-muted">
                        {task.dueAt ? toDateInputValue(task.dueAt) : "No due date"}
                      </span>
                      <span className="task-list-cell-priority">
                        <span className="status-chip" style={{ color: PRIORITY_COLORS[task.priority] }}>
                          {task.priority}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
            {viewMode === "list" && (
              <Pagination
                page={currentListPage}
                totalPages={listTotalPages}
                onPageChange={setListPage}
              />
            )}
          </section>
        </div>
      )}

      {activeTask && (
        <Modal
          open={Boolean(activeTask)}
          onClose={() => setActiveTaskId(null)}
          title="Task Details"
          actions={
            <Button
              onClick={() => void handleSaveTask()}
              disabled={savingTask || deletingTask}
              loading={savingTask}
              size="sm"
            >
              {savingTask ? "Saving…" : "Save changes"}
            </Button>
          }
        >
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "var(--space-3)" }}>
            <Button
              variant="outline-danger"
              size="sm"
              onClick={() => setShowDeleteTaskConfirm(true)}
              disabled={savingTask || deletingTask}
            >
              {deletingTask ? "Deleting…" : "Delete"}
            </Button>
          </div>

          <section style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Overview</p>
            <div style={{ marginBottom: "0.5rem" }}>
              <FormField label="Title">
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={{ width: "100%" }} />
              </FormField>
            </div>
            <FormField label="Description">
              <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={5} style={{ width: "100%", resize: "vertical" }} />
            </FormField>
          </section>

          <section style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Workflow</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem", marginBottom: "0.55rem" }}>
              <span className="status-chip">{STATUS_LABELS[activeTask.status as Status]}</span>
              <span className="status-chip">{activeTask.priority}</span>
              <span className="status-chip">{isOverdue(activeTask) ? "Overdue" : "On track"}</span>
            </div>
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

          {templateFields && (
            <section style={{ marginBottom: "0.8rem" }}>
              <p className="section-kicker">Agent Template</p>
              {(() => {
                const conf = calculateConfidence({
                  title: editTitle,
                  description: editDescription || null,
                  templateData: { goal: editGoal || undefined, acceptanceCriteria: editAcceptanceCriteria || undefined, context: editContext || undefined, constraints: editConstraints || undefined },
                });
                const threshold = selectedProject?.confidenceThreshold ?? 60;
                return (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
                      <ConfidenceBadge score={conf.score} size="md" />
                      {conf.score < threshold && (
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--danger)" }}>
                          Below threshold ({threshold}) — agents cannot claim this task
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
            </section>
          )}

          {(activeTask.branchName || activeTask.prUrl || activeTask.result) && (
            <section style={{ marginBottom: "0.8rem" }}>
              <p className="section-kicker">Agent Output</p>
              <div style={{ display: "grid", gap: "var(--space-2)" }}>
                {activeTask.branchName && (
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                    <span style={{ color: "var(--muted)", minWidth: "4rem" }}>Branch</span>
                    <code style={{ background: "var(--surface-secondary)", padding: "0.2rem 0.5rem", borderRadius: "var(--radius-sm)", fontSize: "var(--text-xs)", wordBreak: "break-all" }}>
                      {activeTask.branchName}
                    </code>
                  </div>
                )}
                {activeTask.prUrl && (
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                    <span style={{ color: "var(--muted)", minWidth: "4rem" }}>PR</span>
                    <a
                      href={activeTask.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: "var(--text-sm)" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {activeTask.prNumber ? `#${activeTask.prNumber}` : activeTask.prUrl}
                    </a>
                  </div>
                )}
                {activeTask.result && (
                  <div style={{ fontSize: "var(--text-sm)" }}>
                    <span style={{ color: "var(--muted)", display: "block", marginBottom: "var(--space-1)" }}>Result</span>
                    <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                      {activeTask.result}
                    </p>
                  </div>
                )}
              </div>
            </section>
          )}

          <section style={{ marginBottom: "0.8rem" }}>
            <p className="section-kicker">Ownership</p>
            <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.45rem 0.55rem", color: "var(--text)", fontSize: "var(--text-sm)", background: "color-mix(in srgb, var(--surface) 88%, #0b111d 12%)" }}>
              {getClaimLabel(activeTask)}
            </div>
            <div style={{ display: "flex", gap: "0.45rem", marginTop: "0.4rem", flexWrap: "wrap" }}>
              {!activeTask.claimedByUserId && !activeTask.claimedByAgentId && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleClaimActiveTask()}
                  disabled={claimBusy || savingTask || deletingTask}
                  loading={claimBusy}
                >
                  {claimBusy ? "Claiming…" : "Claim for me"}
                </Button>
              )}
              {activeTask.claimedByUserId === user?.id && (
                <Button
                  variant="outline-danger"
                  size="sm"
                  onClick={() => void handleReleaseActiveTask()}
                  disabled={claimBusy || savingTask || deletingTask}
                  loading={claimBusy}
                >
                  {claimBusy ? "Releasing…" : "Release"}
                </Button>
              )}
            </div>
          </section>
        </Modal>
      )}

      <ConfirmDialog
        open={showDeleteTaskConfirm && Boolean(activeTask)}
        title="Delete task?"
        message={activeTask ? `Task "${activeTask.title}" will be permanently removed.` : ""}
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

      <Modal open={showProjectSettings} onClose={() => setShowProjectSettings(false)} title="Agent Template Settings">
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "var(--text-sm)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={settingsTemplateEnabled}
              onChange={(e) => setSettingsTemplateEnabled(e.target.checked)}
            />
            Enable task template for this project
          </label>
        </div>

        {settingsTemplateEnabled && (
          <>
            <div style={{ marginBottom: "0.75rem" }}>
              <p style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "0.4rem" }}>Template Fields</p>
              <div style={{ display: "grid", gap: "0.3rem" }}>
                {([
                  ["goal", "Goal", settingsFieldGoal, setSettingsFieldGoal],
                  ["acceptanceCriteria", "Acceptance Criteria", settingsFieldAC, setSettingsFieldAC],
                  ["context", "Context", settingsFieldContext, setSettingsFieldContext],
                  ["constraints", "Constraints", settingsFieldConstraints, setSettingsFieldConstraints],
                ] as [string, string, boolean, (v: boolean) => void][]).map(([, label, checked, setter]) => (
                  <label key={label} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "var(--text-sm)", cursor: "pointer" }}>
                    <input type="checkbox" checked={checked} onChange={(e) => setter(e.target.checked)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: "0.75rem" }}>
              <FormField label={`Confidence Threshold: ${settingsThreshold}`}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={settingsThreshold}
                  onChange={(e) => setSettingsThreshold(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                  <span>0 (no gate)</span>
                  <span>100 (all fields required)</span>
                </div>
              </FormField>
            </div>

            <div style={{ marginBottom: "0.75rem" }}>
              <p style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "0.4rem" }}>Presets</p>
              <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "0.4rem" }}>
                Reusable starting points that pre-fill template fields when creating a task.
              </p>
              {settingsPresets.map((preset, idx) => (
                <div key={idx} style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.5rem", marginBottom: "0.4rem", background: "var(--surface)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                    <input
                      value={preset.name}
                      onChange={(e) => {
                        const next = [...settingsPresets];
                        next[idx] = { ...next[idx], name: e.target.value };
                        setSettingsPresets(next);
                      }}
                      placeholder="Preset name"
                      style={{ fontWeight: 600, fontSize: "var(--text-sm)", flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={() => setSettingsPresets(settingsPresets.filter((_, i) => i !== idx))}
                      style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: "var(--text-sm)", padding: "0 0.3rem" }}
                    >
                      Remove
                    </button>
                  </div>
                  <div style={{ display: "grid", gap: "0.3rem" }}>
                    {settingsFieldGoal && (
                      <textarea
                        value={preset.goal ?? ""}
                        onChange={(e) => { const next = [...settingsPresets]; next[idx] = { ...next[idx], goal: e.target.value }; setSettingsPresets(next); }}
                        placeholder="Goal"
                        rows={1}
                        style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }}
                      />
                    )}
                    {settingsFieldAC && (
                      <textarea
                        value={preset.acceptanceCriteria ?? ""}
                        onChange={(e) => { const next = [...settingsPresets]; next[idx] = { ...next[idx], acceptanceCriteria: e.target.value }; setSettingsPresets(next); }}
                        placeholder="Acceptance Criteria"
                        rows={1}
                        style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }}
                      />
                    )}
                    {settingsFieldContext && (
                      <textarea
                        value={preset.context ?? ""}
                        onChange={(e) => { const next = [...settingsPresets]; next[idx] = { ...next[idx], context: e.target.value }; setSettingsPresets(next); }}
                        placeholder="Context"
                        rows={1}
                        style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }}
                      />
                    )}
                    {settingsFieldConstraints && (
                      <textarea
                        value={preset.constraints ?? ""}
                        onChange={(e) => { const next = [...settingsPresets]; next[idx] = { ...next[idx], constraints: e.target.value }; setSettingsPresets(next); }}
                        placeholder="Constraints"
                        rows={1}
                        style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }}
                      />
                    )}
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="filter-chip"
                onClick={() => setSettingsPresets([...settingsPresets, { name: "" }])}
                style={{ marginTop: "0.2rem" }}
              >
                + Add preset
              </button>
            </div>
          </>
        )}

        <Button
          size="sm"
          disabled={savingSettings}
          loading={savingSettings}
          onClick={async () => {
            if (!selectedProjectId) return;
            setSavingSettings(true);
            setError(null);
            try {
              const validPresets = settingsPresets.filter((p) => p.name.trim());
              const tpl: TaskTemplate | null = settingsTemplateEnabled
                ? { fields: { goal: settingsFieldGoal, acceptanceCriteria: settingsFieldAC, context: settingsFieldContext, constraints: settingsFieldConstraints }, presets: validPresets }
                : null;
              const updated = await updateProject(selectedProjectId, {
                taskTemplate: tpl,
                confidenceThreshold: settingsThreshold,
              });
              setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
              setShowProjectSettings(false);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setSavingSettings(false);
            }
          }}
        >
          {savingSettings ? "Saving…" : "Save settings"}
        </Button>
      </Modal>
    </main>
  );
}
