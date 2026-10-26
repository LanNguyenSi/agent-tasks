"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD } from "../../../../lib/confidence";
import { useParams, useRouter } from "next/navigation";
import {
  getCurrentUser,
  getProject,
  getTasks,
  getTask,
  getEffectiveWorkflow,
  isProjectAdminRole,
  isProjectWriteRole,
  ApiRequestError,
  type User,
  type Project,
  type Task,
  type WorkflowTransition,
} from "../../../../lib/api";
import {
  DEFAULT_DONE_VISIBILITY,
  isDoneTaskHidden,
  readStoredDoneVisibility,
  storeDoneVisibility,
  readStoredViewMode,
  storeViewMode,
  type DoneVisibility,
  type DashboardViewMode,
} from "../../../../lib/dashboardPrefs";
import AlertBanner from "../../../../components/ui/AlertBanner";
import { Button } from "../../../../components/ui/Button";
import { Icon } from "../../../../components/ui/Icon";
import { KeyHint } from "../../../../components/ui/KeyHint";
import { SkeletonList } from "../../../../components/ui/Skeleton";
import { StatusChip } from "../../../../components/ui/StatusChip";
import { Tabs } from "../../../../components/ui/Tabs";
import { useToast } from "../../../../components/ui/Toast";
import TaskDetail from "../../../../components/TaskDetail";
import ImportDialog from "../../../../components/ImportDialog";
import FilterToolbar from "../../../../components/dashboard/FilterToolbar";
import BoardView, { BoardEmptyState } from "../../../../components/dashboard/BoardView";
import { BOARD_REGION_ID } from "../../../../components/dashboard/boardRegion";
import TaskListView from "../../../../components/dashboard/TaskListView";
import NewTaskModal from "../../../../components/dashboard/NewTaskModal";
import { isOverdue, matchesTaskSearch } from "../../../../lib/taskDisplay";
import { DEFAULT_CREATE_STATUS } from "../../../../lib/status";
import { recordRecentProject } from "../../../../lib/recentProjects";
import { projectsHref } from "../../../../lib/routes";

// ── Types ────────────────────────────────────────────────────────

// Drives the list-view status chip row (~L645) and the board's + button
// status cast; also includes "backlog" so the chip row shows it.
const STATUSES = ["backlog", "open", "in_progress", "review", "done"] as const;
type Status = (typeof STATUSES)[number];
// Supersedes D19 (operator decision 2026-08-20): human create no longer
// always targets "open" -- backlog is now the default human create target
// too, and NewTaskModal's Status dropdown offers backlog and open.
// BoardView only renders its + on the Backlog and Open columns (operator
// decision 2026-08-20, column gating), so this state only ever carries one
// of those two in practice; NewTaskModal clamps anything else to its own
// default internally as a robustness net, so no narrowing is needed here.

const LIST_PAGE_SIZE = 12;

// ── Helpers ──────────────────────────────────────────────────────

// Last board opened per team. Read only by the legacy /dashboard redirect
// (app/dashboard/page.tsx), which resumes it; keep the key format in sync.
const LAST_PROJECT_KEY_PREFIX = "dashboard:lastProject:";

function getTeamProjectStorageKey(teamId: string): string {
  return `${LAST_PROJECT_KEY_PREFIX}${teamId}`;
}

function storeProjectId(teamId: string, projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(getTeamProjectStorageKey(teamId), projectId);
  } catch {
    // No-op for blocked storage contexts.
  }
}

// Drop every team's remembered board that points at a project this user can no
// longer open, so a bare /dashboard stops resuming it.
function forgetProjectId(projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(LAST_PROJECT_KEY_PREFIX) && storage.getItem(key) === projectId) {
        stale.push(key);
      }
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    // No-op for blocked storage contexts.
  }
}

// ── Board page ───────────────────────────────────────────────────

export default function ProjectBoardPage() {
  const router = useRouter();
  const { id: projectId } = useParams<{ id: string }>();
  const { toast } = useToast();

  const [user, setUser] = useState<User | null>(null);
  // GET /projects/:id for the route's project; set once access is confirmed.
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const selectedProjectId = selectedProject?.id ?? "";
  const [tasks, setTasks] = useState<Task[]>([]);

  // Separate boot error (prevents board mount) from action error (toast only).
  const [loading, setLoading] = useState(true);
  // True once a boot ran to the end (project loaded, tasks applied, arrival
  // `?taskId` read). A redirect (/auth, projects) or a boot error leaves it
  // false so the URL sync below never fights those navigations.
  const [bootSucceeded, setBootSucceeded] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const [showNewTask, setShowNewTask] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  // Status preset when opening NewTaskModal from a board column's + button
  // or a generic create entry point (toolbar, "C" shortcut).
  const [newTaskInitialStatus, setNewTaskInitialStatus] = useState<Status>(DEFAULT_CREATE_STATUS);

  const [taskQuery, setTaskQuery] = useState("");
  const [taskScope, setTaskScope] = useState<"all" | "mine" | "overdue" | "unassigned">("all");
  const [doneVisibility, setDoneVisibility] = useState<DoneVisibility>(DEFAULT_DONE_VISIBILITY);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DashboardViewMode>("board");
  const [listPage, setListPage] = useState(1);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  // Search input ref for "/" shortcut focus
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const templateFields = selectedProject?.taskTemplate?.fields ?? null;

  // GET /projects/:id carries the caller's `accessRole`, which gates the admin
  // status-override / claim-release controls in the task modal, exactly as the
  // full /tasks/[id] page does. Admins also get the effective-workflow edges
  // so the status-override dropdown only offers valid targets.
  // Failure-tolerant: the dropdown falls back to the base states.
  const selectedProjectAccessRole = selectedProject?.accessRole;
  const [workflowTransitions, setWorkflowTransitions] = useState<
    WorkflowTransition[] | null
  >(null);

  useEffect(() => {
    setWorkflowTransitions(null);
    if (!selectedProjectId || !isProjectAdminRole(selectedProjectAccessRole)) return;
    let cancelled = false;
    void (async () => {
      try {
        const wf = await getEffectiveWorkflow(selectedProjectId);
        if (!cancelled) setWorkflowTransitions(wf.definition.transitions);
      } catch {
        /* fall back to base states */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, selectedProjectAccessRole]);

  const isProjectAdmin = isProjectAdminRole(selectedProjectAccessRole);
  const isProjectWrite = isProjectWriteRole(selectedProjectAccessRole);
  // Agent tokens are created by team admins only: a per-project share or a
  // known non-admin team role does not see the "Connect an agent" link. An
  // unknown role (older API responses) keeps it.
  const canConnectAgent =
    selectedProject?.accessSource !== "project" &&
    (selectedProjectAccessRole == null || selectedProjectAccessRole === "ADMIN");

  // ── Restore persisted view preferences once after mount ──────

  useEffect(() => {
    setDoneVisibility(readStoredDoneVisibility());
    setViewMode(readStoredViewMode());
    setPrefsLoaded(true);
  }, []);

  useEffect(() => {
    if (prefsLoaded) storeDoneVisibility(doneVisibility);
  }, [doneVisibility, prefsLoaded]);

  useEffect(() => {
    if (prefsLoaded) storeViewMode(viewMode);
  }, [viewMode, prefsLoaded]);

  // ── Task detail ──────────────────────────────────────────────

  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeTaskDetail, setActiveTaskDetail] = useState<Task | null>(null);
  const [editActiveOnOpen, setEditActiveOnOpen] = useState(false);

  const selectTask = useCallback((id: string | null, edit = false) => {
    setEditActiveOnOpen(edit);
    setActiveTaskId(id);
  }, []);

  // The URL follows the modal: `?taskId=<id>` while a task is open, removed when
  // it closes (router.replace, so open and close add no history entries and Back
  // leaves the board instead of toggling the modal). Query and hash (the jump
  // bar's `#db-col-...`) are otherwise kept. Runs after a successful boot only,
  // so the arrival `?taskId` is read once by the bootstrap, a reload after
  // close finds none, and a boot that redirected (signed out, project missing)
  // or failed leaves its own navigation alone.
  useEffect(() => {
    if (loading || !bootSucceeded) return;
    const params = new URLSearchParams(window.location.search);
    if ((params.get("taskId") ?? null) === activeTaskId) return;
    if (activeTaskId) params.set("taskId", activeTaskId);
    else params.delete("taskId");
    const query = params.toString();
    router.replace(
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
      { scroll: false },
    );
  }, [activeTaskId, loading, bootSucceeded, router]);

  useEffect(() => {
    if (!activeTaskId) {
      setActiveTaskDetail(null);
      return;
    }
    let cancelled = false;
    void getTask(activeTaskId).then((task) => {
      if (!cancelled) setActiveTaskDetail(task);
    });
    return () => {
      cancelled = true;
    };
  }, [activeTaskId]);

  // ── Filtered task lists ──────────────────────────────────────

  const filteredTasks = useMemo(() => {
    const now = Date.now();
    return tasks.filter((task) => {
      if (task.status === "done" && isDoneTaskHidden(doneVisibility, task.updatedAt, now)) return false;
      if (taskScope === "mine" && task.claimedByUserId !== user?.id) return false;
      if (taskScope === "unassigned" && (task.claimedByUserId || task.claimedByAgentId)) return false;
      if (taskScope === "overdue" && !isOverdue(task)) return false;
      if (labelFilter && !(task.labels ?? []).includes(labelFilter)) return false;
      return matchesTaskSearch(task, taskQuery);
    });
  }, [tasks, taskQuery, taskScope, doneVisibility, labelFilter, user?.id]);

  const hiddenDoneCount = useMemo(() => {
    if (doneVisibility === "all") return 0;
    const now = Date.now();
    return tasks.filter(
      (t) => t.status === "done" && isDoneTaskHidden(doneVisibility, t.updatedAt, now),
    ).length;
  }, [tasks, doneVisibility]);

  const allLabels = useMemo(() => {
    const set = new Set<string>();
    for (const task of tasks) {
      for (const label of task.labels ?? []) set.add(label);
    }
    return [...set].sort();
  }, [tasks]);

  const hasActiveFilters =
    taskQuery.trim().length > 0 ||
    taskScope !== "all" ||
    doneVisibility !== DEFAULT_DONE_VISIBILITY ||
    labelFilter !== null;

  // Reset list page when filters or view mode change
  useEffect(() => {
    setListPage(1);
  }, [selectedProjectId, taskQuery, taskScope, doneVisibility, viewMode]);

  // ── Bootstrap ────────────────────────────────────────────────

  // The project comes from the route, not from a team: a user who reaches a
  // project through a per-project share alone (no team) gets the same board.
  // A `?taskId=` on arrival opens that task; closing the modal removes it (see
  // the URL sync above).
  useEffect(() => {
    setBootSucceeded(false);
    void (async () => {
      try {
        const me = await getCurrentUser();
        if (!me) {
          router.replace("/auth");
          return;
        }
        setUser(me);

        let project: Project;
        try {
          project = await getProject(projectId);
        } catch (err) {
          // Missing or not accessible: same fallback as the hub layout, and
          // forget the stale last-board entry so /dashboard stops resuming it.
          // Any other failure (500, network) is a boot error with a Retry.
          if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) {
            forgetProjectId(projectId);
            router.replace(projectsHref());
            return;
          }
          throw err;
        }
        setSelectedProject(project);
        storeProjectId(project.teamId, project.id);
        // Home "Your projects" strip recents (T05): keyed by the project's
        // team, which is the same id Home's getTeamTasks aggregation is read
        // under, so the strip and this record always agree on the key.
        recordRecentProject(project.teamId, project.id);

        const requestedTaskId = new URLSearchParams(window.location.search).get("taskId");
        const projectTasks = await getTasks(project.id);
        setTasks(projectTasks);
        setActiveTaskId(
          requestedTaskId && projectTasks.some((t) => t.id === requestedTaskId)
            ? requestedTaskId
            : null,
        );
        setBootSucceeded(true);
      } catch (err) {
        setBootError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [router, projectId]);

  // Poll for task updates every 15 seconds
  useEffect(() => {
    if (!selectedProjectId) return;
    const interval = setInterval(async () => {
      if (document.hidden) return;
      try {
        const freshTasks = await getTasks(selectedProjectId);
        setTasks(freshTasks);
      } catch {
        // Silent — avoid error banner for background polls
      }
    }, 15_000);
    return () => clearInterval(interval);
  }, [selectedProjectId]);

  // ── Keyboard shortcuts ───────────────────────────────────────

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      if (!isTyping && e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (!isTyping && (e.key === "c" || e.key === "C") && !e.metaKey && !e.ctrlKey) {
        if (selectedProjectId && !showNewTask) {
          setNewTaskInitialStatus(DEFAULT_CREATE_STATUS);
          setBootError(null);
          setShowNewTask(true);
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedProjectId, showNewTask]);

  function handleTaskUpdate(updated: Task) {
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setActiveTaskDetail(updated);
  }

  function handleTaskDelete(taskId: string) {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    setActiveTaskId(null);
  }

  function clearFilters() {
    setTaskQuery("");
    setTaskScope("all");
    setDoneVisibility(DEFAULT_DONE_VISIBILITY);
    setLabelFilter(null);
  }

  // ── Render ───────────────────────────────────────────────────

  // Project-access info banner (shared-via-invite)
  const accessBanner = selectedProject?.accessSource === "project" && (
    <div className="db-access-banner">
      <AlertBanner tone="info">
        This project is shared with you via a per-project invite. PR operations
        on the linked GitHub repository require your own collaborator-level access.
      </AlertBanner>
    </div>
  );

  // Toolbar: search, filter, view toggle with the task count, import, new
  // task. The project name, crumb and tabs are the hub band above (layout),
  // so there is no title row here.
  const toolbar = (
    <div className="page-header db-toolbar">
      <div className="db-toolbar-main">
        {/* Search with "/" shortcut */}
        <div className="db-search">
          <Icon name="search" size={14} />
          <input
            ref={searchInputRef}
            type="search"
            className="db-search-input"
            aria-label="Search tasks"
            value={taskQuery}
            onChange={(e) => setTaskQuery(e.target.value)}
            placeholder="Search tasks…"
          />
          <KeyHint>/</KeyHint>
        </div>

        {/* Filter toggle */}
        <button
          type="button"
          className={`btn--box btn--sm ${showFilters || hasActiveFilters ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setShowFilters((v) => !v)}
        >
          <Icon name="filter" size={14} />
          Filter
          {hasActiveFilters && !showFilters && <span className="db-filter-dot" />}
        </button>

        {/* Board / List view toggle */}
        <Tabs
          value={viewMode}
          onChange={(v) => setViewMode(v as DashboardViewMode)}
          tabs={[
            { value: "board", label: "Board", icon: <Icon name="board" size={14} /> },
            { value: "list", label: "List", icon: <Icon name="list" size={14} /> },
          ]}
          label="View"
        />

        {selectedProjectId && !loading && (
          <span className="db-toolbar-count num">
            {hasActiveFilters
              ? `${filteredTasks.length} / ${tasks.length} tasks`
              : `${filteredTasks.length} tasks`}
          </span>
        )}
      </div>

      <div className="page-header-actions db-toolbar-actions">
        {/* Import (ghost) */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowImport(true)}
          disabled={!selectedProjectId}
        >
          Import
        </Button>

        {/* New task with "C" key hint */}
        <Button
          size="sm"
          onClick={() => {
            setNewTaskInitialStatus(DEFAULT_CREATE_STATUS);
            setBootError(null);
            setShowNewTask(true);
          }}
          disabled={!selectedProjectId}
          keyHint="C"
        >
          <Icon name="plus" size={13} />
          New task
        </Button>
      </div>
    </div>
  );

  // Filter bar (shown when showFilters is true)
  const filterBar = showFilters && (
    <FilterToolbar
      taskScope={taskScope}
      onScopeChange={setTaskScope}
      doneVisibility={doneVisibility}
      onDoneVisibilityChange={setDoneVisibility}
      labels={allLabels}
      labelFilter={labelFilter}
      onLabelFilterChange={setLabelFilter}
      hiddenDoneCount={hiddenDoneCount}
      hasActiveFilters={hasActiveFilters}
      onClearFilters={clearFilters}
    />
  );

  // Main content area
  let content: React.ReactNode;
  // No project after loading means a redirect (/auth or Projects) is under way.
  if (loading || (!bootError && !selectedProjectId)) {
    content = (
      <div className="db-state-wrap">
        <SkeletonList rows={5} rowHeight="4.5rem" label="Loading tasks" />
      </div>
    );
  } else if (bootError) {
    content = (
      <div className="db-state-wrap">
        <AlertBanner tone="danger" title="Could not load tasks">
          {bootError}
        </AlertBanner>
        <Button
          variant="ghost"
          size="sm"
          className="db-retry-btn"
          onClick={() => window.location.reload()}
        >
          Retry
        </Button>
      </div>
    );
  } else if (tasks.length === 0) {
    // A project with no tasks at all: one first-run state in either view
    // instead of five empty columns or an empty table. Tasks hidden by the
    // filters (tasks.length > 0) keep the per-column placeholders.
    content = (
      <BoardEmptyState
        teamId={selectedProject?.teamId}
        canConnectAgent={canConnectAgent}
        onNewTask={() => {
          setNewTaskInitialStatus(DEFAULT_CREATE_STATUS);
          setBootError(null);
          setShowNewTask(true);
        }}
        onImport={() => setShowImport(true)}
      />
    );
  } else if (viewMode === "board") {
    content = (
      <>
        {/* Status summary only in list view per spec; board columns are self-documenting */}
        <BoardView
          tasks={filteredTasks}
          activeTaskId={activeTaskId}
          templateFields={templateFields}
          confidenceThreshold={selectedProject?.confidenceThreshold ?? null}
          taskTypeThresholds={selectedProject?.taskTypeThresholds ?? null}
          onSelectTask={selectTask}
          onAddTask={(status) => {
            // BoardView only renders the + on Backlog/Open columns, so
            // status here is always one of those two; NewTaskModal still
            // clamps anything else to its own default as a robustness net.
            setNewTaskInitialStatus(status);
            setBootError(null);
            setShowNewTask(true);
          }}
        />
      </>
    );
  } else {
    // List view: status summary bar + table
    content = (
      <>
        <div className="db-status-summary">
          {STATUSES.map((s) => (
            <StatusChip key={s} status={s.replace(/_/g, "-")} />
          ))}
          <span className="db-filter-label">
            {filteredTasks.length} / {tasks.length} tasks shown
          </span>
        </div>
        <TaskListView
          tasks={filteredTasks}
          onSelectTask={selectTask}
          page={listPage}
          pageSize={LIST_PAGE_SIZE}
          onPageChange={setListPage}
        />
      </>
    );
  }

  return (
    <div className="db-shell">
      {toolbar}
      {filterBar}
      {accessBanner}

      {/* The one target of the hub layout's "Skip to board" link, present in
          every state (loading, error, first run, board, list). */}
      <div id={BOARD_REGION_ID} className="db-board-region" tabIndex={-1}>
        {content}
      </div>

      {/* NewTaskModal — extracted to components/dashboard/NewTaskModal.tsx in D2 */}
      <NewTaskModal
        open={showNewTask}
        onClose={() => setShowNewTask(false)}
        projectId={selectedProjectId}
        templateFields={templateFields}
        templatePresets={selectedProject?.taskTemplate?.presets ?? []}
        enforcementMode={selectedProject?.enforcementMode ?? null}
        confidenceThreshold={selectedProject?.confidenceThreshold ?? null}
        taskTypeThresholds={selectedProject?.taskTypeThresholds ?? null}
        initialStatus={newTaskInitialStatus}
        onTaskCreated={(task) => {
          setTasks((prev) => [task, ...prev]);
          setActiveTaskId(null);
        }}
        onEditTask={(id) => selectTask(id, true)}
      />

      {/* TaskDetail modal */}
      {activeTaskDetail && (
        <TaskDetail
          task={activeTaskDetail}
          tasks={tasks}
          user={user}
          templateFields={templateFields}
          confidenceThreshold={selectedProject?.confidenceThreshold ?? GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD}
          taskTypeThresholds={selectedProject?.taskTypeThresholds ?? null}
          enforcementMode={selectedProject?.enforcementMode ?? null}
          requireDistinctReviewer={selectedProject?.requireDistinctReviewer ?? false}
          isProjectAdmin={isProjectAdmin}
          isProjectWrite={isProjectWrite}
          workflowTransitions={workflowTransitions}
          onUpdate={handleTaskUpdate}
          onDelete={handleTaskDelete}
          onClose={() => selectTask(null)}
          initialEditing={editActiveOnOpen}
          onError={(msg) => toast(msg, "error")}
        />
      )}

      {/* Import dialog */}
      {selectedProjectId && (
        <ImportDialog
          open={showImport}
          onClose={() => setShowImport(false)}
          projectId={selectedProjectId}
          apiBase=""
          onImported={() => {
            getTasks(selectedProjectId).then(setTasks).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
