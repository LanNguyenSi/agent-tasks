"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeams,
  getProjects,
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  addTaskAttachment,
  deleteTaskAttachment,
  type User,
  type Team,
  type Project,
  type Task,
} from "../../lib/api";
import AppHeader from "../../components/AppHeader";

const STATUSES = ["open", "in_progress", "review", "done"] as const;
type Status = (typeof STATUSES)[number];

type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

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

function updateUrl(teamId: string, projectId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("teamId", teamId);
  url.searchParams.set("projectId", projectId);
  window.history.replaceState({}, "", url.toString());
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
      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", fontSize: "0.72rem" }}>
        <span>{task.attachments.length} attachments</span>
        <span>{task.dueAt ? `Due ${toDateInputValue(task.dueAt)}` : "No due date"}</span>
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
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(220px, 1fr))",
        gap: "0.9rem",
        overflowX: "auto",
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
  const [newTaskPriority, setNewTaskPriority] = useState<Priority>("MEDIUM");
  const [newTaskDueAt, setNewTaskDueAt] = useState("");
  const [taskQuery, setTaskQuery] = useState("");
  const [taskScope, setTaskScope] = useState<"all" | "mine" | "overdue" | "unassigned">("all");
  const [hideDone, setHideDone] = useState(false);

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

  const [savingTask, setSavingTask] = useState(false);
  const [deletingTask, setDeletingTask] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);

  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState<Priority>("MEDIUM");
  const [editStatus, setEditStatus] = useState<Status>("open");
  const [editDueAt, setEditDueAt] = useState("");

  const [attachmentName, setAttachmentName] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const me = await getCurrentUser();
        if (!me) {
          router.replace("/");
          return;
        }
        setUser(me);

        const userTeams = await getTeams();
        if (userTeams.length === 0) {
          router.replace("/onboarding");
          return;
        }
        setTeams(userTeams);

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
          setLoading(false);
          return;
        }

        const resolvedProject =
          teamProjects.find((project) => project.id === requestedProjectId) ?? teamProjects[0]!;
        setSelectedProjectId(resolvedProject.id);

        const projectTasks = await getTasks(resolvedProject.id);
        setTasks(projectTasks);
        setActiveTaskId(projectTasks[0]?.id ?? null);

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

  async function handleProjectChange(projectId: string) {
    if (!selectedTeamId) return;
    setSelectedProjectId(projectId);
    setError(null);
    setLoading(true);
    try {
      const projectTasks = await getTasks(projectId);
      setTasks(projectTasks);
      setActiveTaskId(projectTasks[0]?.id ?? null);
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
      const task = await createTask(selectedProjectId, {
        title: newTaskTitle.trim(),
        description: newTaskDescription.trim() || undefined,
        priority: newTaskPriority,
        dueAt: toIsoDateOrNull(newTaskDueAt) ?? undefined,
      });
      setTasks((prev) => [task, ...prev]);
      setActiveTaskId(task.id);
      setShowNewTask(false);
      setNewTaskTitle("");
      setNewTaskDescription("");
      setNewTaskDueAt("");
      setNewTaskPriority("MEDIUM");
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingTask(false);
    }
  }

  async function handleDeleteTask() {
    if (!activeTask) return;
    if (!confirm(`Task \"${activeTask.title}\" wirklich löschen?`)) return;
    setDeletingTask(true);
    setError(null);
    try {
      await deleteTask(activeTask.id);
      setTasks((prev) => prev.filter((task) => task.id !== activeTask.id));
      setActiveTaskId(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingTask(false);
    }
  }

  async function handleAddAttachment(e: React.FormEvent) {
    e.preventDefault();
    if (!activeTask || !attachmentName.trim() || !attachmentUrl.trim()) return;
    setAttachmentBusy(true);
    setError(null);
    try {
      const attachment = await addTaskAttachment(activeTask.id, {
        name: attachmentName.trim(),
        url: attachmentUrl.trim(),
      });
      setTasks((prev) =>
        prev.map((task) =>
          task.id === activeTask.id
            ? { ...task, attachments: [attachment, ...task.attachments] }
            : task,
        ),
      );
      setAttachmentName("");
      setAttachmentUrl("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function handleDeleteAttachment(attachmentId: string) {
    if (!activeTask) return;
    setAttachmentBusy(true);
    setError(null);
    try {
      await deleteTaskAttachment(activeTask.id, attachmentId);
      setTasks((prev) =>
        prev.map((task) =>
          task.id === activeTask.id
            ? {
                ...task,
                attachments: task.attachments.filter((attachment) => attachment.id !== attachmentId),
              }
            : task,
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAttachmentBusy(false);
    }
  }

  return (
    <main className="page-shell">
      <AppHeader
        user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null}
        boardHref={selectedTeamId && selectedProjectId ? `/dashboard?teamId=${selectedTeamId}&projectId=${selectedProjectId}` : "/dashboard"}
      />

      <div style={{ border: "1px solid var(--border)", background: "var(--surface)", borderRadius: "10px", padding: "0.75rem 0.9rem", marginBottom: "1rem", color: "var(--muted)", fontSize: "0.84rem" }}>
        Flow: Team wählen, Projekt wählen, Task anklicken und rechts bearbeiten.
      </div>

      <section
        className="dashboard-select-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(220px, 360px) 1fr",
          gap: "0.6rem",
          marginBottom: "1rem",
        }}
      >
        <div>
          <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>Projekt</label>
          <select
            value={selectedProjectId}
            onChange={(e) => {
              void handleProjectChange(e.target.value);
            }}
            style={{ width: "100%" }}
            disabled={loading || projects.length === 0}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "end", gap: "0.5rem", flexWrap: "wrap" }}>
          <p style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
            Team: {teams.find((team) => team.id === selectedTeamId)?.name ?? "-"}
          </p>
          <button
            type="button"
            onClick={() => setShowNewTask(true)}
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
        <div className="modal-overlay" onClick={() => setShowNewTask(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.7rem" }}>
              <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>Neue Task</h3>
              <button
                type="button"
                onClick={() => setShowNewTask(false)}
                style={{ border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", borderRadius: "6px", padding: "0.2rem 0.5rem" }}
              >
                Schließen
              </button>
            </div>
            <form onSubmit={(e) => void handleCreateTask(e)}>
              <div className="new-task-grid" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                <div>
                  <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.2rem" }}>Titel</label>
                  <input value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} required style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.2rem" }}>Priorität</label>
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
              <div style={{ marginBottom: "0.75rem" }}>
                <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.2rem" }}>Beschreibung</label>
                <textarea value={newTaskDescription} onChange={(e) => setNewTaskDescription(e.target.value)} rows={4} style={{ width: "100%", resize: "vertical" }} />
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
                {creatingTask ? "Creating…" : "Task erstellen"}
              </button>
            </form>
          </div>
        </div>
      )}

      <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "0.75rem", marginBottom: "0.9rem" }}>
        <div className="board-toolbar">
          <input
            value={taskQuery}
            onChange={(e) => setTaskQuery(e.target.value)}
            placeholder="Tasks suchen…"
            style={{ width: "100%" }}
          />
          <select
            value={taskScope}
            onChange={(e) => setTaskScope(e.target.value as "all" | "mine" | "overdue" | "unassigned")}
            style={{ width: "100%" }}
          >
            <option value="all">Scope: Alle</option>
            <option value="mine">Scope: Meine</option>
            <option value="overdue">Scope: Überfällig</option>
            <option value="unassigned">Scope: Unassigned</option>
          </select>
          <label className="board-scope-inline">
            <input
              type="checkbox"
              checked={hideDone}
              onChange={(e) => setHideDone(e.target.checked)}
            />
            Hide done
          </label>
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
        <div style={{ background: "#2a1a1a", color: "var(--danger)", border: "1px solid var(--danger)", borderRadius: "10px", padding: "0.9rem", marginBottom: "0.9rem" }}>
          {error}
        </div>
      ) : !selectedProjectId ? (
        <div style={{ border: "1px dashed var(--border)", borderRadius: "10px", padding: "2rem", textAlign: "center", color: "var(--muted)" }}>
          Dieses Team hat noch kein Projekt. Erstelle ein Projekt auf der Teams-Seite.
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
            <BoardColumns tasks={filteredTasks} activeTaskId={activeTaskId} onSelectTask={setActiveTaskId} />
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
                Schließen
              </button>
            </div>

            <div style={{ marginBottom: "0.5rem" }}>
              <label style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Titel</label>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={{ width: "100%" }} />
            </div>

            <div style={{ marginBottom: "0.5rem" }}>
              <label style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Beschreibung</label>
              <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={4} style={{ width: "100%", resize: "vertical" }} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem", marginBottom: "0.5rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Status</label>
                <select value={editStatus} onChange={(e) => setEditStatus(e.target.value as Status)} style={{ width: "100%" }}>
                  {STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Priorität</label>
                <select value={editPriority} onChange={(e) => setEditPriority(e.target.value as Priority)} style={{ width: "100%" }}>
                  <option value="LOW">LOW</option>
                  <option value="MEDIUM">MEDIUM</option>
                  <option value="HIGH">HIGH</option>
                  <option value="CRITICAL">CRITICAL</option>
                </select>
              </div>
            </div>

            <div style={{ marginBottom: "0.8rem" }}>
              <label style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)", marginBottom: "0.2rem" }}>Due Date</label>
              <input type="date" value={editDueAt} onChange={(e) => setEditDueAt(e.target.value)} style={{ width: "100%" }} />
            </div>

            <div className="task-detail-actions" style={{ display: "flex", gap: "0.5rem", marginBottom: "0.9rem", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void handleSaveTask()}
                disabled={savingTask || deletingTask}
                style={{ background: "var(--primary)", color: "white", border: "none", borderRadius: "8px", padding: "0.45rem 0.7rem", fontWeight: 600 }}
              >
                {savingTask ? "Saving…" : "Speichern"}
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteTask()}
                disabled={savingTask || deletingTask}
                style={{ background: "transparent", color: "var(--danger)", border: "1px solid var(--danger)", borderRadius: "8px", padding: "0.45rem 0.7rem" }}
              >
                {deletingTask ? "Deleting…" : "Löschen"}
              </button>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.7rem" }}>
              <p style={{ fontSize: "0.8rem", color: "var(--muted)", marginBottom: "0.45rem" }}>Attachments</p>

              <form onSubmit={(e) => void handleAddAttachment(e)} style={{ marginBottom: "0.65rem" }}>
                <input
                  value={attachmentName}
                  onChange={(e) => setAttachmentName(e.target.value)}
                  placeholder="Name"
                  style={{ width: "100%", marginBottom: "0.35rem" }}
                />
                <input
                  value={attachmentUrl}
                  onChange={(e) => setAttachmentUrl(e.target.value)}
                  placeholder="https://..."
                  type="url"
                  style={{ width: "100%", marginBottom: "0.35rem" }}
                />
                <button
                  type="submit"
                  disabled={attachmentBusy}
                  style={{ background: "var(--border)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "7px", padding: "0.35rem 0.6rem" }}
                >
                  Add attachment
                </button>
              </form>

              {activeTask.attachments.length === 0 ? (
                <p style={{ color: "var(--muted)", fontSize: "0.78rem" }}>Keine Attachments.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                  {activeTask.attachments.map((attachment) => (
                    <div key={attachment.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", border: "1px solid var(--border)", borderRadius: "8px", padding: "0.4rem 0.5rem" }}>
                      <a href={attachment.url} target="_blank" rel="noreferrer" style={{ color: "var(--text)", fontSize: "0.78rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {attachment.name}
                      </a>
                      <button
                        type="button"
                        disabled={attachmentBusy}
                        onClick={() => {
                          void handleDeleteAttachment(attachment.id);
                        }}
                        style={{ background: "transparent", border: "1px solid var(--danger)", color: "var(--danger)", borderRadius: "6px", padding: "0.2rem 0.45rem", fontSize: "0.72rem" }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
