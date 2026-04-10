"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeams,
  getProjects,
  getTasks,
  type User,
  type Team,
  type Project,
  type Task,
} from "../../lib/api";
import { formatRelativeTime } from "../../lib/time";
import AppHeader from "../../components/AppHeader";
import Card from "../../components/ui/Card";

const STATUS_COLORS: Record<string, string> = {
  open: "var(--muted)",
  in_progress: "var(--primary)",
  review: "var(--warning)",
  done: "var(--success)",
};

const PRIORITY_COLORS: Record<string, string> = {
  LOW: "#6b7280",
  MEDIUM: "#f59e0b",
  HIGH: "#ef4444",
  CRITICAL: "#be123c",
};

type EnrichedTask = Task & { projectName: string };

function TaskRow({ task, teamId }: { task: EnrichedTask; teamId: string }) {
  return (
    <Link
      href={`/dashboard?teamId=${teamId}&projectId=${task.projectId}&taskId=${task.id}`}
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <div className="open-task-row" style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0.5rem", borderRadius: "var(--radius-base)", transition: "background 0.12s ease" }}>
        <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: STATUS_COLORS[task.status] ?? "var(--muted)", flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: "var(--text-sm)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {task.title}
        </span>
        <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)", flexShrink: 0 }}>
          {task.projectName}
        </span>
        <span className="status-chip" style={{ color: PRIORITY_COLORS[task.priority] ?? "#6b7280", fontSize: "var(--text-xs)", flexShrink: 0 }}>
          {task.priority}
        </span>
        <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)", flexShrink: 0 }}>
          {formatRelativeTime(task.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

const WIDGET_LIMIT = 10;

interface WidgetProps {
  title: string;
  tasks: EnrichedTask[];
  teamId: string;
  emptyText: string;
}

function TaskWidget({ title, tasks, teamId, emptyText }: WidgetProps) {
  return (
    <Card style={{ marginBottom: "0.75rem" }} padding="sm">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <h2 style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>{title}</h2>
        <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>{tasks.length} total</span>
      </div>
      {tasks.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", padding: "0.25rem 0" }}>{emptyText}</p>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {tasks.slice(0, WIDGET_LIMIT).map((task) => (
              <TaskRow key={task.id} task={task} teamId={teamId} />
            ))}
          </div>
          {tasks.length > WIDGET_LIMIT && (
            <p style={{ textAlign: "right", marginTop: "0.4rem", color: "var(--muted)", fontSize: "var(--text-xs)" }}>
              +{tasks.length - WIDGET_LIMIT} more
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [allTasks, setAllTasks] = useState<EnrichedTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) { router.replace("/auth"); return; }
      setUser(me);

      const teams = await getTeams();
      if (teams.length === 0) { router.replace("/onboarding"); return; }

      const team = teams[0]!;
      setSelectedTeam(team);

      const teamProjects = await getProjects(team.id);
      setProjects(teamProjects);
      setLoading(false);
    })();
  }, [router]);

  useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;

    async function fetchAllTasks() {
      const collected: EnrichedTask[] = [];
      await Promise.all(
        projects.map(async (p) => {
          const tasks = await getTasks(p.id);
          for (const t of tasks) {
            collected.push({ ...t, projectName: p.name });
          }
        }),
      );
      if (!cancelled) {
        collected.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        setAllTasks(collected);
      }
    }

    void fetchAllTasks();
    const interval = setInterval(() => void fetchAllTasks(), 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [projects]);

  const openTasks = useMemo(
    () => allTasks.filter((t) => t.status === "open" || t.status === "in_progress"),
    [allTasks],
  );

  const inReviewTasks = useMemo(
    () => allTasks.filter((t) => t.status === "review"),
    [allTasks],
  );

  const priorityTasks = useMemo(
    () => allTasks.filter((t) => (t.priority === "CRITICAL" || t.priority === "HIGH") && t.status !== "done"),
    [allTasks],
  );

  const recentlyDone = useMemo(
    () => allTasks.filter((t) => t.status === "done").slice(0, WIDGET_LIMIT),
    [allTasks],
  );

  const myTasks = useMemo(
    () => allTasks.filter((t) => t.claimedByUserId === user?.id && t.status !== "done"),
    [allTasks, user],
  );

  if (loading) {
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--muted)" }}>Loading...</p>
      </main>
    );
  }

  const boardHref = selectedTeam && projects[0]
    ? `/dashboard?teamId=${selectedTeam.id}&projectId=${projects[0].id}`
    : "/dashboard";

  return (
    <main className="page-shell">
      <AppHeader
        user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null}
        boardHref={boardHref}
      />

      <Card padding="sm" style={{ marginBottom: "var(--space-4)", color: "var(--muted)", fontSize: "var(--text-sm)" }}>
        Your task overview across all projects.
      </Card>

      {selectedTeam && (
        <div className="home-widgets-grid">
          <TaskWidget title="Open Tasks" tasks={openTasks} teamId={selectedTeam.id} emptyText="No open tasks." />
          <TaskWidget title="My Tasks" tasks={myTasks} teamId={selectedTeam.id} emptyText="No tasks assigned to you." />
          <TaskWidget title="Priority (High / Critical)" tasks={priorityTasks} teamId={selectedTeam.id} emptyText="No high-priority tasks." />
          <TaskWidget title="In Review" tasks={inReviewTasks} teamId={selectedTeam.id} emptyText="Nothing in review." />
          <TaskWidget title="Recently Done" tasks={recentlyDone} teamId={selectedTeam.id} emptyText="No completed tasks yet." />
        </div>
      )}
    </main>
  );
}
