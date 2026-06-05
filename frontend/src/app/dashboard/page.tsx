"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type TemplateData,
  type CreateConfidence,
} from "../../lib/api";
import { calculateConfidence, type TemplateFields } from "../../lib/confidence";
import { PRIORITY_COLORS } from "../../lib/priorityColors";
import { formatRelativeTime, formatAbsoluteDate } from "../../lib/time";
import {
  DONE_BOARD_VISIBLE_LIMIT,
  DEFAULT_DONE_VISIBILITY,
  isDoneTaskHidden,
  readStoredDoneVisibility,
  storeDoneVisibility,
  readStoredViewMode,
  storeViewMode,
  readStoredSort,
  storeSort,
  type DoneVisibility,
  type DashboardViewMode,
} from "../../lib/dashboardPrefs";
import AppHeader from "../../components/AppHeader";
import ConfidenceBadge from "../../components/ConfidenceBadge";
import CreateConfidencePanel from "../../components/CreateConfidencePanel";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import DropdownMenu from "../../components/ui/DropdownMenu";
import EmptyState from "../../components/ui/EmptyState";
import FormField from "../../components/ui/FormField";
import Modal from "../../components/ui/Modal";
import Pagination from "../../components/ui/Pagination";
import { SkeletonList } from "../../components/ui/Skeleton";
import TaskDetail from "../../components/TaskDetail";
import ImportDialog from "../../components/ImportDialog";
import Select from "@/components/ui/Select";

const STATUSES = ["open", "in_progress", "review", "done"] as const;
type Status = (typeof STATUSES)[number];

type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type SortColumn = "title" | "status" | "assignee" | "due" | "updated" | "priority";
type SortDirection = "asc" | "desc";
interface SortState { column: SortColumn; direction: SortDirection; }

const STATUS_LABELS: Record<Status, string> = {
  open: "Open",
  in_progress: "In Progress",
  review: "In Review",
  done: "Done",
};

const STATUS_COLORS: Record<string, string> = {
  open: "var(--muted)",
  in_progress: "var(--primary)",
  review: "var(--warning)",
  done: "var(--success)",
};

const PRIORITY_RANK: Record<Priority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};
const STATUS_RANK: Record<string, number> = {
  open: 0,
  in_progress: 1,
  review: 2,
  done: 3,
};

const NATURAL_SORT_DIR: Record<SortColumn, SortDirection> = {
  title: "asc",
  status: "asc",
  assignee: "asc",
  due: "asc",
  updated: "desc",
  priority: "desc",
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

const TaskCard = memo(function TaskCard({
  task,
  active,
  onSelect,
  templateFields,
}: {
  task: Task;
  active: boolean;
  onSelect: (taskId: string) => void;
  templateFields?: TemplateFields | null;
}) {
  return (
    <button
      className="task-card"
      type="button"
      onClick={() => onSelect(task.id)}
      style={{
        width: "100%",
        textAlign: "left",
        background: active ? "var(--primary-muted)" : "var(--surface)",
        border: `1px solid ${active ? "var(--primary)" : "var(--border)"}`,
        borderRadius: "10px",
        padding: "0.6rem 0.7rem",
        marginBottom: "0.4rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", marginBottom: "0.25rem", minWidth: 0 }}>
        <p className="text-break-anywhere" style={{ fontWeight: 600, fontSize: "var(--text-base)", lineHeight: 1.35, color: "var(--text)", display: "flex", alignItems: "center", gap: "0.4rem", minWidth: 0 }}>
          <span
            role="img"
            aria-label={`Status: ${STATUS_LABELS[task.status as Status] ?? task.status}`}
            title={STATUS_LABELS[task.status as Status] ?? task.status}
            style={{ width: "7px", height: "7px", borderRadius: "50%", background: STATUS_COLORS[task.status] ?? "var(--muted)", flexShrink: 0 }}
          />
          {task.title}
        </p>
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
          className="text-break-anywhere"
          style={{
            color: "var(--muted)",
            fontSize: "var(--text-xs)",
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
      {(task.externalRef || (task.labels && task.labels.length > 0)) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginBottom: "0.35rem", minWidth: 0 }}>
          {task.externalRef && (
            <span className="text-break-anywhere" title={task.externalRef} style={{ fontSize: "var(--text-xs)", color: "var(--primary)", background: "var(--primary-muted)", borderRadius: "4px", padding: "0.1rem 0.35rem", fontWeight: 600, fontFamily: "monospace", maxWidth: "100%" }}>
              {task.externalRef}
            </span>
          )}
          {task.labels?.map((label) => (
            <span key={label} className="text-break-anywhere" title={label} style={{ fontSize: "var(--text-xs)", color: "var(--muted)", background: "color-mix(in srgb, var(--muted) 15%, transparent)", borderRadius: "4px", padding: "0.1rem 0.35rem", maxWidth: "100%" }}>
              {label}
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
          <span className="status-chip" style={{ color: PRIORITY_COLORS[task.priority] }}>{task.priority}</span>
          <ConfidenceBadge score={calculateConfidence({ title: task.title, description: task.description, templateData: task.templateData, templateFields }).score} />
          {isOverdue(task) && (
            <span className="status-chip" style={{ color: "var(--danger)", borderColor: "color-mix(in srgb, var(--danger) 55%, var(--border) 45%)" }}>
              Overdue
            </span>
          )}
        </div>
        <div style={{ textAlign: "right", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
          <div>{getAssigneeName(task)}</div>
          <div>{task.dueAt ? `Due ${toDateInputValue(task.dueAt)}` : "No due date"}</div>
          <div title={formatAbsoluteDate(task.updatedAt)}>{formatRelativeTime(task.updatedAt)}</div>
        </div>
      </div>
    </button>
  );
});

function BoardColumns({
  tasks,
  activeTaskId,
  onSelectTask,
  templateFields,
}: {
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  templateFields?: TemplateFields | null;
}) {
  // The done column accumulates without bound on an active project; cap
  // it at DONE_BOARD_VISIBLE_LIMIT cards with an expander so it stops
  // dominating the board. Other columns are never capped.
  const [showAllDone, setShowAllDone] = useState(false);
  return (
    <div className="board-columns" style={{ alignItems: "start" }}>
      {STATUSES.map((status) => {
        const columnTasks = sortTasksForBoardColumn(tasks.filter((task) => task.status === status));
        const capped = status === "done" && !showAllDone && columnTasks.length > DONE_BOARD_VISIBLE_LIMIT;
        const visibleTasks = capped ? columnTasks.slice(0, DONE_BOARD_VISIBLE_LIMIT) : columnTasks;
        const overflowCount = columnTasks.length - visibleTasks.length;
        return (
          <section key={status}>
            <div style={{ position: "sticky", top: 0, zIndex: 2, background: "var(--bg)", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem", paddingBottom: "0.35rem", borderBottom: "1px solid var(--border)" }}>
              <h3 style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>
                {STATUS_LABELS[status]}
              </h3>
              <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)", background: "var(--primary-muted)", borderRadius: "999px", padding: "0.1rem 0.45rem", fontWeight: 600 }}>{columnTasks.length}</span>
            </div>
            {columnTasks.length === 0 ? (
              <div style={{ border: "1px dashed var(--border)", borderRadius: "10px", padding: "1rem", color: "var(--muted)", textAlign: "center", fontSize: "var(--text-xs)" }}>
                No tasks
              </div>
            ) : (
              <>
                {visibleTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    active={task.id === activeTaskId}
                    onSelect={onSelectTask}
                    templateFields={templateFields}
                  />
                ))}
                {status === "done" && columnTasks.length > DONE_BOARD_VISIBLE_LIMIT && (
                  <button
                    type="button"
                    className="filter-chip"
                    style={{ width: "100%", marginTop: "0.2rem" }}
                    onClick={() => setShowAllDone((value) => !value)}
                  >
                    {showAllDone ? "Show less" : `… ${overflowCount} more`}
                  </button>
                )}
              </>
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
  const [showImport, setShowImport] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
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
  // The server's authoritative create-time confidence for the task just created.
  // When set, the modal shows the result panel instead of the form.
  const [createdConfidence, setCreatedConfidence] = useState<CreateConfidence | null>(null);
  // A self-assignment failure for the just-created task, shown inside the result
  // panel (the task itself was created; only the claim failed).
  const [createdAssignmentError, setCreatedAssignmentError] = useState<string | null>(null);
  // The id of the just-created task, so the panel's "Edit task" can open it.
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [taskQuery, setTaskQuery] = useState("");
  const [taskScope, setTaskScope] = useState<"all" | "mine" | "overdue" | "unassigned">("all");
  const [doneVisibility, setDoneVisibility] = useState<DoneVisibility>(DEFAULT_DONE_VISIBILITY);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [viewMode, setViewMode] = useState<DashboardViewMode>("board");
  const [sortState, setSortState] = useState<SortState>({ column: "updated", direction: "desc" });
  const [listPage, setListPage] = useState(1);
  // View preferences (done visibility, view mode, sort) persist in
  // localStorage. They load AFTER mount via the effect below to avoid an
  // SSR/hydration mismatch; `prefsLoaded` then gates the persist effects
  // so they don't clobber the stored values with the initial defaults.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const projectTriggerRef = useRef<HTMLButtonElement | null>(null);
  const selectedTeam = useMemo(
    () => teams.find((team) => team.id === selectedTeamId) ?? null,
    [teams, selectedTeamId],
  );

  // Restore persisted view preferences once, after mount.
  useEffect(() => {
    setDoneVisibility(readStoredDoneVisibility());
    setViewMode(readStoredViewMode());
    const storedSort = readStoredSort(Object.keys(NATURAL_SORT_DIR));
    if (storedSort) {
      setSortState({ column: storedSort.column as SortColumn, direction: storedSort.direction });
    }
    setPrefsLoaded(true);
  }, []);

  // Persist each preference on change (guarded so the initial defaults
  // don't overwrite what was just restored above).
  useEffect(() => {
    if (prefsLoaded) storeDoneVisibility(doneVisibility);
  }, [doneVisibility, prefsLoaded]);
  useEffect(() => {
    if (prefsLoaded) storeViewMode(viewMode);
  }, [viewMode, prefsLoaded]);
  useEffect(() => {
    if (prefsLoaded) storeSort({ column: sortState.column, direction: sortState.direction });
  }, [sortState, prefsLoaded]);

  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeTaskDetail, setActiveTaskDetail] = useState<Task | null>(null);
  // When true, the next opened task detail starts in edit mode (set only by the
  // create-confidence panel's "Edit task"; reset on every other open + on close).
  const [editActiveOnOpen, setEditActiveOnOpen] = useState(false);

  // Open a task's detail. `edit` is opt-in (panel "Edit task"); all normal opens
  // pass it false so a board/list click never inherits a stale edit-mode flag.
  const selectTask = useCallback((id: string | null, edit = false) => {
    setEditActiveOnOpen(edit);
    setActiveTaskId(id);
  }, []);

  // Fetch full task detail (with comments/attachments) when a task is selected
  useEffect(() => {
    if (!activeTaskId) {
      setActiveTaskDetail(null);
      return;
    }
    let cancelled = false;
    void getTask(activeTaskId).then((task) => {
      if (!cancelled) setActiveTaskDetail(task);
    });
    return () => { cancelled = true; };
  }, [activeTaskId]);

  const activeTask = activeTaskDetail;
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
      return `${task.title} ${task.description ?? ""} ${task.externalRef ?? ""} ${(task.labels ?? []).join(" ")}`.toLowerCase().includes(normalizedQuery);
    });
  }, [tasks, taskQuery, taskScope, doneVisibility, labelFilter, user?.id]);

  // Count of done tasks the current visibility hides — surfaced as a
  // one-click reveal so nothing feels silently dropped.
  const hiddenDoneCount = useMemo(() => {
    if (doneVisibility === "all") return 0;
    const now = Date.now();
    return tasks.filter(
      (task) => task.status === "done" && isDoneTaskHidden(doneVisibility, task.updatedAt, now),
    ).length;
  }, [tasks, doneVisibility]);

  const allLabels = useMemo(() => {
    const set = new Set<string>();
    for (const task of tasks) {
      for (const label of task.labels ?? []) set.add(label);
    }
    return [...set].sort();
  }, [tasks]);

  const statusSummary = useMemo(() => {
    return STATUSES.reduce<Record<Status, number>>((acc, status) => {
      acc[status] = filteredTasks.filter((task) => task.status === status).length;
      return acc;
    }, { open: 0, in_progress: 0, review: 0, done: 0 });
  }, [filteredTasks]);
  const hasActiveFilters = taskQuery.trim().length > 0 || taskScope !== "all" || doneVisibility !== DEFAULT_DONE_VISIBILITY || labelFilter !== null;

  function toggleSort(column: SortColumn) {
    setSortState((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { column, direction: NATURAL_SORT_DIR[column] };
    });
  }

  const listSortedTasks = useMemo(() => {
    const dir = sortState.direction === "asc" ? 1 : -1;
    return [...filteredTasks].sort((a, b) => {
      let cmp = 0;
      switch (sortState.column) {
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
        case "status":
          cmp = (STATUS_RANK[a.status] ?? 0) - (STATUS_RANK[b.status] ?? 0);
          break;
        case "assignee":
          cmp = getAssigneeName(a).localeCompare(getAssigneeName(b));
          break;
        case "due": {
          const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
          const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
          cmp = aDue - bDue;
          break;
        }
        case "updated":
          cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          break;
        case "priority":
          cmp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
          break;
      }
      return cmp * dir;
    });
  }, [filteredTasks, sortState]);

  const listTotalPages = Math.max(1, Math.ceil(listSortedTasks.length / LIST_PAGE_SIZE));
  const currentListPage = Math.min(listPage, listTotalPages);
  const listPageTasks = useMemo(() => {
    const start = (currentListPage - 1) * LIST_PAGE_SIZE;
    return listSortedTasks.slice(start, start + LIST_PAGE_SIZE);
  }, [currentListPage, listSortedTasks]);

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
    setCreatedConfidence(null);
    setCreatedAssignmentError(null);
    setCreatedTaskId(null);
  }

  function closeNewTaskModal() {
    setShowNewTask(false);
    resetNewTaskFields();
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const templateFields = selectedProject?.taskTemplate?.fields ?? null;

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
        setActiveTaskId(
          requestedTaskId && projectTasks.some((t) => t.id === requestedTaskId)
            ? requestedTaskId
            : null,
        );

        updateUrl(resolvedTeam.id, resolvedProject.id);
      } catch (err) {
        setError((err as Error).message);
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
        // silent – avoid error banner for background polls
      }
    }, 15_000);
    return () => clearInterval(interval);
  }, [selectedProjectId]);

  useEffect(() => {
    setListPage(1);
  }, [selectedProjectId, taskQuery, taskScope, doneVisibility, sortState, viewMode]);

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
      const tplData: TemplateData = {};
      if (newTaskGoal.trim()) tplData.goal = newTaskGoal.trim();
      if (newTaskAcceptanceCriteria.trim()) tplData.acceptanceCriteria = newTaskAcceptanceCriteria.trim();
      if (newTaskContext.trim()) tplData.context = newTaskContext.trim();
      if (newTaskConstraints.trim()) tplData.constraints = newTaskConstraints.trim();
      const hasTemplateData = Object.keys(tplData).length > 0;

      const { task: created, confidence } = await createTask(selectedProjectId, {
        title: newTaskTitle.trim(),
        description: newTaskDescription.trim() || undefined,
        status: newTaskStatus,
        priority: newTaskPriority,
        dueAt: toIsoDateOrNull(newTaskDueAt) ?? undefined,
        ...(hasTemplateData ? { templateData: tplData } : {}),
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
      // Surface the backend's authoritative create-time confidence in the modal.
      // A self-assignment failure is shown INSIDE the result panel alongside the
      // confidence (the task was created; only the claim failed) rather than as a
      // page-level banner the modal overlay would hide. Fall back to the old
      // close-on-success behaviour if an older backend omits confidence; there
      // the assignment error has no panel to live in, so surface it on the page.
      if (confidence) {
        setCreatedTaskId(task.id);
        setCreatedAssignmentError(assignmentError);
        setCreatedConfidence(confidence);
      } else {
        if (assignmentError) setError(assignmentError);
        closeNewTaskModal();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingTask(false);
    }
  }

  function handleTaskUpdate(updated: Task) {
    setTasks((prev) => prev.map((task) => (task.id === updated.id ? updated : task)));
    setActiveTaskDetail(updated);
  }

  function handleTaskDelete(taskId: string) {
    setTasks((prev) => prev.filter((task) => task.id !== taskId));
    setActiveTaskId(null);
  }

  return (
    <main className="page-shell">
      <AppHeader
        user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null}
        boardHref={selectedTeamId && selectedProjectId ? `/dashboard?teamId=${selectedTeamId}&projectId=${selectedProjectId}` : "/dashboard"}
      />

      {selectedProject?.accessSource === "project" && (
        <div style={{ marginBottom: "var(--space-3)" }}>
          <AlertBanner tone="info">
            This project is shared with you. You access it through a per-project
            invite, not via the team. PR operations on the linked GitHub
            repository require your own collaborator-level access on the repo.
          </AlertBanner>
        </div>
      )}

      <section
        className="dashboard-select-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(220px, 360px) auto",
          gap: "0.6rem",
          marginBottom: "1rem",
          alignItems: "end",
        }}
      >
        <div className="project-select-wrap">
          <FormField label="Project">
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
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
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                }}
              >
                {selectedProject?.accessSource === "project" && (
                  <ShareIcon title="Shared with you" />
                )}
                {selectedProject?.name ?? "Select a project"}
              </span>
              <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>{projectMenuOpen ? "▲" : "▼"}</span>
            </button>
            {selectedProjectId && (
              <>
              <Link
                href={`/projects/workflow?projectId=${selectedProjectId}`}
                className="project-settings-icon"
                aria-label="Workflow settings"
                title="Workflow & gates"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="2.5" />
                  <path d="M6.83 2.17a.5.5 0 0 1 .49-.4h1.36a.5.5 0 0 1 .49.4l.2 1.1a4.5 4.5 0 0 1 1.09.63l1.05-.35a.5.5 0 0 1 .58.2l.68 1.18a.5.5 0 0 1-.1.6l-.84.75a4.5 4.5 0 0 1 0 1.26l.84.75a.5.5 0 0 1 .1.6l-.68 1.18a.5.5 0 0 1-.58.2l-1.05-.35a4.5 4.5 0 0 1-1.09.63l-.2 1.1a.5.5 0 0 1-.49.4H7.32a.5.5 0 0 1-.49-.4l-.2-1.1a4.5 4.5 0 0 1-1.09-.63l-1.05.35a.5.5 0 0 1-.58-.2l-.68-1.18a.5.5 0 0 1 .1-.6l.84-.75a4.5 4.5 0 0 1 0-1.26l-.84-.75a.5.5 0 0 1-.1-.6l.68-1.18a.5.5 0 0 1 .58-.2l1.05.35a4.5 4.5 0 0 1 1.09-.63l.2-1.1z" />
                </svg>
              </Link>
              <Link
                href={`/projects/${selectedProjectId}/members`}
                className="project-settings-icon"
                aria-label="Project members"
                title="Project members & invites"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="6" cy="6" r="2.5" />
                  <path d="M2 13a4 4 0 0 1 8 0" />
                  <circle cx="11.5" cy="5" r="1.8" />
                  <path d="M9.5 12.5a3 3 0 0 1 5 0" />
                </svg>
              </Link>
              <Link
                href={`/projects/${selectedProjectId}/settings`}
                className="project-settings-icon"
                aria-label="Template settings"
                title="Agent template & confidence settings"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                  <path d="M5 6h6M5 8h4M5 10h5" />
                </svg>
              </Link>
              </>
            )}
            </div>
          </FormField>
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
                    title={project.accessSource === "project" ? `${project.name} (shared)` : project.name}
                    style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
                  >
                    {project.accessSource === "project" && <ShareIcon title="Shared" />}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {project.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </DropdownMenu>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "end", gap: "0.5rem", flexWrap: "wrap" }}>
          <div>
            <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.25rem" }}>View</p>
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
          <Button
            variant="ghost"
            onClick={() => setShowImport(true)}
            disabled={!selectedProjectId}
          >
            Import
          </Button>
          <Button
            onClick={() => {
              setError(null);
              setShowNewTask(true);
            }}
            disabled={!selectedProjectId}
          >
            + New Task
          </Button>
        </div>
      </section>

      <Modal open={showNewTask} onClose={closeNewTaskModal} title={createdConfidence ? "Task created" : "New Task"}>
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
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ marginBottom: "0.5rem" }}>
              <FormField label="Title">
                <input value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} required style={{ width: "100%" }} />
              </FormField>
            </div>

            <div style={{ marginBottom: "0.5rem" }}>
              <FormField label="Description">
                <textarea value={newTaskDescription} onChange={(e) => setNewTaskDescription(e.target.value)} rows={5} style={{ width: "100%", resize: "vertical" }} />
              </FormField>
            </div>

            <div className="new-task-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.5rem" }}>
              <FormField label="Status">
                <Select value={newTaskStatus} onChange={(v) => setNewTaskStatus(v as Status)} options={STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] }))} style={{ width: "100%" }} />
              </FormField>
              <FormField label="Priority">
                <Select value={newTaskPriority} onChange={(v) => setNewTaskPriority(v as Priority)} options={[{value:"LOW",label:"LOW"},{value:"MEDIUM",label:"MEDIUM"},{value:"HIGH",label:"HIGH"},{value:"CRITICAL",label:"CRITICAL"}]} style={{ width: "100%" }} />
              </FormField>
              <FormField label="Due Date">
                <input type="date" value={newTaskDueAt} onChange={(e) => setNewTaskDueAt(e.target.value)} style={{ width: "100%" }} />
              </FormField>
            </div>
            <div style={{ marginTop: "0.5rem" }}>
              <FormField label="Assignee">
                <Select
                  value={newTaskAssignee}
                  onChange={(v) => setNewTaskAssignee(v as "unassigned" | "me")}
                  options={[{value:"unassigned",label:"Unassigned"},{value:"me",label:"Assign to me"}]}
                  style={{ width: "100%" }}
                />
              </FormField>
            </div>

            {templateFields && (
              <div style={{ marginTop: "0.75rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
                <p style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text)" }}>Agent Template</p>
                {(selectedProject?.taskTemplate?.presets?.length ?? 0) > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", marginBottom: "0.5rem" }}>
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
                        }}
                      >
                        {preset.name}
                      </button>
                    ))}
                  </div>
                )}
                {templateFields.goal && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Goal">
                      <textarea value={newTaskGoal} onChange={(e) => setNewTaskGoal(e.target.value)} rows={2} style={{ width: "100%", resize: "vertical" }} placeholder="What should be achieved?" />
                    </FormField>
                  </div>
                )}
                {templateFields.acceptanceCriteria && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Acceptance Criteria">
                      <textarea value={newTaskAcceptanceCriteria} onChange={(e) => setNewTaskAcceptanceCriteria(e.target.value)} rows={3} style={{ width: "100%", resize: "vertical" }} placeholder="When is this task done?" />
                    </FormField>
                  </div>
                )}
                {templateFields.context && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Context">
                      <textarea value={newTaskContext} onChange={(e) => setNewTaskContext(e.target.value)} rows={2} style={{ width: "100%", resize: "vertical" }} placeholder="Relevant files, links, dependencies…" />
                    </FormField>
                  </div>
                )}
                {templateFields.constraints && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <FormField label="Constraints">
                      <textarea value={newTaskConstraints} onChange={(e) => setNewTaskConstraints(e.target.value)} rows={2} style={{ width: "100%", resize: "vertical" }} placeholder="What must not happen?" />
                    </FormField>
                  </div>
                )}
                <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                  Confidence:{" "}
                  <ConfidenceBadge
                    score={calculateConfidence({
                      title: newTaskTitle,
                      description: newTaskDescription || null,
                      templateData: { goal: newTaskGoal || undefined, acceptanceCriteria: newTaskAcceptanceCriteria || undefined, context: newTaskContext || undefined, constraints: newTaskConstraints || undefined },
                      templateFields,
                    }).score}
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

      <Card padding="sm" style={{ marginBottom: "0.9rem" }}>
        <div className="board-toolbar">
          <input
            type="search"
            aria-label="Search tasks"
            value={taskQuery}
            onChange={(e) => setTaskQuery(e.target.value)}
            placeholder="Search tasks..."
            style={{ width: "100%" }}
          />
        </div>
        <div className="scope-chip-row" style={{ alignItems: "center" }}>
          <div className="board-scope-inline">
            <span>Scope</span>
            <Select
              ariaLabel="Scope"
              value={taskScope}
              onChange={(v) => setTaskScope(v as "all" | "mine" | "overdue" | "unassigned")}
              options={[
                { value: "all", label: "All tasks" },
                { value: "mine", label: "Assigned to me" },
                { value: "overdue", label: "Overdue" },
                { value: "unassigned", label: "Unassigned" },
              ]}
              style={{ minWidth: 150 }}
            />
          </div>
          <div className="board-scope-inline">
            <span>Done</span>
            <Select
              ariaLabel="Done"
              value={doneVisibility}
              onChange={(v) => setDoneVisibility(v as DoneVisibility)}
              options={[
                { value: "recent", label: "Recent" },
                { value: "all", label: "All" },
                { value: "none", label: "None" },
              ]}
              style={{ minWidth: 110 }}
            />
            {hiddenDoneCount > 0 && doneVisibility !== "all" && (
              <button
                type="button"
                title="Show all done tasks"
                onClick={() => setDoneVisibility("all")}
                style={{ background: "none", border: "none", padding: 0, color: "var(--primary)", cursor: "pointer", fontSize: "var(--text-xs)", fontWeight: 600 }}
              >
                Show {hiddenDoneCount} hidden
              </button>
            )}
          </div>
          {allLabels.length > 0 && (
            <div className="board-scope-inline">
              <span>Labels</span>
              <Select
                ariaLabel="Labels"
                value={labelFilter ?? ""}
                onChange={(v) => setLabelFilter(v || null)}
                options={[{ value: "", label: "All labels" }, ...allLabels.map((label) => ({ value: label, label }))]}
                style={{ minWidth: 130 }}
              />
            </div>
          )}
          {hasActiveFilters && (
            <button
              type="button"
              className="filter-chip filter-chip-clear"
              style={{ marginLeft: "auto" }}
              onClick={() => {
                setTaskQuery("");
                setTaskScope("all");
                setDoneVisibility(DEFAULT_DONE_VISIBILITY);
                setLabelFilter(null);
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        {/* Rendered in both list and board views so the toolbar height
            stays stable across the view toggle (no reflow). In board view
            it duplicates the per-column counts, an accepted trade-off. */}
        <div className="status-summary">
          {STATUSES.map((status) => (
            <span key={status} className="status-chip">
              {STATUS_LABELS[status]}: {statusSummary[status]}
            </span>
          ))}
        </div>
      </Card>

      {loading ? (
        <div style={{ padding: "0.5rem 0" }}>
          <SkeletonList rows={5} rowHeight="4.5rem" label="Loading tasks" />
        </div>
      ) : error ? (
        <AlertBanner tone="danger" title="Error">
          {error}
        </AlertBanner>
      ) : !selectedTeamId ? (
        <EmptyState message="Select a team to continue." />
      ) : !selectedProjectId ? (
        <EmptyState message={`Select a project to view tasks for ${selectedTeam?.name ?? "this team"}.`} />
      ) : (
        <div className="dashboard-grid">
          <section style={{ minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem", gap: "0.5rem", flexWrap: "wrap" }}>
              <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
                {filteredTasks.length} / {tasks.length} tasks
              </p>
              <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
                {projects.find((project) => project.id === selectedProjectId)?.name}
              </p>
            </div>
            {viewMode === "board" ? (
              <BoardColumns tasks={filteredTasks} activeTaskId={activeTaskId} onSelectTask={selectTask} templateFields={templateFields} />
            ) : (
              <div className="task-list-shell">
                <div className="task-list-head">
                  {([
                    ["title", "Task"],
                    ["status", "Status"],
                    ["assignee", "Assignee"],
                    ["due", "Due"],
                    ["updated", "Updated"],
                    ["priority", "Priority"],
                  ] as [SortColumn, string][]).map(([col, label]) => (
                    <button
                      key={col}
                      type="button"
                      className={sortState.column === col ? "sort-active" : ""}
                      onClick={() => toggleSort(col)}
                    >
                      {label}
                      {sortState.column === col && (
                        <span style={{ color: "var(--primary)", marginLeft: "0.25rem" }}>
                          {sortState.direction === "asc" ? "▲" : "▼"}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {listPageTasks.length === 0 ? (
                  <div style={{ padding: "1rem", color: "var(--muted)", textAlign: "center" }}>No tasks in this list view.</div>
                ) : (
                  listPageTasks.map((task, index) => (
                    <button
                      key={task.id}
                      type="button"
                      className="task-list-row"
                      onClick={() => selectTask(task.id)}
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
                        <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                          {task.title}
                        </span>
                      </span>
                      <span className="task-list-cell-status" data-label="Status">
                        <span className="status-chip" style={{ color: STATUS_COLORS[task.status] }}>
                          {STATUS_LABELS[task.status as Status]}
                        </span>
                      </span>
                      <span className="task-list-cell-muted" data-label="Assignee" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {getAssigneeName(task)}
                      </span>
                      <span className="task-list-cell-muted" data-label="Due" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {task.dueAt ? toDateInputValue(task.dueAt) : "No due date"}
                      </span>
                      <span className="task-list-cell-updated" title={formatAbsoluteDate(task.updatedAt)}>
                        {formatRelativeTime(task.updatedAt)}
                      </span>
                      <span className="task-list-cell-priority" data-label="Priority">
                        <span className="status-chip" style={{ color: PRIORITY_COLORS[task.priority] }}>
                          {task.priority}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
            {viewMode === "list" && (
              <Pagination
                page={currentListPage}
                totalPages={listTotalPages}
                onPageChange={setListPage}
              />
            )}
          </section>
        </div>
      )}

      {activeTask && (
        <TaskDetail
          task={activeTask}
          tasks={tasks}
          user={user}
          templateFields={templateFields}
          confidenceThreshold={selectedProject?.confidenceThreshold ?? 60}
          requireDistinctReviewer={selectedProject?.requireDistinctReviewer ?? false}
          onUpdate={handleTaskUpdate}
          onDelete={handleTaskDelete}
          onClose={() => selectTask(null)}
          initialEditing={editActiveOnOpen}
          onError={(msg) => setError(msg)}
        />
      )}

      {selectedProjectId && (
        <ImportDialog
          open={showImport}
          onClose={() => setShowImport(false)}
          projectId={selectedProjectId}
          apiBase=""
          onImported={() => { getTasks(selectedProjectId).then(setTasks).catch(() => {}); }}
        />
      )}

    </main>
  );
}

/**
 * Inline share marker rendered next to a project's name when the user
 * accesses the project via a per-project invite (`accessSource: "project"`)
 * rather than full team membership. Sized to align with adjacent text in
 * the project picker; tone follows the `--primary` token used elsewhere
 * for "info" affordances.
 */
function ShareIcon({ title }: { title: string }) {
  return (
    <span
      title={title}
      aria-label={title}
      role="img"
      style={{ color: "var(--primary)", display: "inline-flex" }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="3.5" cy="8" r="2" />
        <circle cx="12" cy="3.5" r="2" />
        <circle cx="12" cy="12.5" r="2" />
        <path d="M5.2 7.1l5.2-2.5M5.2 8.9l5.2 2.5" />
      </svg>
    </span>
  );
}
