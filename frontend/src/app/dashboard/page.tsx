"use client";

import { useEffect, useState } from "react";
import { getCurrentUser, getTasks, createTask, claimTask, transitionTask, logout, type User, type Task } from "../../lib/api";

const STATUSES = ["open", "in_progress", "review", "done"] as const;
type Status = (typeof STATUSES)[number];

const STATUS_LABELS: Record<Status, string> = {
  open: "Open",
  in_progress: "In Progress",
  review: "In Review",
  done: "Done",
};

const PRIORITY_COLORS: Record<string, string> = {
  LOW: "#888",
  MEDIUM: "#faa81a",
  HIGH: "#ed4245",
  CRITICAL: "#ff0040",
};

function TaskCard({ task }: { task: Task }) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        padding: "0.75rem",
        marginBottom: "0.5rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem" }}>
        <p style={{ fontWeight: 500, fontSize: "0.875rem", flexGrow: 1 }}>{task.title}</p>
        <span
          style={{
            display: "inline-block",
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: PRIORITY_COLORS[task.priority] ?? "#888",
            flexShrink: 0,
            marginTop: "4px",
          }}
          title={task.priority}
        />
      </div>
      {(task.claimedByUserId || task.claimedByAgentId) && (
        <p style={{ color: "var(--muted)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
          {task.claimedByAgentId ? "🤖 Agent" : "👤 Human"}
        </p>
      )}
    </div>
  );
}

function KanbanBoard({ tasks }: { tasks: Task[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "1rem",
        overflowX: "auto",
      }}
    >
      {STATUSES.map((status) => {
        const colTasks = tasks.filter((t) => t.status === status);
        return (
          <div key={status}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "0.75rem",
              }}
            >
              <h3 style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {STATUS_LABELS[status]}
              </h3>
              <span
                style={{
                  background: "var(--border)",
                  color: "var(--muted)",
                  borderRadius: "9999px",
                  padding: "0 0.5rem",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                }}
              >
                {colTasks.length}
              </span>
            </div>
            {colTasks.length === 0 ? (
              <div
                style={{
                  border: "1px dashed var(--border)",
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                  color: "var(--muted)",
                  fontSize: "0.75rem",
                }}
              >
                No tasks
              </div>
            ) : (
              colTasks.map((task) => <TaskCard key={task.id} task={task} />)
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function DashboardPage() {
  const [user, setUser] = useState<User | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // New task form
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState("MEDIUM");
  const [creatingTask, setCreatingTask] = useState(false);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      setUser(me);

      // Load tasks if projectId is set via URL params
      const params = new URLSearchParams(window.location.search);
      const pid = params.get("projectId");
      if (pid) {
        setProjectId(pid);
        try {
          const t = await getTasks(pid);
          setTasks(t);
        } catch (e) {
          setError((e as Error).message);
        }
      }
      setLoading(false);
    })();
  }, []);

  return (
    <main
      style={{
        padding: "1.5rem",
        maxWidth: "1400px",
        margin: "0 auto",
        minHeight: "100vh",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "2rem",
          borderBottom: "1px solid var(--border)",
          paddingBottom: "1rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span style={{ fontWeight: 700, fontSize: "1rem", color: "var(--primary)" }}>agent-tasks</span>
          {projectId && (
            <>
              <span style={{ color: "var(--muted)" }}>/</span>
              <span style={{ color: "var(--muted)", fontSize: "0.875rem" }}>Project Board</span>
            </>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          {user ? (
            <>
              {user.avatarUrl && (
                <img
                  src={user.avatarUrl}
                  alt={user.login}
                  style={{ width: "28px", height: "28px", borderRadius: "50%" }}
                />
              )}
              <span style={{ color: "var(--muted)", fontSize: "0.875rem" }}>{user.login}</span>
              <button
                onClick={() => {
                  void logout().then(() => { window.location.href = "/"; });
                }}
                style={{
                  background: "none",
                  border: "1px solid var(--border)",
                  color: "var(--muted)",
                  fontSize: "0.875rem",
                  padding: "0.25rem 0.75rem",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                Logout
              </button>
            </>
          ) : (
            <a
              href="/"
              style={{
                background: "var(--primary)",
                color: "white",
                padding: "0.5rem 1rem",
                borderRadius: "6px",
                fontSize: "0.875rem",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Login with GitHub
            </a>
          )}
        </div>
      </header>

      {loading ? (
        <div style={{ textAlign: "center", padding: "4rem", color: "var(--muted)" }}>
          Loading…
        </div>
      ) : error ? (
        <div
          style={{
            background: "#2a1a1a",
            border: "1px solid var(--danger)",
            borderRadius: "8px",
            padding: "1rem",
            color: "var(--danger)",
          }}
        >
          {error}
        </div>
      ) : !projectId ? (
        <div style={{ textAlign: "center", padding: "4rem" }}>
          <h2 style={{ marginBottom: "1rem", fontSize: "1.25rem" }}>Welcome to agent-tasks</h2>
          <p style={{ color: "var(--muted)", marginBottom: "1.5rem" }}>
            Open a project board via{" "}
            <code
              style={{
                background: "var(--border)",
                padding: "0.125rem 0.375rem",
                borderRadius: "4px",
                fontFamily: "monospace",
              }}
            >
              /dashboard?projectId={"<id>"}
            </code>
          </p>
          {!user && (
            <a
              href="/"
              style={{
                display: "inline-block",
                background: "var(--primary)",
                color: "white",
                padding: "0.75rem 1.5rem",
                borderRadius: "8px",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Login with GitHub
            </a>
          )}
        </div>
      ) : (
        <>
          {/* Stats row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: "0.75rem",
              marginBottom: "1.5rem",
            }}
          >
            {STATUSES.map((status) => (
              <div
                key={status}
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "center",
                }}
              >
                <p style={{ color: "var(--muted)", fontSize: "0.75rem", textTransform: "uppercase", marginBottom: "0.25rem" }}>
                  {STATUS_LABELS[status]}
                </p>
                <p style={{ fontSize: "1.5rem", fontWeight: 700 }}>
                  {tasks.filter((t) => t.status === status).length}
                </p>
              </div>
            ))}
          </div>

          {/* New Task Button */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <p style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>{tasks.length} tasks total</p>
            <button
              onClick={() => setShowNewTask((v) => !v)}
              style={{ background: "var(--primary)", color: "white", border: "none", borderRadius: "6px", padding: "0.375rem 0.875rem", fontWeight: 600, cursor: "pointer", fontSize: "0.8125rem", fontFamily: "inherit" }}
            >
              + New Task
            </button>
          </div>

          {showNewTask && (
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", padding: "1rem", marginBottom: "1rem" }}>
              <form onSubmit={(e) => {
                e.preventDefault();
                void (async () => {
                  if (!newTaskTitle.trim() || !projectId) return;
                  setCreatingTask(true);
                  try {
                    const t = await createTask(projectId, { title: newTaskTitle.trim(), priority: newTaskPriority });
                    setTasks((prev) => [t, ...prev]);
                    setNewTaskTitle("");
                    setShowNewTask(false);
                  } finally {
                    setCreatingTask(false);
                  }
                })();
              }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>Title</label>
                    <input value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} placeholder="Task title…" required style={{ width: "100%", display: "block" }} />
                  </div>
                  <div>
                    <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>Priority</label>
                    <select value={newTaskPriority} onChange={(e) => setNewTaskPriority(e.target.value)} style={{ height: "37px" }}>
                      {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => <option key={p}>{p}</option>)}
                    </select>
                  </div>
                  <button type="submit" disabled={creatingTask} style={{ background: "var(--primary)", color: "white", border: "none", borderRadius: "6px", padding: "0.5rem 1rem", fontWeight: 600, cursor: "pointer", height: "37px", fontFamily: "inherit" }}>{creatingTask ? "…" : "Create"}</button>
                  <button type="button" onClick={() => setShowNewTask(false)} style={{ background: "transparent", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: "6px", padding: "0.5rem 0.75rem", cursor: "pointer", height: "37px", fontFamily: "inherit" }}>×</button>
                </div>
              </form>
            </div>
          )}

          {/* Kanban Board */}
          <KanbanBoard tasks={tasks} />
        </>
      )}
    </main>
  );
}
