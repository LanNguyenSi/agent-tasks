"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeams,
  getProjects,
  getTasks,
  getTask,
  type User,
  type Team,
  type Project,
  type Task,
} from "../../lib/api";
import {
  DEFAULT_DONE_VISIBILITY,
  isDoneTaskHidden,
  readStoredDoneVisibility,
  storeDoneVisibility,
  readStoredViewMode,
  storeViewMode,
  type DoneVisibility,
  type DashboardViewMode,
} from "../../lib/dashboardPrefs";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import EmptyState from "../../components/ui/EmptyState";
import { Icon } from "../../components/ui/Icon";
import { KeyHint } from "../../components/ui/KeyHint";
import { PageHeader } from "../../components/ui/PageHeader";
import { SkeletonList } from "../../components/ui/Skeleton";
import { StatusChip } from "../../components/ui/StatusChip";
import { Tabs } from "../../components/ui/Tabs";
import { useToast } from "../../components/ui/Toast";
import TaskDetail from "../../components/TaskDetail";
import ImportDialog from "../../components/ImportDialog";
import DropdownMenu from "../../components/ui/DropdownMenu";
import ProjectPicker from "../../components/dashboard/ProjectPicker";
import FilterToolbar from "../../components/dashboard/FilterToolbar";
import BoardView from "../../components/dashboard/BoardView";
import TaskListView from "../../components/dashboard/TaskListView";
import NewTaskModal from "../../components/dashboard/NewTaskModal";

// ── Types ────────────────────────────────────────────────────────

const STATUSES = ["open", "in_progress", "review", "done"] as const;
type Status = (typeof STATUSES)[number];

const LIST_PAGE_SIZE = 12;

// ── Helpers ──────────────────────────────────────────────────────

function isOverdue(task: Task): boolean {
  if (!task.dueAt || task.status === "done") return false;
  return new Date(task.dueAt).getTime() < Date.now();
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

// ── Dashboard page ───────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [tasks, setTasks] = useState<Task[]>([]);

  // Separate boot error (prevents board mount) from action error (toast only).
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const [showNewTask, setShowNewTask] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  // Status preset when opening NewTaskModal from a board column's + button.
  const [newTaskInitialStatus, setNewTaskInitialStatus] = useState<Status>("open");

  const [taskQuery, setTaskQuery] = useState("");
  const [taskScope, setTaskScope] = useState<"all" | "mine" | "overdue" | "unassigned">("all");
  const [doneVisibility, setDoneVisibility] = useState<DoneVisibility>(DEFAULT_DONE_VISIBILITY);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DashboardViewMode>("board");
  const [listPage, setListPage] = useState(1);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  // Overflow menu (settings / members / workflow links)
  const overflowTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  // Search input ref for "/" shortcut focus
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const selectedTeam = useMemo(
    () => teams.find((t) => t.id === selectedTeamId) ?? null,
    [teams, selectedTeamId],
  );

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const templateFields = selectedProject?.taskTemplate?.fields ?? null;

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
    const normalizedQuery = taskQuery.trim().toLowerCase();
    const now = Date.now();
    return tasks.filter((task) => {
      if (task.status === "done" && isDoneTaskHidden(doneVisibility, task.updatedAt, now)) return false;
      if (taskScope === "mine" && task.claimedByUserId !== user?.id) return false;
      if (taskScope === "unassigned" && (task.claimedByUserId || task.claimedByAgentId)) return false;
      if (taskScope === "overdue" && !isOverdue(task)) return false;
      if (labelFilter && !(task.labels ?? []).includes(labelFilter)) return false;
      if (!normalizedQuery) return true;
      return `${task.title} ${task.description ?? ""} ${task.externalRef ?? ""} ${(task.labels ?? []).join(" ")}`
        .toLowerCase()
        .includes(normalizedQuery);
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

  useEffect(() => {
    void (async () => {
      try {
        const [me, userTeams] = await Promise.all([getCurrentUser(), getTeams()]);
        if (!me) {
          router.replace("/auth");
          return;
        }
        setUser(me);
        setTeams(userTeams);

        if (userTeams.length === 0) {
          router.replace("/onboarding");
          return;
        }

        const params = new URLSearchParams(window.location.search);
        const requestedTeamId = params.get("teamId");
        const requestedProjectId = params.get("projectId");
        const requestedTaskId = params.get("taskId");

        const resolvedTeam = userTeams.find((t) => t.id === requestedTeamId) ?? userTeams[0]!;
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
          teamProjects.find((p) => p.id === preferredProjectId) ?? teamProjects[0]!;
        setSelectedProjectId(resolvedProject.id);
        storeProjectId(resolvedTeam.id, resolvedProject.id);

        const projectTasks = await getTasks(resolvedProject.id);
        setTasks(projectTasks);
        setActiveTaskId(
          requestedTaskId && projectTasks.some((t) => t.id === requestedTaskId)
            ? requestedTaskId
            : null,
        );
        updateUrl(resolvedTeam.id, resolvedProject.id);
      } catch (err) {
        setBootError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

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
          setNewTaskInitialStatus("open");
          setBootError(null);
          setShowNewTask(true);
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedProjectId, showNewTask]);

  // ── Project change ───────────────────────────────────────────

  async function handleProjectChange(projectId: string) {
    if (!selectedTeamId) return;
    setSelectedProjectId(projectId);
    setBootError(null);
    setLoading(true);
    try {
      const projectTasks = await getTasks(projectId);
      setTasks(projectTasks);
      setActiveTaskId(null);
      storeProjectId(selectedTeamId, projectId);
      updateUrl(selectedTeamId, projectId);
    } catch (err) {
      setBootError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

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

  // Toolbar: project picker + summary + search + filter + view toggle + new task
  const toolbar = (
    <PageHeader
      breadcrumb={
        <>
          <span>{selectedTeam?.name ?? "Pandora Lab"}</span>
          <span>/</span>
        </>
      }
      title={
        <ProjectPicker
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelect={(id) => void handleProjectChange(id)}
          loading={loading}
        />
      }
      summary={
        selectedProjectId && !loading ? (
          <span className="num">
            {hasActiveFilters
              ? `${filteredTasks.length} / ${tasks.length} tasks`
              : `${filteredTasks.length} tasks`}
          </span>
        ) : undefined
      }
    >
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
          setNewTaskInitialStatus("open");
          setBootError(null);
          setShowNewTask(true);
        }}
        disabled={!selectedProjectId}
        keyHint="C"
      >
        <Icon name="plus" size={13} />
        New task
      </Button>

      {/* Overflow menu: workflow / members / settings */}
      {selectedProjectId && (
        <>
          <button
            ref={overflowTriggerRef}
            type="button"
            className="db-overflow-btn"
            aria-label="Project settings"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            onClick={() => setOverflowOpen((v) => !v)}
          >
            <Icon name="dots" size={14} />
          </button>
          <DropdownMenu
            anchorRef={overflowTriggerRef}
            open={overflowOpen}
            onClose={() => setOverflowOpen(false)}
            align="end"
            minWidth={180}
          >
            <Link
              href={`/projects/workflow?projectId=${selectedProjectId}`}
              className="app-dropdown-item"
              onClick={() => setOverflowOpen(false)}
            >
              Workflow &amp; gates
            </Link>
            <Link
              href={`/projects/${selectedProjectId}/members`}
              className="app-dropdown-item"
              onClick={() => setOverflowOpen(false)}
            >
              Members
            </Link>
            <Link
              href={`/projects/${selectedProjectId}/settings`}
              className="app-dropdown-item"
              onClick={() => setOverflowOpen(false)}
            >
              Settings
            </Link>
          </DropdownMenu>
        </>
      )}
    </PageHeader>
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
  if (loading) {
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
  } else if (!selectedTeamId) {
    content = (
      <div className="db-state-wrap">
        <EmptyState
          icon="box"
          title="No team selected"
          description="Join or create a team to get started."
          action={
            <Button href="/teams" size="sm">
              Go to Teams
            </Button>
          }
        />
      </div>
    );
  } else if (!selectedProjectId) {
    content = (
      <div className="db-state-wrap">
        <EmptyState
          icon="box"
          title="This team has no projects yet."
          description="Create a project to start tracking tasks."
          action={
            <Button href={`/teams?teamId=${selectedTeamId}`} size="sm">
              Create project
            </Button>
          }
        />
      </div>
    );
  } else if (viewMode === "board") {
    content = (
      <>
        {/* Status summary only in list view per spec; board columns are self-documenting */}
        <BoardView
          tasks={filteredTasks}
          activeTaskId={activeTaskId}
          onSelectTask={selectTask}
          onAddTask={(status) => {
            setNewTaskInitialStatus(status as Status);
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

      {content}

      {/* NewTaskModal — extracted to components/dashboard/NewTaskModal.tsx in D2 */}
      <NewTaskModal
        open={showNewTask}
        onClose={() => setShowNewTask(false)}
        projectId={selectedProjectId}
        templateFields={templateFields}
        templatePresets={selectedProject?.taskTemplate?.presets ?? []}
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
          confidenceThreshold={selectedProject?.confidenceThreshold ?? 60}
          requireDistinctReviewer={selectedProject?.requireDistinctReviewer ?? false}
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
