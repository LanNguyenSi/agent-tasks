"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTask,
  getProject,
  getTasks,
  getTeams,
  type User,
  type Task,
  type Project,
  type Team,
} from "../../../lib/api";
import AlertBanner from "../../../components/ui/AlertBanner";
import TaskDetail from "../../../components/TaskDetail";

/**
 * Full-page ("maximized") task detail at /tasks/[id].
 *
 * The board renders the same detail inside a modal; the modal's maximize
 * control links here. This page owns the page chrome (header + back link)
 * and delegates the body to <TaskDetail variant="page" />, which is the
 * exact component the modal wraps — so the two surfaces never drift.
 *
 * Deep-linkable: the task id is enough to fetch the task, its project (for
 * template fields / confidence threshold / reviewer policy), the project's
 * tasks (for the dependency picker), and the team name for the breadcrumb.
 */
export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const taskId = params.id;
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await getCurrentUser();
        if (!me) {
          router.replace("/auth");
          return;
        }
        const fetchedTask = await getTask(taskId);
        const [fetchedProject, projectTasks, allTeams] = await Promise.all([
          getProject(fetchedTask.projectId),
          getTasks(fetchedTask.projectId),
          getTeams(),
        ]);
        if (cancelled) return;
        const matchedTeam = allTeams.find((t) => t.id === fetchedProject.teamId) ?? null;
        setUser(me);
        setTask(fetchedTask);
        setProject(fetchedProject);
        setTeam(matchedTeam);
        setTasks(projectTasks);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, router]);

  function handleUpdate(updated: Task) {
    setTask(updated);
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  const boardHref =
    project && task
      ? `/dashboard?teamId=${project.teamId}&projectId=${task.projectId}`
      : "/dashboard";

  function goToBoard() {
    router.push(boardHref);
  }

  return (
    <main className="page-shell">
      {/* Visually hidden H1 for the document outline when the task hasn't
          loaded yet; once loaded, TaskDetail renders the real task-title H1. */}
      {loading && <h1 className="sr-only">Task Details</h1>}

      {error && (
        <div style={{ padding: "var(--space-5)", maxWidth: "1168px", margin: "0 auto" }}>
          <AlertBanner tone="danger">{error}</AlertBanner>
        </div>
      )}

      {loading && (
        <p style={{ padding: "var(--space-5)", color: "var(--muted)" }}>Loading…</p>
      )}

      {!loading && task && project && (
        <TaskDetail
          variant="page"
          task={task}
          tasks={tasks}
          user={user}
          templateFields={project.taskTemplate?.fields ?? null}
          confidenceThreshold={project.confidenceThreshold ?? 60}
          requireDistinctReviewer={project.requireDistinctReviewer ?? false}
          onUpdate={handleUpdate}
          onDelete={goToBoard}
          onClose={goToBoard}
          onError={(msg) => setError(msg)}
          teamName={team?.name}
          teamId={project.teamId}
          projectName={project.name}
          projectId={project.id}
        />
      )}
    </main>
  );
}
