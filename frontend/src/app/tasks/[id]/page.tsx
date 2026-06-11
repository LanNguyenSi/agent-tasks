"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  getCurrentUser,
  getTask,
  getProject,
  getTasks,
  type User,
  type Task,
  type Project,
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
 * template fields / confidence threshold / reviewer policy), and the
 * project's tasks (for the dependency picker).
 */
export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const taskId = params.id;
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [project, setProject] = useState<Project | null>(null);
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
        const [fetchedProject, projectTasks] = await Promise.all([
          getProject(fetchedTask.projectId),
          getTasks(fetchedTask.projectId),
        ]);
        if (cancelled) return;
        setUser(me);
        setTask(fetchedTask);
        setProject(fetchedProject);
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

  const boardHref =
    project && task
      ? `/dashboard?teamId=${project.teamId}&projectId=${task.projectId}`
      : "/dashboard";

  function handleUpdate(updated: Task) {
    setTask(updated);
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  function goToBoard() {
    router.push(boardHref);
  }

  return (
    <main className="page-shell">
      {/* Page-level heading for the document outline. Visually hidden
          because the task title already shows as the first visible heading
          in the detail body; this keeps the outline rooted at an h1 without
          duplicating the title on screen (mirrors the modal's "Task
          Details" title). */}
      <h1 className="sr-only">Task Details</h1>

      <p style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-3)" }}>
        <Link href={boardHref} style={{ color: "var(--muted)" }}>
          ← Back to board
        </Link>
      </p>

      {error && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <AlertBanner tone="danger">{error}</AlertBanner>
        </div>
      )}

      {loading && <p style={{ color: "var(--muted)" }}>Loading…</p>}

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
        />
      )}
    </main>
  );
}
