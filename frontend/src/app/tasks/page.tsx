"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  getCurrentUser,
  getTeamTasks,
  updateTask,
  type TeamTasksCounts,
  type TeamTasksProject,
  type Workflow,
} from "../../lib/api";
import { projectsHref, taskHref } from "../../lib/routes";
import { useCurrentTeam } from "../../lib/teamSwitch";
import { needsOnboarding } from "../../lib/access";
import { accessContextForTeams, usePageTeams } from "../../lib/teamList";
import { PageHeader } from "../../components/ui/PageHeader";
import { PageShell } from "../../components/ui/PageShell";
import { Button } from "../../components/ui/Button";
import { KeyHint } from "../../components/ui/KeyHint";
import { Tabs } from "../../components/ui/Tabs";
import { Icon } from "../../components/ui/Icon";
import AlertBanner from "../../components/ui/AlertBanner";
import EmptyState from "../../components/ui/EmptyState";
import { Skeleton, SkeletonList } from "../../components/ui/Skeleton";
import Pagination from "../../components/ui/Pagination";
import Select from "../../components/ui/Select";
import { Table } from "../../components/ui/Table";
import NewTaskFlow from "../../components/tasks/NewTaskFlow";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { workflowStatusNames, type WorkflowStatusNames } from "../home/widgetFilters";
import { useProjectWorkflows } from "./_components/useProjectWorkflows";
// Column definitions live outside this route file — see _components/columns.tsx
// for why (Next's typed-routes codegen rejects extra named exports from a
// page.tsx).
import {
  TASK_PAGE_COLUMNS,
  buildTaskPageColumns,
  isActionableRow,
  type EnrichedTask,
} from "./_components/columns";

type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type Status = "backlog" | "open" | "in_progress" | "review" | "done";
type SortColumn = "title" | "status" | "project" | "due" | "updated" | "priority";
type SortDirection = "asc" | "desc";
type Scope = "all" | "open" | "mine" | "priority" | "review" | "done";

/** One loaded page of the list, tagged with the team it was loaded for. */
interface TeamTasksPage {
  teamId: string;
  projects: TeamTasksProject[];
  tasks: EnrichedTask[];
  filteredTotal: number;
  counts: TeamTasksCounts | null;
}
const NO_PROJECTS: TeamTasksProject[] = [];
const NO_TASKS: EnrichedTask[] = [];

const STATUSES: Status[] = ["backlog", "open", "in_progress", "review", "done"];
const PRIORITIES: Priority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

// Labels for filter chips (underscore-form API keys).
const STATUS_CHIP_LABELS: Record<Status, string> = {
  backlog: "Backlog",
  open: "Open",
  in_progress: "In Progress",
  review: "In Review",
  done: "Done",
};

// Full scope labels used as H1.
const SCOPE_LABELS: Record<Scope, string> = {
  all: "All Tasks",
  open: "Active Tasks",
  mine: "My Tasks",
  priority: "Priority (High / Critical)",
  review: "In Review",
  done: "Recently Done",
};

// Shorter labels for the segmented control tabs.
const SCOPE_TAB_LABELS: Record<Scope, string> = {
  all: "All",
  open: "Active",
  mine: "My Tasks",
  priority: "Priority",
  review: "In Review",
  done: "Recently Done",
};

interface ScopePreset {
  priorities?: Priority[];
  mine?: boolean;
  defaultSort?: { column: SortColumn; direction: SortDirection };
}

const SCOPE_PRESETS: Record<Scope, ScopePreset> = {
  all: {},
  open: {},
  mine: { mine: true },
  priority: { priorities: ["CRITICAL", "HIGH"] },
  review: {},
  done: { defaultSort: { column: "updated", direction: "desc" } },
};

// The status chips a scope tab preselects. Active is fixed (open, in progress);
// the other tabs follow the workflow vocabulary of the team's projects (see
// workflowStatusNames: with no workflow known these are the built-in lists
// open/in_progress/review, review and done): My Tasks and Priority are the
// actionable states, In Review the review-like ones, Recently Done the
// terminal ones. The same lists the Home widgets of those scopes request.
function presetStatuses(scope: Scope, names: WorkflowStatusNames): string[] {
  switch (scope) {
    case "open":
      return ["open", "in_progress"];
    case "mine":
    case "priority":
      return names.actionable;
    case "review":
      return names.review;
    case "done":
      return names.terminal;
    default:
      return [];
  }
}

// One chip per status the filter knows: the five built-in names, then every
// other state name of the loaded workflows (first spelling of its label wins),
// so a custom state can be filtered on.
function statusChipsFor(
  byProject: ReadonlyMap<string, readonly Workflow[]>,
): { name: string; label: string }[] {
  const chips = STATUSES.map((name) => ({ name: name as string, label: STATUS_CHIP_LABELS[name] }));
  const seen = new Set<string>(STATUSES);
  for (const rows of byProject.values()) {
    for (const w of rows) {
      const states = w.definition?.states;
      if (!Array.isArray(states)) continue;
      for (const st of states) {
        if (seen.has(st.name)) continue;
        seen.add(st.name);
        chips.push({ name: st.name, label: st.label || st.name });
      }
    }
  }
  return chips;
}

const EMPTY_SENTINEL = "__any__";

type FilterSource = "url" | "preset";
interface FilterState<T> {
  values: T[];
  source: FilterSource;
}

// `allowed` null keeps every name: the status filter does not know the team's
// vocabulary until the workflows are read (and never does for a project whose
// workflow list answers 403), and a custom name in the URL must reach the
// first request and survive a chip click meanwhile. The backend checks the
// names against the team's vocabulary, so an unknown one comes back as an
// error instead of being dropped here.
function parseCsv<T extends string>(value: string | null, allowed: readonly T[] | null): T[] {
  if (!value) return [];
  const set = allowed ? new Set(allowed as readonly string[]) : null;
  const seen = new Set<string>();
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v): v is T => {
      if (!v || v === EMPTY_SENTINEL || seen.has(v)) return false;
      seen.add(v);
      return set === null || set.has(v);
    });
}

// Resolves a multi-value URL param with preset fallback. Supports the
// `__any__` sentinel meaning "user explicitly cleared the filter" so a
// preset-backed scope (e.g. Open) can be overridden to "show everything"
// without the preset snapping back on the next render.
function resolveFilter<T extends string>(
  rawParam: string | null,
  allowed: readonly T[] | null,
  presetDefault: readonly T[],
): FilterState<T> {
  if (rawParam === EMPTY_SENTINEL) return { values: [], source: "url" };
  const parsed = parseCsv(rawParam, allowed);
  if (parsed.length > 0) return { values: parsed, source: "url" };
  return { values: [...presetDefault] as T[], source: "preset" };
}

function parseSort(value: string | null): { column: SortColumn; direction: SortDirection } | null {
  if (!value) return null;
  const [col, dir] = value.split(":");
  const cols: SortColumn[] = ["title", "status", "project", "due", "updated", "priority"];
  if (!cols.includes(col as SortColumn)) return null;
  if (dir !== "asc" && dir !== "desc") return null;
  return { column: col as SortColumn, direction: dir };
}

// Order-insensitive set equality, used by the custom-filter check: the chips
// match the scope tab's preset when they hold exactly the same values, no
// matter the URL order (e.g. status=open,in_progress == the Active preset).
function sameValues(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}

// Skeleton shown during initial bootstrap and as the Suspense fallback.
// Used by both paths so the transition from Suspense -> inner -> loaded is smooth.
function TasksPageSkeleton() {
  return (
    <PageShell variant="wide" flush busy>
      <div className="tasks-skeleton-header">
        <div className="tasks-skeleton-header-left">
          <Skeleton width="160px" height="20px" />
          <Skeleton width="60px" height="12px" />
        </div>
        <div className="tasks-skeleton-header-right">
          <Skeleton width="160px" height="28px" />
          <Skeleton width="80px" height="28px" />
        </div>
      </div>
      <div className="tasks-skeleton-tabs">
        {[80, 60, 80, 70, 80, 110].map((w, i) => (
          <Skeleton key={i} width={`${w}px`} height="28px" radius="var(--radius-base)" />
        ))}
      </div>
      <div className="tasks-content">
        <span className="sr-only">Loading tasks</span>
        <SkeletonList rows={8} rowHeight="3rem" label="Loading tasks" />
      </div>
    </PageShell>
  );
}

function TasksPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // The list URL as it stands now (filters, sort, page). Task links carry it
  // as `from`, so /tasks/[id] can return to exactly this view.
  const listQuery = searchParams.toString();
  const listHref = listQuery ? `/tasks?${listQuery}` : "/tasks";

  const [userReady, setUserReady] = useState(false);
  // The shell's team list (one lookup for the header and the pages), not a
  // copy of this page's own; empty until the session check answered, so
  // without a session no team resolves and nothing is requested or written
  // into the URL. `teamsHeld`: ?teamId names a team that list lacks and its
  // one refresh is pending.
  const {
    teams,
    status: teamsStatus,
    error: teamsError,
    held: teamsHeld,
  } = usePageTeams(userReady);
  // Derived from the URL like the header's team (?teamId, remembered, first):
  // no team state of its own, so a switch and back/forward always agree.
  const selectedTeam = useCurrentTeam(teams, { hold: teamsHeld });
  const selectedTeamId = selectedTeam?.id ?? null;
  // The rows, projects and counts on screen are tagged with the team they
  // were loaded for and only shown under that team: after a team change the
  // page shows its loading state (or the new team's error) until the new
  // team's list arrives, never the old team's rows or projects.
  const [loaded, setLoaded] = useState<TeamTasksPage | null>(null);
  const teamPage = loaded && loaded.teamId === selectedTeamId ? loaded : null;
  const projects = teamPage?.projects ?? NO_PROJECTS;
  const serverTasks = teamPage?.tasks ?? NO_TASKS;
  const filteredTotal = teamPage?.filteredTotal ?? 0;
  const counts = teamPage?.counts ?? null;
  // loading = initial bootstrap; isFetching = background data refresh
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  // No team but shared projects: cross-project tasks need a team, so the page
  // explains that instead of redirecting to onboarding.
  const [noTeam, setNoTeam] = useState(false);
  // Tagged with its team like the list (null: no error). Dismissing the
  // banner keeps the error and only marks it dismissed: the failed load is
  // still the outcome for this team, so the page does not fall back to its
  // loading state while no request is in flight. With no list for the team
  // the region then shows a compact inline retry instead of nothing.
  const [fetchErrorState, setFetchErrorState] = useState<{
    teamId: string;
    message: string;
    dismissed?: boolean;
  } | null>(null);
  const teamFetchError =
    fetchErrorState && fetchErrorState.teamId === selectedTeamId ? fetchErrorState : null;
  // The banner's message: the current team's error unless dismissed.
  const fetchError = teamFetchError && !teamFetchError.dismissed ? teamFetchError.message : null;
  // The current team has neither a list nor an error yet.
  const awaitingTeamPage = selectedTeamId !== null && teamPage === null && teamFetchError === null;
  // A dismissed error with no list for the team: the region offers a compact
  // inline retry instead of showing nothing. The loading state returns only
  // with the next load of this team (this retry, a switch back, or the poll),
  // never from the dismissal itself.
  const dismissedErrorNoList =
    teamPage === null && teamFetchError != null && teamFetchError.dismissed === true;
  // The count, the New task button and its C shortcut wait for the current
  // team's list: before it exists the page would claim "0 tasks", and the
  // create flow "No projects yet", for a team that has both.
  const teamDataReady = teamPage !== null;
  const [isFetching, setIsFetching] = useState(false);
  // Incrementing retryToken forces the fetch effect to re-run without
  // changing any real filter params — used by the "Retry" button and to
  // refresh the list after an in-place task create.
  const [retryToken, setRetryToken] = useState(0);
  // In-place create flow (project picker + NewTaskModal), see NewTaskFlow.
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // Backlog Promote/Discard/Move-to-backlog row actions (see
  // _components/columns.tsx). busyTaskId disables the buttons on the
  // in-flight row; discardTarget drives the confirm dialog, mirroring
  // TaskDetail's delete-task confirm.
  const [rowActionBusyId, setRowActionBusyId] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<EnrichedTask | null>(null);
  // Tagged with the team the action ran under: an action that fails after a
  // team change does not report under the new team.
  const [rowActionErrorState, setRowActionErrorState] = useState<{
    teamId: string | null;
    message: string;
  } | null>(null);
  const rowActionError =
    rowActionErrorState && rowActionErrorState.teamId === selectedTeamId
      ? rowActionErrorState.message
      : null;
  // Focus targets that survive an action or a failed load: the results region
  // (tabIndex -1, so focus can land on it as a whole) and the inline
  // "Couldn't load tasks" Retry button.
  const tableRegionRef = useRef<HTMLDivElement | null>(null);
  const inlineRetryRef = useRef<HTMLDivElement | null>(null);
  // Set by the fetch banner's dismiss: the dismiss button unmounts with the
  // banner, so the inline Retry (which mounts in its place on the next
  // render) receives focus from the effect below, once it exists.
  const focusInlineRetryRef = useRef(false);
  // A row action that may drop its row (Promote/Discard/demote): where the
  // row sat among the actionable rows, and the retryToken value the action's
  // refresh bumps to, so its focus can be handed to the neighbouring row
  // when that refreshed list no longer contains it (the trigger itself
  // unmounts, and focus would fall to the document body). `token` ties the
  // entry to the action's own refresh: fetches completing under a different
  // token (the 30 s poll, a filter change, a Retry after a failed action)
  // must not consume it, and a failed action clears the entry outright.
  const rowFocusRecoveryRef = useRef<{
    taskId: string;
    teamId: string | null;
    triggerIndex: number;
    token: number;
  } | null>(null);
  // Set when the action's refreshed list completed without the row: the
  // effect below moves focus once that list has committed, i.e. once the
  // trigger is really gone from the DOM. It must not be a timer started next
  // to setLoaded: in a real browser a setTimeout(0) fires before React
  // commits the removal, when the actioned trigger is still mounted and
  // focused.
  const rowFocusHandoffRef = useRef<number | null>(null);

  // ── Parse URL params ──────────────────────────────────────────

  const scope: Scope = (() => {
    const raw = searchParams.get("scope");
    const SCOPES: Scope[] = ["all", "open", "mine", "priority", "review", "done"];
    return SCOPES.includes(raw as Scope) ? (raw as Scope) : "all";
  })();
  const preset = SCOPE_PRESETS[scope];
  // The status vocabulary of the team's projects: what the scope presets
  // preselect and which names the status filter accepts. Built-in names until
  // the workflows are read (and for a project whose workflows cannot be read).
  const workflowsByProject = useProjectWorkflows(selectedTeamId, projects);
  const statusNames = useMemo(() => workflowStatusNames(workflowsByProject), [workflowsByProject]);
  const statusChips = useMemo(() => statusChipsFor(workflowsByProject), [workflowsByProject]);
  const presetStatusList = useMemo(() => presetStatuses(scope, statusNames), [scope, statusNames]);

  // The names in the URL are not narrowed to the chips: see parseCsv.
  const statusState = resolveFilter<string>(searchParams.get("status"), null, presetStatusList);
  const priorityState = resolveFilter(searchParams.get("priority"), PRIORITIES, preset.priorities ?? []);
  const statusFilter = statusState.values;
  const priorityFilter = priorityState.values;
  const projectIdFilter = searchParams.get("projectId") ?? "";
  const searchQuery = searchParams.get("q") ?? "";
  // Tri-state: `mine=1` forces on, `mine=0` forces off, absent = preset.
  const mineParam = searchParams.get("mine");
  const mineOnly = mineParam === "1" ? true : mineParam === "0" ? false : preset.mine === true;
  const mineSource: FilterSource = mineParam === null ? "preset" : "url";
  const sort =
    parseSort(searchParams.get("sort")) ??
    preset.defaultSort ?? { column: "updated" as SortColumn, direction: "desc" as SortDirection };
  const pageSize = (() => {
    const raw = Number(searchParams.get("pageSize"));
    return PAGE_SIZE_OPTIONS.includes(raw) ? raw : DEFAULT_PAGE_SIZE;
  })();
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Done-scope recency window. The done view defaults to Recent (≤14d).
  const recency: "recent" | "older" | "all" = (() => {
    if (scope !== "done") return "all";
    const raw = searchParams.get("recency");
    return raw === "older" || raw === "all" ? raw : "recent";
  })();

  // Stable string keys so multi-value filters sit in the effect deps safely.
  const statusKey = statusFilter.join(",");
  const priorityKey = priorityFilter.join(",");

  // Local mirror of the URL `q` param so typing doesn't router.replace on
  // every keystroke; debounce effect below writes it after a pause.
  const [searchInput, setSearchInput] = useState(searchQuery);

  // ── Bootstrap: auth + teams ───────────────────────────────────

  useEffect(() => {
    void (async () => {
      try {
        const me = await getCurrentUser();
        if (!me) { router.replace("/auth"); return; }
        setUserReady(true);
      } catch (err) {
        setBootError(err instanceof Error ? err.message : "Failed to load. Please retry.");
        setLoading(false);
      }
    })();
  }, [router]);

  // Access decision once the user and the shell's team list are known; a
  // failed list lookup is the boot error.
  useEffect(() => {
    if (!userReady) return;
    if (teamsStatus === "error") {
      setBootError(teamsError?.message ?? "Failed to load. Please retry.");
      setLoading(false);
      return;
    }
    if (teamsStatus !== "ready") return;
    if (teams.length > 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const ctx = await accessContextForTeams(teams);
      if (cancelled) return;
      if (needsOnboarding(ctx)) { router.replace("/onboarding"); return; }
      setNoTeam(true);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userReady, teamsStatus, teamsError, teams, router]);

  // Re-sync the search box when the URL query changes from outside.
  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  // Debounce search writes: wait ~250ms after last keystroke before pushing
  // to URL. Deps are [searchInput] only — searchQuery is a no-op guard, and
  // updateParams is a pure URL helper, so excluding them is intentional.
  useEffect(() => {
    if (searchInput === searchQuery) return;
    const id = setTimeout(() => updateParams({ q: searchInput || null }), 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // ── Data fetch ────────────────────────────────────────────────

  // A team change closes what belongs to the team that was left: the create
  // flow (its picker and form hold that team's projects) and a pending
  // discard confirmation.
  useEffect(() => {
    if (!selectedTeamId) return;
    setNewTaskOpen(false);
    setDiscardTarget(null);
  }, [selectedTeamId]);

  useEffect(() => {
    if (!selectedTeam) return;
    let cancelled = false;

    // Server-side filter + sort + pagination: fetch exactly the rows shown.
    async function fetchPage(teamId: string) {
      setIsFetching(true);
      try {
        const r = await getTeamTasks(teamId, {
          status: statusKey || undefined,
          priority: priorityKey || undefined,
          projectId: projectIdFilter || undefined,
          mine: mineOnly || undefined,
          q: searchQuery.trim() || undefined,
          sort: `${sort.column}:${sort.direction}`,
          recency: scope === "done" ? recency : undefined,
          offset: (page - 1) * pageSize,
          limit: pageSize,
        });
        if (cancelled) return;
        setFetchErrorState(null);
        const projectName = new Map(r.projects.map((p) => [p.id, p.name]));
        const tasks: EnrichedTask[] = r.tasks.map((t) => ({
          ...t,
          projectName: projectName.get(t.projectId) ?? "(unknown)",
        }));
        setLoaded({
          teamId,
          projects: r.projects,
          tasks,
          filteredTotal: r.filteredTotal ?? r.tasks.length,
          counts: r.counts ?? null,
        });
        // Row-action focus recovery: this fetch ran under the retryToken the
        // pending action bumped, so it is the action's own refresh (no other
        // fetch matches that token). Row still in the list -> focus already
        // stayed on its own trigger; row gone -> record the handoff for the
        // post-commit effect below, where the trigger is really unmounted.
        const pendingRecovery = rowFocusRecoveryRef.current;
        if (
          pendingRecovery &&
          pendingRecovery.teamId === teamId &&
          pendingRecovery.token === retryToken
        ) {
          rowFocusRecoveryRef.current = null;
          if (!tasks.some((t) => t.id === pendingRecovery.taskId)) {
            rowFocusHandoffRef.current = pendingRecovery.triggerIndex;
          }
        }
      } catch (err) {
        if (!cancelled) {
          setFetchErrorState({
            teamId,
            message: err instanceof Error ? err.message : "Failed to load tasks.",
          });
        }
      } finally {
        if (!cancelled) setIsFetching(false);
      }
    }

    void fetchPage(selectedTeam.id);
    const interval = setInterval(() => void fetchPage(selectedTeam.id), 30_000);
    return () => { cancelled = true; clearInterval(interval); };
    // statusKey/priorityKey are stable serialisations of the array filters.
  }, [
    selectedTeam, scope, recency, page, pageSize, sort.column, sort.direction,
    projectIdFilter, mineOnly, searchQuery, statusKey, priorityKey, retryToken,
  ]);

  // Retry the current team's list: the shared Retry path of the error
  // banner and the inline message. Clearing the error re-arms the loading
  // state; bumping retryToken starts a fresh request. The Retry button that
  // was clicked unmounts with the error it retries (banner or inline
  // message), so focus moves to the results region first: focus lands on a
  // container that stays mounted across the refetch it starts.
  function retryFetch(): void {
    tableRegionRef.current?.focus();
    setFetchErrorState(null);
    setRetryToken((t) => t + 1);
  }

  // The dismiss button unmounts with the banner; on the render after the
  // dismissal the region's inline Retry exists (when the team has no list),
  // and focus goes to it -- or to the region when there is nothing to retry.
  useEffect(() => {
    if (!focusInlineRetryRef.current) return;
    focusInlineRetryRef.current = false;
    const retry = inlineRetryRef.current?.querySelector<HTMLButtonElement>("button");
    (retry ?? tableRegionRef.current)?.focus();
  });

  // Remember where the actioned row sits among the actionable rows, and the
  // retryToken the action's refresh will bump to (every handler below bumps
  // it once on success), so the fetch running under that token hands focus
  // to the row that takes the slot when the action drops the row.
  // noteRowAction runs before every action that PATCHes a status and
  // refreshes the list: Promote, Discard, Move to backlog.
  function noteRowAction(task: EnrichedTask): void {
    const actionable = serverTasks.filter(isActionableRow);
    rowFocusRecoveryRef.current = {
      taskId: task.id,
      teamId: selectedTeamId,
      triggerIndex: Math.max(0, actionable.findIndex((t) => t.id === task.id)),
      token: retryToken + 1,
    };
  }

  // Row-action focus recovery, run after the commit of the action's
  // refreshed list (rowFocusHandoffRef is set by that fetch's completion
  // above): the actioned row's trigger is now really unmounted, so focus has
  // fallen to the body. Move it to the trigger occupying the removed row's
  // slot (the next row, or the last row when it was the last one), or to the
  // results region when the table is now empty. Guarded on focus having
  // fallen to the body, so it never pulls focus the user has moved elsewhere
  // in the meantime.
  useEffect(() => {
    const triggerIndex = rowFocusHandoffRef.current;
    if (triggerIndex === null) return;
    rowFocusHandoffRef.current = null;
    if (document.activeElement !== document.body) return;
    const triggers = document.querySelectorAll<HTMLButtonElement>(".tasks-row-actions-btn");
    if (triggers.length === 0) {
      tableRegionRef.current?.focus();
      return;
    }
    triggers[Math.min(triggerIndex, triggers.length - 1)]?.focus();
  }, [loaded]);

  // "/" focuses the search input, "C" opens the create flow (the New-task
  // button advertises the shortcut via its KeyHint chip).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // While the create flow is up, page shortcuts must not steal focus
      // from behind the modal overlay.
      if (newTaskOpen) return;
      const tag = (e.target as HTMLElement).tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (isTyping || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "c" || e.key === "C") {
        // Like the New task button: no create flow before the current
        // team's projects are known.
        if (!teamDataReady) return;
        e.preventDefault();
        setNewTaskOpen(true);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [newTaskOpen, teamDataReady]);

  // Snap page back when the URL page overshoots the filtered set.
  useEffect(() => {
    const tp = Math.max(1, Math.ceil(filteredTotal / pageSize));
    if (filteredTotal > 0 && page > tp) {
      updateParams({ page: null });
    }
    // updateParams is a pure URL helper; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredTotal, pageSize, page]);

  // ── URL helpers ───────────────────────────────────────────────

  function updateParams(patch: Record<string, string | null>, resetPage = true): void {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    if (resetPage) next.delete("page");
    router.replace(`/tasks?${next.toString()}`);
  }

  function toggleInCsv(param: "status" | "priority", value: string, presetDefault: readonly string[]): void {
    const current: string[] = param === "status" ? [...statusFilter] : [...priorityFilter];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    if (next.length === 0) {
      updateParams({ [param]: presetDefault.length > 0 ? EMPTY_SENTINEL : null });
      return;
    }
    const matchesPreset =
      next.length === presetDefault.length && next.every((v) => presetDefault.includes(v));
    updateParams({ [param]: matchesPreset ? null : next.join(",") });
  }

  // Controlled sort callback for the Table primitive.
  // Ignores the proposed direction from Table; applies natural direction for new columns.
  function handleSortChange(key: string): void {
    const col = key as SortColumn;
    const nextDir: SortDirection =
      sort.column === col
        ? sort.direction === "asc" ? "desc" : "asc"
        : col === "title" || col === "project" ? "asc" : "desc";
    updateParams({ sort: `${col}:${nextDir}` }, false);
  }

  // Promote a backlog task to open. Server enforces the write-tier gate;
  // any failure (403/409/etc.) surfaces via rowActionError, same as the
  // fetch-error banner above.
  async function handlePromote(task: EnrichedTask): Promise<void> {
    const teamId = selectedTeamId;
    noteRowAction(task);
    setRowActionBusyId(task.id);
    setRowActionErrorState(null);
    try {
      await updateTask(task.id, { status: "open" });
      setRetryToken((t) => t + 1);
    } catch (err) {
      // The action failed: it will not drop the row, so a pending focus
      // recovery must not survive to a later refresh.
      rowFocusRecoveryRef.current = null;
      setRowActionErrorState({
        teamId,
        message: err instanceof Error ? err.message : "Failed to promote task.",
      });
    } finally {
      setRowActionBusyId(null);
    }
  }

  // Move an open, unclaimed task back to backlog. The server enforces the
  // write-tier gate and the no-claim rule atomically; a stale row that was
  // claimed in the meantime comes back as a 409 and surfaces via
  // rowActionError. No confirm dialog: unlike discard, the move is
  // reversible with Promote.
  async function handleDemote(task: EnrichedTask): Promise<void> {
    const teamId = selectedTeamId;
    noteRowAction(task);
    setRowActionBusyId(task.id);
    setRowActionErrorState(null);
    try {
      await updateTask(task.id, { status: "backlog" });
      setRetryToken((t) => t + 1);
    } catch (err) {
      rowFocusRecoveryRef.current = null;
      setRowActionErrorState({
        teamId,
        message: err instanceof Error ? err.message : "Failed to move task to backlog.",
      });
    } finally {
      setRowActionBusyId(null);
    }
  }

  function requestDiscard(task: EnrichedTask): void {
    setDiscardTarget(task);
  }

  async function confirmDiscard(): Promise<void> {
    if (!discardTarget) return;
    const task = discardTarget;
    const teamId = selectedTeamId;
    noteRowAction(task);
    setRowActionBusyId(task.id);
    setRowActionErrorState(null);
    try {
      await updateTask(task.id, { status: "abandoned" });
      setDiscardTarget(null);
      setRetryToken((t) => t + 1);
    } catch (err) {
      rowFocusRecoveryRef.current = null;
      setRowActionErrorState({
        teamId,
        message: err instanceof Error ? err.message : "Failed to discard task.",
      });
      setDiscardTarget(null);
    } finally {
      setRowActionBusyId(null);
    }
  }

  function clearFilters(): void {
    const next = new URLSearchParams();
    const teamId = searchParams.get("teamId");
    if (teamId) next.set("teamId", teamId);
    if (scope !== "all") next.set("scope", scope);
    router.replace(`/tasks?${next.toString()}`);
  }

  // Tab-row "Reset to <tab label>": drops exactly the overrides that made
  // the view a custom filter (status, priority, mine) and keeps the active
  // scope tab (and teamId), i.e. goes back to the tab's own preset. The tab
  // label in the name tells it apart from the filter band's "Clear filters".
  function resetFilterToPreset(): void {
    updateParams({ status: null, priority: null, mine: null });
  }

  // ── Derived values ────────────────────────────────────────────

  // Custom filter: the effective status/priority chips or the mine flag no
  // longer match the active scope tab's preset. Derived from the resolved
  // filter values, not the URL's presence, so an explicit chip set equal to
  // the preset is not custom. When true the tab row shows no selected tab,
  // the H1 reads "Tasks · custom filter", and the row offers Reset.
  // Project and search stay ordinary filters (their own clear affordances).
  const isCustomFilter =
    !sameValues(statusFilter, presetStatusList) ||
    !sameValues(priorityFilter, preset.priorities ?? []) ||
    mineOnly !== (preset.mine === true);

  const totalCount = filteredTotal;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedTasks = serverTasks;

  // Count only user-applied overrides (URL-sourced), not preset defaults.
  const activeFilterCount =
    (statusState.source === "url" ? 1 : 0) +
    (priorityState.source === "url" ? 1 : 0) +
    (projectIdFilter ? 1 : 0) +
    (searchQuery.trim() ? 1 : 0) +
    (mineSource === "url" ? 1 : 0);

  // "<n> tasks" only once the current team's list exists; the filter count
  // does not depend on it.
  const summaryParts = [
    teamDataReady ? `${totalCount} task${totalCount === 1 ? "" : "s"}` : null,
    activeFilterCount > 0
      ? `${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => part !== null);

  const scopeTabs = (Object.keys(SCOPE_TAB_LABELS) as Scope[]).map((s) => ({
    value: s,
    label: SCOPE_TAB_LABELS[s],
  }));

  // ── Loading / error states ────────────────────────────────────

  if (loading) {
    return <TasksPageSkeleton />;
  }

  if (bootError) {
    return (
      <PageShell variant="wide" flush>
        <PageHeader title="All Tasks">
          {/* The team the URL names is still known while the boot failed (the
              URL needs no lookup), so the link carries it: /projects opens
              that team and writes nothing into its own URL. Bare without one. */}
          <Button
            href={projectsHref({ teamId: searchParams.get("teamId") ?? undefined })}
            variant="ghost"
            size="sm"
          >
            Projects
          </Button>
        </PageHeader>
        <div className="tasks-content">
          <AlertBanner tone="danger" title="Failed to load">
            {bootError}
          </AlertBanner>
          <Button
            variant="secondary"
            size="sm"
            className="tasks-retry-btn"
            onClick={() => window.location.reload()}
          >
            Retry
          </Button>
        </div>
      </PageShell>
    );
  }

  if (noTeam) {
    return (
      <PageShell variant="wide" flush>
        <PageHeader title="All Tasks" />
        <div className="tasks-content">
          <EmptyState
            icon="box"
            title="Cross-project tasks need a team."
            description="Open a project from Projects to see its tasks."
            dashed
            action={
              <Button href={projectsHref()} variant="primary" size="sm">
                Go to Projects
              </Button>
            }
          />
        </div>
      </PageShell>
    );
  }

  // ── Main render ───────────────────────────────────────────────

  return (
    <PageShell variant="wide" flush>
      {/* ── Sticky PageHeader: title + search + new task ── */}
      <PageHeader
        title={isCustomFilter ? "Tasks · custom filter" : SCOPE_LABELS[scope]}
        summary={
          summaryParts.length > 0 ? (
            <span className="num">{summaryParts.join(" · ")}</span>
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
            placeholder="Search…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <KeyHint>/</KeyHint>
        </div>

        {/* No "Mine" toggle: "my tasks" is the My Tasks scope tab (scope=mine).
            The `mine` URL param is still parsed (bookmarks, Home's My Tasks
            link) and is one of the inputs of the custom-filter state, whose
            Reset action clears it. */}

        {/* New task primary button — opens the in-place create flow */}
        <Button
          size="sm"
          onClick={() => setNewTaskOpen(true)}
          keyHint="C"
          disabled={!teamDataReady}
        >
          <Icon name="plus" size={13} />
          New task
        </Button>
      </PageHeader>

      {/* ── Content area ── */}
      <div className="tasks-content">

        {/* Scope segmented control. In the custom-filter state no tab is
            selected (value ""), the strip shows a "Custom filter" chip, and
            "Reset to <tab label>" goes back to the active tab's preset. */}
        <div className="tasks-scope-row">
          <Tabs
            tabs={scopeTabs}
            value={isCustomFilter ? "" : scope}
            onChange={(s) => {
              const next = new URLSearchParams();
              const teamId = searchParams.get("teamId");
              if (teamId) next.set("teamId", teamId);
              if (s !== "all") next.set("scope", s);
              router.replace(`/tasks?${next.toString()}`);
            }}
            label="Task scope"
            className="tasks-scope-tabs"
          />
          {isCustomFilter && (
            <div className="tasks-custom-filter" role="status">
              <span className="filter-chip filter-chip-active">Custom filter</span>
              <button
                type="button"
                className="filter-chip filter-chip-clear"
                onClick={resetFilterToPreset}
              >
                Reset to {SCOPE_TAB_LABELS[scope]}
              </button>
            </div>
          )}
        </div>

        {/* Done-scope recency sub-filter: Recent / Older / All */}
        {scope === "done" && (
          <div className="tasks-filter-row">
            {(
              [
                ["recent", "Recent (<=14d)", counts?.doneRecent],
                ["older", "Older (>14d)", counts?.doneOlder],
                ["all", "All", counts?.done],
              ] as [typeof recency, string, number | undefined][]
            ).map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                aria-pressed={recency === value}
                className={`filter-chip ${recency === value ? "filter-chip-active" : ""}`}
                onClick={() => updateParams({ recency: value === "recent" ? null : value })}
              >
                {label}
                {typeof count === "number" ? ` · ${count}` : ""}
              </button>
            ))}
          </div>
        )}

        {/* Filter band: status chips, priority chips, project + page-size selects */}
        <div className="tasks-filter-band">
          <div className="tasks-filter-row">
            <span className="tasks-filter-label">Status</span>
            {statusChips.map((s) => (
              <button
                key={s.name}
                type="button"
                aria-pressed={statusFilter.includes(s.name)}
                className={`filter-chip ${statusFilter.includes(s.name) ? "filter-chip-active" : ""}`}
                onClick={() => toggleInCsv("status", s.name, presetStatusList)}
              >
                {s.label}
              </button>
            ))}
            <span className="tasks-filter-label tasks-filter-label--spaced">Priority</span>
            {PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={priorityFilter.includes(p)}
                className={`filter-chip ${priorityFilter.includes(p) ? "filter-chip-active" : ""}`}
                onClick={() => toggleInCsv("priority", p, preset.priorities ?? [])}
              >
                {p.charAt(0) + p.slice(1).toLowerCase()}
              </button>
            ))}
            {activeFilterCount > 0 && (
              <button
                type="button"
                className="filter-chip filter-chip-clear tasks-filter-clear"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            )}
          </div>
          <div className="tasks-filter-row">
            <div className="tasks-filter-select">
              <Select
                ariaLabel="Filter by project"
                value={projectIdFilter}
                onChange={(v) => updateParams({ projectId: v })}
                options={[
                  { value: "", label: "All projects" },
                  ...projects.map((p) => ({ value: p.id, label: p.name })),
                ]}
                placeholder="All projects"
              />
            </div>
            <div className="tasks-filter-select">
              <Select
                ariaLabel="Tasks per page"
                value={String(pageSize)}
                onChange={(v) =>
                  updateParams({ pageSize: v === String(DEFAULT_PAGE_SIZE) ? null : v })
                }
                options={PAGE_SIZE_OPTIONS.map((n) => ({
                  value: String(n),
                  label: `${n} per page`,
                }))}
              />
            </div>
          </div>
        </div>

        {/* Backlog row action error (promote/discard/move to backlog), dismissible like the fetch banner */}
        {rowActionError && (
          <AlertBanner
            tone="danger"
            title="Action failed"
            onDismiss={() => setRowActionErrorState(null)}
          >
            {rowActionError}
          </AlertBanner>
        )}

        {/* Fetch error banner with working Retry */}
        {fetchError && (
          <AlertBanner
            tone="danger"
            title="Failed to load tasks"
            onDismiss={() => {
              focusInlineRetryRef.current = true;
              setFetchErrorState((s) => (s ? { ...s, dismissed: true } : s));
            }}
          >
            {fetchError}
            <div>
              <Button variant="ghost" size="sm" className="tasks-retry-btn" onClick={retryFetch}>
                Retry
              </Button>
            </div>
          </AlertBanner>
        )}

        {/* Results: table or empty state, dimmed while fetching. Until the
            current team's list has arrived (first load, or after a team
            change) the region shows the loading state; after a failed load
            of that team it shows the error banner above, and once that
            banner is dismissed a compact inline retry. */}
        <div
          className="tasks-table-region"
          aria-busy={isFetching || awaitingTeamPage || undefined}
          // tabIndex -1: a programmatic focus target for the keyboard focus
          // that would otherwise fall to the body when the row-action
          // trigger or a Retry button unmounts (row-action focus recovery,
          // retryFetch, banner dismissal).
          ref={tableRegionRef}
          tabIndex={-1}
        >
          {dismissedErrorNoList ? (
            <div className="tasks-load-failed" role="status" ref={inlineRetryRef}>
              <span className="tasks-load-failed-text">{"Couldn't load tasks"}</span>
              <Button variant="secondary" size="sm" onClick={retryFetch}>
                Retry
              </Button>
            </div>
          ) : awaitingTeamPage ? (
            <SkeletonList rows={8} rowHeight="3rem" label="Loading tasks" />
          ) : teamPage === null ? null : totalCount === 0 && !isFetching ? (
            <EmptyState
              icon="box"
              title={
                (counts?.total ?? 0) === 0
                  ? "No tasks yet"
                  : "No tasks match the current filters."
              }
              description={
                (counts?.total ?? 0) === 0
                  ? "Create your first task to start tracking work."
                  : undefined
              }
              action={
                activeFilterCount > 0 ? (
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setNewTaskOpen(true)}>
                    Create your first task
                  </Button>
                )
              }
            />
          ) : (
            <>
              {/* Task table: shared ui/Table primitive with server-side controlled sort. */}
              <Table
                columns={buildTaskPageColumns(
                  {
                    onPromote: (t) => void handlePromote(t),
                    onDiscard: requestDiscard,
                    onDemote: (t) => void handleDemote(t),
                    busyTaskId: rowActionBusyId,
                  },
                  pagedTasks,
                )}
                rows={pagedTasks}
                rowKey={(t) => t.id}
                rowHref={(t) => taskHref(t.id, { from: listHref })}
                sortKey={sort.column}
                sortDirection={sort.direction === "asc" ? "ascending" : "descending"}
                onSortChange={handleSortChange}
                emptyLabel="No tasks match the current filters."
                compactSort={
                  <select
                    className="table-sort-native"
                    aria-label="Sort by"
                    value={`${sort.column}:${sort.direction}`}
                    onChange={(e) => {
                      const [col, dir] = e.target.value.split(":");
                      updateParams({ sort: `${col}:${dir}` }, false);
                    }}
                  >
                    {TASK_PAGE_COLUMNS.filter((c) => c.sortable).map((col) => (
                      <optgroup key={col.key} label={col.header}>
                        <option value={`${col.key}:asc`}>{col.header}: A to Z</option>
                        <option value={`${col.key}:desc`}>{col.header}: Z to A</option>
                      </optgroup>
                    ))}
                  </select>
                }
              />

              {totalPages > 1 && (
                <div className="tasks-pagination">
                  <Pagination
                    page={currentPage}
                    totalPages={totalPages}
                    onPageChange={(p) =>
                      updateParams({ page: p === 1 ? null : String(p) }, false)
                    }
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* In-place create flow: project picker step, then NewTaskModal */}
      <NewTaskFlow
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        projects={projects}
        teamId={selectedTeamId}
        onTaskCreated={() => setRetryToken((t) => t + 1)}
        onEditTask={(id) => router.push(taskHref(id, { from: listHref }))}
      />

      {/* Discard confirm — mirrors TaskDetail's delete-task confirm dialog */}
      <ConfirmDialog
        open={discardTarget !== null}
        title="Discard task?"
        message={
          discardTarget
            ? `Task "${discardTarget.title}" will be marked abandoned.`
            : ""
        }
        confirmLabel="Discard task"
        cancelLabel="Keep task"
        tone="danger"
        busy={discardTarget !== null && rowActionBusyId === discardTarget.id}
        onConfirm={() => void confirmDiscard()}
        onCancel={() => {
          if (discardTarget && rowActionBusyId === discardTarget.id) return;
          setDiscardTarget(null);
        }}
      />
    </PageShell>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={<TasksPageSkeleton />}>
      <TasksPageInner />
    </Suspense>
  );
}
