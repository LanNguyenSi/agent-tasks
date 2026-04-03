"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  type User,
  type Team,
  type Project,
  type Task,
} from "../../lib/api";
import AppHeader from "../../components/AppHeader";
import AlertBanner from "../../components/ui/AlertBanner";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import DropdownMenu from "../../components/ui/DropdownMenu";

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
        <p style={{ fontWeight: 600, fontSize: "0.875rem", lineHeight: 1.35 }}>{task.title}</p>
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
            fontSize: "0.75rem",
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
          {isOverdue(task) && (
            <span className="status-chip" style={{ color: "var(--danger)", borderColor: "color-mix(in srgb, var(--danger) 55%, var(--border) 45%)" }}>
              Overdue
            </span>
          )}
        </div>
        <div style={{ textAlign: "right", fontSize: "0.72rem", color: "var(--muted)" }}>
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
    <div
      className="board-columns"
      style={{
        alignItems: "start",
      }}
    >
      {STATUSES.map((status) => {
        const columnTasks = sortTasksForBoardColumn(tasks.filter((task) => task.status === status));
        return (
          <section key={status}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
              <h3 style={{ fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>
                {STATUS_LABELS[status]}
              </h3>
              <span style={{ color: "var(--muted)", fontSize: "0.75rem" }}>{columnTasks.length}</span>
            </div>
            {columnTasks.length === 0 ? (
              <div style={{ border: "1px dashed var(--border)", borderRadius: "10px", padding: "1rem", color: "var(--muted)", textAlign: "center", fontSize: "0.75rem" }}>
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

  function closeNewTaskModal() {
    setShowNewTask(false);
    setNewTaskTitle("");
    setNewTaskDescription("");
    setNewTaskStatus("open");
    setNewTaskPriority("MEDIUM");
    setNewTaskDueAt("");
    setNewTaskAssignee("unassigned");
  }

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
  }, [activeTask]);

  useEffect(() => {
    if (!activeTask) setShowDeleteTaskConfirm(false);
  }, [activeTask]);

  useEffect(() => {
    setListPage(1);
  }, [selectedProjectId, taskQuery, taskScope, hideDone, listSort, viewMode]);

  async function handleTeamChange(teamId: string) {
    if (!teamId) return;
    setSelectedTeamId(teamId);
    setError(null);
    setProjectMenuOpen(false);
    setLoading(true);
    try {
      const teamProjects = await getProjects(teamId);
      setProjects(teamProjects);
      if (teamProjects.length === 0) {
        setSelectedProjectId("");
        setTasks([]);
        setActiveTaskId(null);
        updateUrl(teamId);
        return;
      }

      const storedProjectId = readStoredProjectId(teamId);
      const resolvedProject =
        teamProjects.find((project) => project.id === storedProjectId) ?? teamProjects[0]!;
      setSelectedProjectId(resolvedProject.id);
      storeProjectId(teamId, resolvedProject.id);

      const projectTasks = await getTasks(resolvedProject.id);
      setTasks(projectTasks);
      setActiveTaskId(null);
      updateUrl(teamId, resolvedProject.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

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
      let task = await createTask(selectedProjectId, {
        title: newTaskTitle.trim(),
        description: newTaskDescription.trim() || undefined,
        status: newTaskStatus,
        priority: newTaskPriority,
        dueAt: toIsoDateOrNull(newTaskDueAt) ?? undefined,
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
      const updated = await updateTask(activeTask.id, {
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        priority: editPriority,
        status: editStatus,
        dueAt: toIsoDateOrNull(editDueAt),
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
          gridTemplateColumns: "minmax(190px, 260px) minmax(220px, 360px) auto",
          gap: "0.6rem",
          marginBottom: "1rem",
          alignItems: "end",
        }}
      >
        <div>
          <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>Team</label>
          <select
            value={selectedTeamId}
            onChange={(event) => {
              void handleTeamChange(event.target.value);
            }}
            style={{ width: "100%" }}
            disabled={loading || teams.length === 0}
          >
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>

        <div className="project-select-wrap">
          <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>Project</label>
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
            <span style={{ color: "var(--muted)", fontSize: "0.72rem" }}>{projectMenuOpen ? "▲" : "▼"}</span>
          </button>
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
            <p style={{ color: "var(--muted)", fontSize: "0.7rem", marginBottom: "0.25rem" }}>View</p>
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
          <button
            type="button"
            onClick={() => {
              setError(null);
              setShowNewTask(true);
            }}
            disabled={!selectedProjectId}
            style={{
              background: "var(--primary)",
              color: "white",
              border: "none",
              borderRadius: "8px",
              padding: "0.5rem 0.85rem",
              fontWeight: 600,
              opacity: selectedProjectId ? 1 : 0.7,
            }}
          >
            + New Task
          </button>
        </div>
      </section>

      {showNewTask && (
        <div className="modal-overlay" onClick={closeNewTaskModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.7rem" }}>
              <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>New Task</h3>
              <button
                type="button"
                onClick={closeNewTaskModal}
                style={{ border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", borderRadius: "6px", padding: "0.2rem 0.5rem" }}
              >
                Close
              </button>
            </div>
            <form onSubmit={(e) => void handleCreateTask(e)}>
              <div style={{ marginBottom: "0.75rem" }}>
                  <div style={{ marginBottom: "0.5rem" }}>
                    <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.2rem" }}>Title</label>
                    <input value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} required style={{ width: "100%" }} />
                  </div>

                  <div style={{ marginBottom: "0.5rem" }}>
                    <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.2rem" }}>Description</label>
                    <textarea value={newTaskDescription} onChange={(e) => setNewTaskDescription(e.target.value)} rows={5} style={{ width: "100%", resize: "vertical" }} />
                  </div>

                  <div className="new-task-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.5rem" }}>
                    <div>
                      <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.2rem" }}>Status</label>
                      <select value={newTaskStatus} onChange={(e) => setNewTaskStatus(e.target.value as Status)} style={{ width: "100%" }}>
                        {STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.2rem" }}>Priority</label>
                      <select value={newTaskPriority} onChange={(e) => setNewTaskPriority(e.target.value as Priority)} style={{ width: "100%" }}>
                        <option value="LOW">LOW</option>
                        <option value="MEDIUM">MEDIUM</option>
                        <option value="HIGH">HIGH</option>
                        <option value="CRITICAL">CRITICAL</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.2rem" }}>Due Date</label>
                      <input type="date" value={newTaskDueAt} onChange={(e) => setNewTaskDueAt(e.target.value)} style={{ width: "100%" }} />
                    </div>
                  </div>
                  <div style={{ marginTop: "0.5rem" }}>
                    <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.2rem" }}>Assignee</label>
                    <select
                      value={newTaskAssignee}
                      onChange={(e) => setNewTaskAssignee(e.target.value as "unassigned" | "me")}
                      style={{ width: "100%" }}
                    >
                      <option value="unassigned">Unassigned</option>
                      <option value="me">Assign to me</option>
                    </select>
                  </div>
              </div>

              <button
                type="submit"
                disabled={creatingTask}
                style={{
                  background: "var(--primary)",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  padding: "0.45rem 0.85rem",
                  fontWeight: 600,
                }}
              >
                {creatingTask ? "Creating…" : "Create task"}
              </button>
            </form>
          </div>
        </div>
      )}

      <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "0.75rem", marginBottom: "0.9rem" }}>
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
        <div className="status-summary">
          {STATUSES.map((status) => (
            <span key={status} className="status-chip">
              {STATUS_LABELS[status]}: {statusSummary[status]}
            </span>
          ))}
        </div>
      </section>

      {loading ? (
        <div style={{ color: "var(--muted)", padding: "2rem", textAlign: "center" }}>Loading…</div>
      ) : error ? (
        <AlertBanner tone="danger" title="Error">
          {error}
        </AlertBanner>
      ) : !selectedTeamId ? (
        <div style={{ border: "1px dashed var(--border)", borderRadius: "10px", padding: "2rem", textAlign: "center", color: "var(--muted)" }}>
          Select a team to continue.
        </div>
      ) : !selectedProjectId ? (
        <div style={{ border: "1px dashed var(--border)", borderRadius: "10px", padding: "2rem", textAlign: "center", color: "var(--muted)" }}>
          Select a project to view tasks for {selectedTeam?.name ?? "this team"}.
        </div>
      ) : (
        <div className="dashboard-grid">
          <section style={{ minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem", gap: "0.5rem", flexWrap: "wrap" }}>
              <p style={{ color: "var(--muted)", fontSize: "0.82rem" }}>
                {filteredTasks.length} / {tasks.length} Tasks
              </p>
              <p style={{ color: "var(--muted)", fontSize: "0.82rem" }}>
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
                        <span style={{ display: "block", fontSize: "0.86rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {task.title}
                        </span>
                        <span style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)" }}>
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
            {viewMode === "list" && listTotalPages > 1 && (
              <div className="teams-pagination">
                <span>Page {currentListPage} of {listTotalPages}</span>
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  <button
                    type="button"
                    disabled={currentListPage <= 1}
                    onClick={() => setListPage((page) => Math.max(1, page - 1))}
                    style={{ border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: "6px", padding: "0.3rem 0.6rem", opacity: currentListPage <= 1 ? 0.5 : 1 }}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={currentListPage >= listTotalPages}
                    onClick={() => setListPage((page) => Math.min(listTotalPages, page + 1))}
                    style={{ border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: "6px", padding: "0.3rem 0.6rem", opacity: currentListPage >= listTotalPages ? 0.5 : 1 }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {activeTask && (
        <div className="modal-overlay" onClick={() => setActiveTaskId(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.7rem" }}>
              <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>Task Details</h3>
              <button
                type="button"
                onClick={() => setActiveTaskId(null)}
                style={{ border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", borderRadius: "6px", padding: "0.2rem 0.5rem" }}
              >
                Close
              </button>
            </div>

            <div>
              <section style={{ marginBottom: "0.8rem" }}>
                <p className="section-kicker">Overview</p>
                <div style={{ marginBottom: "0.5rem" }}>
                  <label style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Title</label>
                  <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={{ width: "100%" }} />
                </div>
                <div style={{ marginBottom: "0.3rem" }}>
                  <label style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Description</label>
                  <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={5} style={{ width: "100%", resize: "vertical" }} />
                </div>
              </section>

              <section style={{ marginBottom: "0.8rem" }}>
                <p className="section-kicker">Workflow</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem", marginBottom: "0.55rem" }}>
                  <span className="status-chip">{STATUS_LABELS[activeTask.status as Status]}</span>
                  <span className="status-chip">{activeTask.priority}</span>
                  <span className="status-chip">{isOverdue(activeTask) ? "Overdue" : "On track"}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem", marginBottom: "0.5rem" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Status</label>
                    <select value={editStatus} onChange={(e) => setEditStatus(e.target.value as Status)} style={{ width: "100%" }}>
                      {STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Priority</label>
                    <select value={editPriority} onChange={(e) => setEditPriority(e.target.value as Priority)} style={{ width: "100%" }}>
                      <option value="LOW">LOW</option>
                      <option value="MEDIUM">MEDIUM</option>
                      <option value="HIGH">HIGH</option>
                      <option value="CRITICAL">CRITICAL</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Due Date</label>
                  <input type="date" value={editDueAt} onChange={(e) => setEditDueAt(e.target.value)} style={{ width: "100%" }} />
                </div>
              </section>

              <section style={{ marginBottom: "0.8rem" }}>
                <p className="section-kicker">Ownership</p>
                <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.45rem 0.55rem", color: "var(--text)", fontSize: "0.84rem", background: "color-mix(in srgb, var(--surface) 88%, #0b111d 12%)" }}>
                  {getClaimLabel(activeTask)}
                </div>
                <div style={{ display: "flex", gap: "0.45rem", marginTop: "0.4rem", flexWrap: "wrap" }}>
                  {!activeTask.claimedByUserId && !activeTask.claimedByAgentId && (
                    <button
                      type="button"
                      onClick={() => void handleClaimActiveTask()}
                      disabled={claimBusy || savingTask || deletingTask}
                      style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "8px", padding: "0.35rem 0.6rem" }}
                    >
                      {claimBusy ? "Claiming…" : "Claim for me"}
                    </button>
                  )}
                  {activeTask.claimedByUserId === user?.id && (
                    <button
                      type="button"
                      onClick={() => void handleReleaseActiveTask()}
                      disabled={claimBusy || savingTask || deletingTask}
                      style={{ background: "transparent", color: "var(--warning)", border: "1px solid var(--warning)", borderRadius: "8px", padding: "0.35rem 0.6rem" }}
                    >
                      {claimBusy ? "Releasing…" : "Release"}
                    </button>
                  )}
                </div>
              </section>

              <div className="task-detail-actions" style={{ display: "flex", gap: "0.5rem", marginBottom: "0.4rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => void handleSaveTask()}
                  disabled={savingTask || deletingTask}
                  style={{ background: "var(--primary)", color: "white", border: "none", borderRadius: "8px", padding: "0.45rem 0.7rem", fontWeight: 600 }}
                >
                  {savingTask ? "Saving…" : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTaskId(null)}
                  disabled={savingTask || deletingTask}
                  style={{ background: "transparent", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: "8px", padding: "0.45rem 0.7rem" }}
                >
                  Close
                </button>
              </div>

              <button
                type="button"
                onClick={() => setShowDeleteTaskConfirm(true)}
                disabled={savingTask || deletingTask}
                style={{ background: "transparent", color: "var(--danger)", border: "1px solid var(--danger)", borderRadius: "8px", padding: "0.35rem 0.65rem", fontSize: "0.78rem" }}
              >
                {deletingTask ? "Deleting…" : "Delete task"}
              </button>
            </div>
          </div>
        </div>
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
    </main>
  );
}
