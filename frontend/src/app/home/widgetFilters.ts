// Pure predicates behind the /home dashboard's widget filters. Split out of
// page.tsx (a Next.js page module, which can't carry extra named exports)
// so they stay unit-testable without rendering the full auth/team-fetching
// page.

import type { Task, Workflow } from "../../lib/api";
import {
  BUILT_IN_REVIEW_STATES,
  BUILT_IN_TERMINAL_STATES,
  storedReviewStates,
  storedTerminalStates,
  storedWorkStates,
} from "../../lib/workflow-vocabulary";

/** Agent-created draft awaiting operator promotion out of backlog. */
export function isBacklogTask(t: Pick<Task, "status">): boolean {
  return t.status === "backlog";
}

/** Statuses that count as actionable work on the /home dashboard. */
const ACTIONABLE_STATUSES: ReadonlySet<string> = new Set(["open", "in_progress", "review"]);

/** The two names outside every workflow definition (backend BACKLOG_STATE, ABANDONED_STATE). */
const NON_ACTIONABLE_STATUSES: ReadonlySet<string> = new Set(["backlog", "abandoned"]);

/** What a task row needs for its workflow to be found. */
export type WorkflowTask = Pick<Task, "projectId"> & { workflowId?: string | null };

/** The status names of one task's own workflow (terminal, review-like). */
export type StatesOf = (task: WorkflowTask) => ReadonlySet<string>;

/** The terminal states of one task's own workflow. */
export type TerminalStatesOf = StatesOf;

/** The review-like states of one task's own workflow. */
export type ReviewStatesOf = StatesOf;

/** Terminal states of the built-in workflow (backend defaultWorkflowDefinition). */
const BUILT_IN_TERMINAL_SET: ReadonlySet<string> = new Set(BUILT_IN_TERMINAL_STATES);

/** Review-like state of the built-in workflow (backend defaultWorkflowDefinition). */
const BUILT_IN_REVIEW_SET: ReadonlySet<string> = new Set(BUILT_IN_REVIEW_STATES);

// The terminal and review-like names of a stored workflow are the backend's:
// they are read from the sanitized definition, with the built-in names as the
// fallback for one that cannot be read (see lib/workflow-vocabulary.ts).
const terminalNames = (workflow: Workflow): ReadonlySet<string> => new Set(storedTerminalStates(workflow));
const reviewNames = (workflow: Workflow): ReadonlySet<string> => new Set(storedReviewStates(workflow));

/**
 * The workflow row a task follows, the way the backend's home count finds it
 * (workflow-status-filter.ts isStatusOfKind): the task's pinned workflow, else
 * the project's default workflow. `byProject` holds the workflow rows of each
 * project, oldest first as the API lists them per project (default first), so
 * the first default row wins like the backend's. Undefined for a project that
 * is not in the map, which then reads as the built-in workflow.
 */
function workflowRowOf(
  byProject: ReadonlyMap<string, readonly Workflow[]>,
  task: WorkflowTask,
): Workflow | undefined {
  const rows = byProject.get(task.projectId) ?? [];
  const pinned = task.workflowId ? rows.find((w) => w.id === task.workflowId) : undefined;
  return pinned ?? rows.find((w) => w.isDefault);
}

/**
 * Resolves a task's terminal states the way the backend's home count does:
 * its workflow row (see workflowRowOf), else the built-in workflow (`done`).
 */
export function terminalStatesResolver(byProject: ReadonlyMap<string, readonly Workflow[]>): TerminalStatesOf {
  return (task) => {
    const row = workflowRowOf(byProject, task);
    return row ? terminalNames(row) : BUILT_IN_TERMINAL_SET;
  };
}

/** Resolves a task's review-like states: its workflow row, else the built-in `review`. */
export function reviewStatesResolver(byProject: ReadonlyMap<string, readonly Workflow[]>): ReviewStatesOf {
  return (task) => {
    const row = workflowRowOf(byProject, task);
    return row ? reviewNames(row) : BUILT_IN_REVIEW_SET;
  };
}

/** The status names a scope asks for, over all the projects' workflows. */
export interface WorkflowStatusNames {
  /** Non-terminal work states: open, in progress, review and every custom non-terminal state. */
  actionable: string[];
  /** Review-like states: the built-in `review` plus every review-like state of a stored workflow. */
  review: string[];
  /** Terminal states: the built-in `done` plus every terminal state of a stored workflow. */
  terminal: string[];
}

/**
 * The status names behind the /tasks scope presets and the Home widgets, from
 * the stored workflows of the projects. The built-in names are always in, in
 * front: a project that is not in `byProject` (not loaded yet, or its list is
 * not readable) reads as the built-in workflow. A name that is terminal in one
 * workflow and open in another lands in both lists; a request asks for the
 * union and the per-task resolvers drop the rows where it means the other
 * thing. An unreadable stored definition reads as the built-in workflow.
 */
export function workflowStatusNames(byProject: ReadonlyMap<string, readonly Workflow[]>): WorkflowStatusNames {
  const actionable = new Set<string>(ACTIONABLE_STATUSES);
  const review = new Set<string>(BUILT_IN_REVIEW_STATES);
  const terminal = new Set<string>(BUILT_IN_TERMINAL_STATES);
  for (const rows of byProject.values()) {
    for (const w of rows) {
      for (const name of storedTerminalStates(w)) terminal.add(name);
      for (const name of storedWorkStates(w)) if (!NON_ACTIONABLE_STATUSES.has(name)) actionable.add(name);
      for (const name of storedReviewStates(w)) review.add(name);
    }
  }
  return { actionable: [...actionable], review: [...review], terminal: [...terminal] };
}

/**
 * The status names the priority and mine widgets ask for: the three built-in
 * actionable ones plus every non-terminal state of a stored workflow. A name
 * that is terminal in one workflow and open in another is requested; the
 * per-task check in isActionableTask drops the rows where it is terminal.
 */
export function actionableStatusParam(byProject: ReadonlyMap<string, readonly Workflow[]>): string {
  return workflowStatusNames(byProject).actionable.join(",");
}

/**
 * Actionable work: not a backlog draft, not abandoned and not in a terminal
 * state of its own workflow (so a custom non-terminal state is actionable and
 * a custom terminal state is done). Without `terminalStatesOf` only the
 * built-in allowlist (open, in progress, review) counts.
 */
export function isActionableTask(
  t: Pick<Task, "status"> & Partial<WorkflowTask>,
  terminalStatesOf?: TerminalStatesOf,
): boolean {
  if (!terminalStatesOf) return ACTIONABLE_STATUSES.has(t.status);
  if (NON_ACTIONABLE_STATUSES.has(t.status)) return false;
  return !terminalStatesOf({ projectId: t.projectId ?? "", workflowId: t.workflowId }).has(t.status);
}

/**
 * High/critical priority AND actionable (isActionableTask). Done and abandoned tasks are
 * finished, and backlog drafts are not promoted yet (they surface in their own
 * widget instead).
 *
 * Without `terminalStatesOf` only open, in-progress or in-review count, the
 * allowlist of the built-in workflow. With it, a task counts unless its status
 * is `backlog`, `abandoned` or a terminal state of its own workflow, so a
 * custom non-terminal state is actionable and a custom terminal state is done.
 */
// Kept in sync with the backend priorityCount query (routes/tasks.ts,
// counts.priority) and the /tasks scope=priority preset: all three use
// this status rule.
export function isPriorityTask(
  t: Pick<Task, "priority" | "status"> & Partial<WorkflowTask>,
  terminalStatesOf?: TerminalStatesOf,
): boolean {
  if (t.priority !== "CRITICAL" && t.priority !== "HIGH") return false;
  return isActionableTask(t, terminalStatesOf);
}

// ── Active (open + in_progress) ───────────────────────────────────────────────

/**
 * The one definition of "active" work: open and in progress. Review is its own
 * scope and a draft in backlog is not started, so neither counts. Home's
 * "Active" tile and widget, its "Your projects" strip and the "N active
 * tasks" on /projects all go through this list, so the same project shows the
 * same number everywhere. The backend's `counts.open` is the same two
 * statuses.
 */
export const ACTIVE_STATUSES = ["open", "in_progress"] as const;

/** `status` query value for a request that fetches the active scope. */
export const ACTIVE_STATUS_PARAM = ACTIVE_STATUSES.join(",");

export function isActiveTask(t: Pick<Task, "status">): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(t.status);
}

// ── Widget requests ───────────────────────────────────────────────────────────

/** Rows a widget shows before its "+N more" link. */
export const WIDGET_LIMIT = 10;

/**
 * The active widget also feeds the per-project counts of the "Your projects"
 * strip, which are only shown when this fetch is provably complete
 * (`counts.open <= rows`). The backend's default page size, so the request
 * is no bigger than the one Home used to make for everything.
 */
export const ACTIVE_FETCH_LIMIT = 500;

export type WidgetKey = "mine" | "priority" | "backlog" | "open" | "review" | "done";

export interface WidgetRequest {
  status: string;
  priority?: string;
  mine?: boolean;
  recency?: "recent";
  limit: number;
}

/**
 * One scoped request per widget, so a widget's rows come from its own scope
 * and not from whatever happens to be in one capped slice of the whole team
 * (the backend returns at most 500 rows per call, newest update first).
 * `counts` in every response is team-wide and independent of these filters.
 * Statuses follow the `/tasks` scope presets, so a widget lists the same rows
 * its "N total" link opens. (The backend's `counts.mine` also counts claimed
 * backlog and abandoned tasks, so that total can exceed the rows.)
 */
export const WIDGET_REQUESTS: Record<WidgetKey, WidgetRequest> = {
  mine: { status: "open,in_progress,review", mine: true, limit: WIDGET_LIMIT },
  priority: { status: "open,in_progress,review", priority: "CRITICAL,HIGH", limit: WIDGET_LIMIT },
  backlog: { status: "backlog", limit: WIDGET_LIMIT },
  open: { status: ACTIVE_STATUS_PARAM, limit: ACTIVE_FETCH_LIMIT },
  review: { status: "review", limit: WIDGET_LIMIT },
  done: { status: "done", recency: "recent", limit: WIDGET_LIMIT },
};

/**
 * The request of one widget once the projects' workflows are known: the mine
 * and priority widgets ask for every actionable name, the review widget for
 * every review-like name and the done widget for every terminal name (the
 * `/tasks` presets of the same scopes resolve the same lists). Without any
 * workflow this is WIDGET_REQUESTS[key], the fixed built-in lists, which stay
 * the fallback when the workflows cannot be read. The widgets that are not
 * defined by a workflow (backlog, active) keep their fixed request.
 */
export function widgetRequest(
  key: WidgetKey,
  byProject: ReadonlyMap<string, readonly Workflow[]>,
): WidgetRequest {
  const base = WIDGET_REQUESTS[key];
  if (key === "mine" || key === "priority") {
    return { ...base, status: workflowStatusNames(byProject).actionable.join(",") };
  }
  if (key === "review") return { ...base, status: workflowStatusNames(byProject).review.join(",") };
  if (key === "done") return { ...base, status: workflowStatusNames(byProject).terminal.join(",") };
  return base;
}
