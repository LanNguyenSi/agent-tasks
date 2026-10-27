"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  getCurrentUser,
  getTask,
  getProject,
  getTasks,
  getEffectiveWorkflow,
  getTaskConfidenceDetail,
  projectCanAdmin,
  isProjectWriteRole,
  type User,
  type Task,
  type Project,
  type WorkflowTransition,
  type TaskConfidenceDetail,
} from "../../../lib/api";
import AlertBanner from "../../../components/ui/AlertBanner";
import TaskDetail from "../../../components/TaskDetail";
import { GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD } from "../../../lib/confidence";
import { boardHref, safeBackHref } from "../../../lib/routes";
import TaskDetailSkeleton from "../../../components/task-detail/TaskDetailSkeleton";
import { useDocumentTitle } from "../../../components/DocumentTitle";
import { PageShell } from "../../../components/ui/PageShell";

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
 * tasks (for the dependency picker), for the breadcrumb.
 */
export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const taskId = params.id;
  const router = useRouter();
  const searchParams = useSearchParams();

  // Where the user came from: the `from` the /tasks list puts on its links.
  // A repeated `from` is ambiguous, so it is handed over as an array and
  // rejected; anything that is not `/tasks` or `/tasks?...` is dropped.
  const fromParams = searchParams.getAll("from");
  const backHref = safeBackHref(fromParams.length > 1 ? fromParams : (fromParams[0] ?? null));

  const [user, setUser] = useState<User | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  // Effective-workflow edges, fetched only for admins to constrain the status-
  // override dropdown to the transitions the backend will actually accept
  // (null = not loaded / not admin → the control falls back to the base states).
  const [workflowTransitions, setWorkflowTransitions] = useState<WorkflowTransition[] | null>(null);
  // M4 (task 67526c1c): the Improvement panel's data. Fetched alongside the
  // other page data but non-critical — a failure resolves to null via the
  // .catch below rather than surfacing as a page error, so the panel simply
  // does not render instead of blocking the whole task page.
  const [improvementPanel, setImprovementPanel] = useState<TaskConfidenceDetail | null>(null);
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
        const [fetchedProject, projectTasks, confidenceDetail] = await Promise.all([
          getProject(fetchedTask.projectId),
          getTasks(fetchedTask.projectId),
          getTaskConfidenceDetail(taskId).catch(() => null),
        ]);
        if (cancelled) return;
        setUser(me);
        setTask(fetchedTask);
        setProject(fetchedProject);
        setTasks(projectTasks);
        setImprovementPanel(confidenceDetail);
        setError(null);

        // Only admins get the status-override control, so only they need the
        // workflow edges. A failure here must not break the page — the control
        // falls back to the base states when transitions stay null. Same
        // helper the render path uses, so both admin derivations stay in sync.
        if (projectCanAdmin(fetchedProject)) {
          try {
            const wf = await getEffectiveWorkflow(fetchedProject.id);
            if (!cancelled) setWorkflowTransitions(wf.definition.transitions);
          } catch {
            /* fall back to base states */
          }
        }
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

  useDocumentTitle(task?.title ?? "Task");

  function handleUpdate(updated: Task) {
    setTask(updated);
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    // M4 fix-round-1 (MED-4): re-fetch the Improvement panel's confidence
    // detail after every task edit, same tolerant-failure posture as the
    // initial load above (a failed refetch resolves to null rather than
    // surfacing an error) -- otherwise the panel keeps showing the
    // pre-edit score/findings/verdict forever, since nothing else here
    // ever updates `improvementPanel`.
    void getTaskConfidenceDetail(updated.id)
      .catch(() => null)
      .then((detail) => setImprovementPanel(detail));
  }

  const boardUrl =
    project && task
      ? boardHref({ teamId: project.teamId, projectId: task.projectId })
      : boardHref();

  // `canAdmin` (from GET /projects/:id, fetched above via getProject) covers a
  // team ADMIN, a per-project-only PROJECT_ADMIN and a team member who also
  // holds PROJECT_ADMIN. `team?.role === "ADMIN"` misses the last two and
  // `accessRole` the last one (see projectCanAdmin in lib/api.ts).
  const isProjectAdmin = projectCanAdmin(project);
  const isProjectWrite = isProjectWriteRole(project?.accessRole);

  // Close and delete return to the originating list when there is one,
  // otherwise to the board (direct visits, the modal's "open as full page").
  function goToBoard() {
    router.push(backHref ?? boardUrl);
  }

  return (
    // Default (centred 1200px) column; flush because .td-page owns the gutter
    // and the layout below it owns the bottom spacing.
    <PageShell flush>
      {/* Visually hidden H1 for the document outline when the task hasn't
          loaded yet; once loaded, TaskDetail renders the real task-title H1. */}
      {loading && <h1 className="sr-only">Task Details</h1>}

      {error && (
        <div className="td-error-wrap">
          <AlertBanner tone="danger">{error}</AlertBanner>
        </div>
      )}

      {loading && (
        <div className="td-loading-wrap">
          <TaskDetailSkeleton />
        </div>
      )}

      {!loading && task && project && (
        <TaskDetail
          variant="page"
          task={task}
          tasks={tasks}
          user={user}
          templateFields={project.taskTemplate?.fields ?? null}
          confidenceThreshold={project.confidenceThreshold ?? GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD}
          taskTypeThresholds={project.taskTypeThresholds ?? null}
          enforcementMode={project.enforcementMode ?? null}
          requireDistinctReviewer={project.requireDistinctReviewer ?? false}
          isProjectAdmin={isProjectAdmin}
          isProjectWrite={isProjectWrite}
          workflowTransitions={workflowTransitions}
          improvementPanel={improvementPanel}
          aiHelpersEnabled={project.aiHelpersEnabled ?? false}
          onUpdate={handleUpdate}
          onDelete={goToBoard}
          onClose={goToBoard}
          onError={(msg) => setError(msg)}
          teamId={project.teamId}
          projectName={project.name}
          projectId={project.id}
          backHref={backHref}
        />
      )}
    </PageShell>
  );
}
