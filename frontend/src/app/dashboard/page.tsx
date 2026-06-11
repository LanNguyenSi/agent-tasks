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
  createTask,
  claimTask,
  type User,
  type Team,
  type Project,
  type Task,
  type CreateConfidence,
} from "../../lib/api";
import { calculateConfidence, TASK_TYPES, type TaskType } from "../../lib/confidence";
import { buildSavedTemplateData } from "../../lib/templateData";
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
import ConfidenceBadge from "../../components/ConfidenceBadge";
import CreateConfidencePanel from "../../components/CreateConfidencePanel";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import EmptyState from "../../components/ui/EmptyState";
import FormField from "../../components/ui/FormField";
import { Icon } from "../../components/ui/Icon";
import { KeyHint } from "../../components/ui/KeyHint";
import Modal from "../../components/ui/Modal";
import { PageHeader } from "../../components/ui/PageHeader";
import { SkeletonList } from "../../components/ui/Skeleton";
import { StatusChip } from "../../components/ui/StatusChip";
import { Tabs } from "../../components/ui/Tabs";
import { useToast } from "../../components/ui/Toast";
import TaskDetail from "../../components/TaskDetail";
import ImportDialog from "../../components/ImportDialog";
import Select from "../../components/ui/Select";
import DropdownMenu from "../../components/ui/DropdownMenu";
import ProjectPicker from "../../components/dashboard/ProjectPicker";
import FilterToolbar from "../../components/dashboard/FilterToolbar";
import BoardView from "../../components/dashboard/BoardView";
import TaskListView from "../../components/dashboard/TaskListView";

// ── Types ────────────────────────────────────────────────────────

const STATUSES = ["open", "in_progress", "review", "done"] as const;
type Status = (typeof STATUSES)[number];
type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

const LIST_PAGE_SIZE = 12;

// ── Helpers ──────────────────────────────────────────────────────

function isOverdue(task: Task): boolean {
  if (!task.dueAt || task.status === "done") return false;
  return new Date(task.dueAt).getTime() < Date.now();
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
  const [creatingTask, setCreatingTask] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  // NewTaskModal fields
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
  const [newTaskScope, setNewTaskScope] = useState("");
  const [newTaskOutOfScope, setNewTaskOutOfScope] = useState("");
  const [newTaskDependencies, setNewTaskDependencies] = useState("");
  const [newTaskRisk, setNewTaskRisk] = useState("");
  const [newTaskAgentPrompt, setNewTaskAgentPrompt] = useState("");
  const [newTaskTaskType, setNewTaskTaskType] = useState<TaskType | "">("");
  const [createdConfidence, setCreatedConfidence] = useState<CreateConfidence | null>(null);
  const [createdAssignmentError, setCreatedAssignmentError] = useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);

  const newTaskTemplateData = useMemo(
    () =>
      buildSavedTemplateData(null, {
        goal: newTaskGoal,
        acceptanceCriteria: newTaskAcceptanceCriteria,
        context: newTaskContext,
        constraints: newTaskConstraints,
        scope: newTaskScope,
        outOfScope: newTaskOutOfScope,
        dependencies: newTaskDependencies,
        risk: newTaskRisk,
        agentPrompt: newTaskAgentPrompt,
        taskType: newTaskTaskType,
      }),
    [
      newTaskGoal,
      newTaskAcceptanceCriteria,
      newTaskContext,
      newTaskConstraints,
      newTaskScope,
      newTaskOutOfScope,
      newTaskDependencies,
      newTaskRisk,
      newTaskAgentPrompt,
      newTaskTaskType,
    ],
  );

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

  // ── Create task ──────────────────────────────────────────────

  function resetNewTaskFields() {
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
    setNewTaskScope("");
    setNewTaskOutOfScope("");
    setNewTaskDependencies("");
    setNewTaskRisk("");
    setNewTaskAgentPrompt("");
    setNewTaskTaskType("");
    setCreatedConfidence(null);
    setCreatedAssignmentError(null);
    setCreatedTaskId(null);
  }

  function closeNewTaskModal() {
    setShowNewTask(false);
    resetNewTaskFields();
  }

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProjectId || !newTaskTitle.trim()) return;
    setCreatingTask(true);
    try {
      const { task: created, confidence } = await createTask(selectedProjectId, {
        title: newTaskTitle.trim(),
        description: newTaskDescription.trim() || undefined,
        status: newTaskStatus,
        priority: newTaskPriority,
        dueAt: toIsoDateOrNull(newTaskDueAt) ?? undefined,
        ...(newTaskTemplateData ? { templateData: newTaskTemplateData } : {}),
      });

      let task = created;
      let assignmentError: string | null = null;
      if (newTaskAssignee === "me") {
        try {
          task = await claimTask(task.id);
        } catch (claimError) {
          assignmentError = `Self-assignment failed: ${(claimError as Error).message}`;
        }
      }

      setTasks((prev) => [task, ...prev]);
      setActiveTaskId(null);

      if (confidence) {
        setCreatedTaskId(task.id);
        setCreatedAssignmentError(assignmentError);
        setCreatedConfidence(confidence);
      } else {
        if (assignmentError) toast(assignmentError, "error");
        closeNewTaskModal();
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setCreatingTask(false);
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
            setNewTaskStatus(status);
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

      {/* NewTaskModal (inline per D1 scope; extracted in D2) */}
      <Modal
        open={showNewTask}
        onClose={closeNewTaskModal}
        title={createdConfidence ? "Task created" : "New Task"}
      >
        {createdConfidence ? (
          <CreateConfidencePanel
            confidence={createdConfidence}
            assignmentError={createdAssignmentError}
            onEdit={() => {
              const id = createdTaskId;
              closeNewTaskModal();
              if (id) selectTask(id, true);
            }}
            onClose={closeNewTaskModal}
          />
        ) : (
          <form onSubmit={(e) => void handleCreateTask(e)}>
            <div className="ntm-form-body">
              <div className="ntm-field-wrap">
                <FormField label="Title">
                  <input
                    className="ntm-w-full"
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    required
                  />
                </FormField>
              </div>

              <div className="ntm-field-wrap">
                <FormField label="Description">
                  <textarea
                    className="ntm-w-full ntm-resizable"
                    value={newTaskDescription}
                    onChange={(e) => setNewTaskDescription(e.target.value)}
                    rows={5}
                  />
                </FormField>
              </div>

              <div className="new-task-grid new-task-grid--gapped">
                <FormField label="Status">
                  <Select
                    className="ntm-w-full"
                    value={newTaskStatus}
                    onChange={(v) => setNewTaskStatus(v as Status)}
                    options={[
                      { value: "open", label: "Open" },
                      { value: "in_progress", label: "In Progress" },
                      { value: "review", label: "In Review" },
                      { value: "done", label: "Done" },
                    ]}
                  />
                </FormField>
                <FormField label="Priority">
                  <Select
                    className="ntm-w-full"
                    value={newTaskPriority}
                    onChange={(v) => setNewTaskPriority(v as Priority)}
                    options={[
                      { value: "LOW", label: "LOW" },
                      { value: "MEDIUM", label: "MEDIUM" },
                      { value: "HIGH", label: "HIGH" },
                      { value: "CRITICAL", label: "CRITICAL" },
                    ]}
                  />
                </FormField>
                <FormField label="Due Date">
                  <input
                    className="ntm-w-full"
                    type="date"
                    value={newTaskDueAt}
                    onChange={(e) => setNewTaskDueAt(e.target.value)}
                  />
                </FormField>
              </div>

              <div className="ntm-assignee-wrap">
                <FormField label="Assignee">
                  <Select
                    className="ntm-w-full"
                    value={newTaskAssignee}
                    onChange={(v) => setNewTaskAssignee(v as "unassigned" | "me")}
                    options={[
                      { value: "unassigned", label: "Unassigned" },
                      { value: "me", label: "Assign to me" },
                    ]}
                  />
                </FormField>
              </div>

              {templateFields && (
                <div className="ntm-template-section">
                  <p className="ntm-template-heading">Agent Template</p>
                  {(selectedProject?.taskTemplate?.presets?.length ?? 0) > 0 && (
                    <div className="ntm-preset-row">
                      {selectedProject!.taskTemplate!.presets!.map((preset) => (
                        <button
                          key={preset.name}
                          type="button"
                          className="filter-chip"
                          onClick={() => {
                            if (preset.description !== undefined) setNewTaskDescription(preset.description);
                            if (preset.goal !== undefined) setNewTaskGoal(preset.goal);
                            if (preset.acceptanceCriteria !== undefined) setNewTaskAcceptanceCriteria(preset.acceptanceCriteria);
                            if (preset.context !== undefined) setNewTaskContext(preset.context);
                            if (preset.constraints !== undefined) setNewTaskConstraints(preset.constraints);
                            if (preset.scope !== undefined) setNewTaskScope(preset.scope);
                            if (preset.outOfScope !== undefined) setNewTaskOutOfScope(preset.outOfScope);
                            if (preset.dependencies !== undefined) setNewTaskDependencies(preset.dependencies);
                            if (preset.risk !== undefined) setNewTaskRisk(preset.risk);
                            if (preset.agentPrompt !== undefined) setNewTaskAgentPrompt(preset.agentPrompt);
                            if (preset.taskType !== undefined) setNewTaskTaskType(preset.taskType);
                          }}
                        >
                          {preset.name}
                        </button>
                      ))}
                    </div>
                  )}
                  {templateFields.goal && (
                    <div className="ntm-field-wrap">
                      <FormField label="Goal">
                        <textarea className="ntm-w-full ntm-resizable" value={newTaskGoal} onChange={(e) => setNewTaskGoal(e.target.value)} rows={2} placeholder="What should be achieved?" />
                      </FormField>
                    </div>
                  )}
                  {templateFields.acceptanceCriteria && (
                    <div className="ntm-field-wrap">
                      <FormField label="Acceptance Criteria">
                        <textarea className="ntm-w-full ntm-resizable" value={newTaskAcceptanceCriteria} onChange={(e) => setNewTaskAcceptanceCriteria(e.target.value)} rows={3} placeholder="When is this task done?" />
                      </FormField>
                    </div>
                  )}
                  {templateFields.context && (
                    <div className="ntm-field-wrap">
                      <FormField label="Context">
                        <textarea className="ntm-w-full ntm-resizable" value={newTaskContext} onChange={(e) => setNewTaskContext(e.target.value)} rows={2} placeholder="Relevant files, links, dependencies…" />
                      </FormField>
                    </div>
                  )}
                  {templateFields.constraints && (
                    <div className="ntm-field-wrap">
                      <FormField label="Constraints">
                        <textarea className="ntm-w-full ntm-resizable" value={newTaskConstraints} onChange={(e) => setNewTaskConstraints(e.target.value)} rows={2} placeholder="What must not happen?" />
                      </FormField>
                    </div>
                  )}
                  {templateFields.scope && (
                    <div className="ntm-field-wrap">
                      <FormField label="Scope">
                        <textarea className="ntm-w-full ntm-resizable" value={newTaskScope} onChange={(e) => setNewTaskScope(e.target.value)} rows={2} placeholder="Files, modules, or surfaces this may touch" />
                      </FormField>
                    </div>
                  )}
                  {templateFields.outOfScope && (
                    <div className="ntm-field-wrap">
                      <FormField label="Out of Scope">
                        <textarea className="ntm-w-full ntm-resizable" value={newTaskOutOfScope} onChange={(e) => setNewTaskOutOfScope(e.target.value)} rows={2} placeholder="What must NOT change" />
                      </FormField>
                    </div>
                  )}
                  {templateFields.dependencies && (
                    <div className="ntm-field-wrap">
                      <FormField label="Dependencies">
                        <textarea className="ntm-w-full ntm-resizable" value={newTaskDependencies} onChange={(e) => setNewTaskDependencies(e.target.value)} rows={2} placeholder="Prerequisite work, or 'none'" />
                      </FormField>
                    </div>
                  )}
                  {templateFields.risk && (
                    <div className="ntm-field-wrap">
                      <FormField label="Risk">
                        <textarea className="ntm-w-full ntm-resizable" value={newTaskRisk} onChange={(e) => setNewTaskRisk(e.target.value)} rows={2} placeholder="Risk / blast radius (low / medium / high, and why)" />
                      </FormField>
                    </div>
                  )}
                  {templateFields.agentPrompt && (
                    <div className="ntm-field-wrap">
                      <FormField label="Agent Prompt">
                        <textarea
                          className="ntm-w-full ntm-resizable ntm-mono-area"
                          value={newTaskAgentPrompt}
                          onChange={(e) => setNewTaskAgentPrompt(e.target.value)}
                          rows={4}
                          placeholder="Step-by-step instructions a weak agent can execute verbatim"
                        />
                      </FormField>
                    </div>
                  )}
                  <div className="ntm-field-wrap">
                    <FormField label="Task Type">
                      <Select
                        className="ntm-w-full"
                        value={newTaskTaskType}
                        onChange={(v) => setNewTaskTaskType(v as TaskType | "")}
                        options={[{ value: "", label: "— none —" }, ...TASK_TYPES.map((t) => ({ value: t, label: t }))]}
                        ariaLabel="Task type"
                      />
                    </FormField>
                  </div>
                  <div className="ntm-confidence">
                    Confidence:{" "}
                    <ConfidenceBadge
                      score={
                        calculateConfidence({
                          title: newTaskTitle,
                          description: newTaskDescription || null,
                          templateData: newTaskTemplateData,
                          templateFields,
                        }).score
                      }
                    />
                  </div>
                </div>
              )}
            </div>

            <Button type="submit" disabled={creatingTask} loading={creatingTask} size="sm">
              {creatingTask ? "Creating…" : "Create task"}
            </Button>
          </form>
        )}
      </Modal>

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
