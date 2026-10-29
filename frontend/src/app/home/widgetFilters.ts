// Pure predicates behind the /home dashboard's widget filters. Split out of
// page.tsx (a Next.js page module, which can't carry extra named exports)
// so they stay unit-testable without rendering the full auth/team-fetching
// page.

import type { Task, Workflow } from "../../lib/api";

/** Agent-created draft awaiting operator promotion out of backlog. */
export function isBacklogTask(t: Pick<Task, "status">): boolean {
  return t.status === "backlog";
}

/** Statuses that count as actionable work on the /home dashboard. */
const ACTIONABLE_STATUSES: ReadonlySet<string> = new Set(["open", "in_progress", "review"]);

/** The two names outside every workflow definition (backend BACKLOG_STATE, ABANDONED_STATE). */
const NON_ACTIONABLE_STATUSES: ReadonlySet<string> = new Set(["backlog", "abandoned"]);

/** Terminal states of the built-in workflow (backend defaultWorkflowDefinition). */
const BUILT_IN_TERMINAL_STATES: ReadonlySet<string> = new Set(["done"]);

/** What a task row needs for its workflow to be found. */
export type WorkflowTask = Pick<Task, "projectId"> & { workflowId?: string | null };

/** The terminal states of one task's own workflow. */
export type TerminalStatesOf = (task: WorkflowTask) => ReadonlySet<string>;

function terminalNames(workflow: Workflow): Set<string> {
  const states = workflow.definition?.states;
  return new Set(Array.isArray(states) ? states.filter((s) => s.terminal).map((s) => s.name) : []);
}

/**
 * Resolves a task's terminal states the way the backend's home count does
 * (workflow-status-filter.ts isStatusOfKind): the task's pinned workflow, else
 * the project's default workflow, else the built-in one (`done`). `byProject`
 * holds the workflow rows of each project, oldest first as the API lists them
 * per project (default first), so the first default row wins like the backend's.
 * A project that is not in the map reads as built-in.
 */
export function terminalStatesResolver(byProject: ReadonlyMap<string, readonly Workflow[]>): TerminalStatesOf {
  return (task) => {
    const rows = byProject.get(task.projectId) ?? [];
    const pinned = task.workflowId ? rows.find((w) => w.id === task.workflowId) : undefined;
    const row = pinned ?? rows.find((w) => w.isDefault);
    return row ? terminalNames(row) : BUILT_IN_TERMINAL_STATES;
  };
}

/**
 * The status names the priority widget asks for: the three built-in actionable
 * ones plus every non-terminal state of a stored workflow. A name that is
 * terminal in one workflow and open in another is requested; the per-task
 * check in isPriorityTask drops the rows where it is terminal.
 */
export function actionableStatusParam(byProject: ReadonlyMap<string, readonly Workflow[]>): string {
  const names = new Set<string>(ACTIONABLE_STATUSES);
  for (const rows of byProject.values()) {
    for (const w of rows) {
      const states = w.definition?.states;
      if (!Array.isArray(states)) continue;
      for (const s of states) {
        if (!s.terminal && !NON_ACTIONABLE_STATUSES.has(s.name)) names.add(s.name);
      }
    }
  }
  return [...names].join(",");
}

/**
 * High/critical priority AND actionable. Done and abandoned tasks are
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
  if (!terminalStatesOf) return ACTIONABLE_STATUSES.has(t.status);
  if (NON_ACTIONABLE_STATUSES.has(t.status)) return false;
  return !terminalStatesOf({ projectId: t.projectId ?? "", workflowId: t.workflowId }).has(t.status);
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
