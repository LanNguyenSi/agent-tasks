"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  getCurrentUser,
  getTeamTasks,
  getTeams,
  type Task,
  type Team,
  type TeamTasksCounts,
  type TeamTasksProject,
  type User,
} from "../../lib/api";
import { formatAbsoluteDate, formatRelativeTime } from "../../lib/time";
import { PageHeader } from "../../components/ui/PageHeader";
import { Button } from "../../components/ui/Button";
import { KeyHint } from "../../components/ui/KeyHint";
import { Tabs } from "../../components/ui/Tabs";
import { StatusChip } from "../../components/ui/StatusChip";
import { PriorityLabel } from "../../components/ui/PriorityLabel";
import { Icon } from "../../components/ui/Icon";
import AlertBanner from "../../components/ui/AlertBanner";
import EmptyState from "../../components/ui/EmptyState";
import { Skeleton, SkeletonList } from "../../components/ui/Skeleton";
import Pagination from "../../components/ui/Pagination";
import Select from "../../components/ui/Select";
import { Table, type ColumnDef } from "../../components/ui/Table";
import NewTaskFlow from "../../components/tasks/NewTaskFlow";
import { normalizeStatus, toDateLabel } from "../../lib/taskDisplay";
import { STATUS_MUTED_IN_LIST } from "../../lib/status";

type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type Status = "open" | "in_progress" | "review" | "done";
type SortColumn = "title" | "status" | "project" | "due" | "updated" | "priority";
type SortDirection = "asc" | "desc";
type Scope = "all" | "open" | "mine" | "priority" | "review" | "done";

type EnrichedTask = Task & { projectName: string };

// Column definitions for the task list table.
// Sort keys match the server-side SortColumn parameter names.
// Render functions close over module-level imports only (no component state).
const TASK_PAGE_COLUMNS: ColumnDef<EnrichedTask>[] = [
  {
    key: "title",
    header: "Task",
    sortable: true,
    width: "34%",
    render: (t) => <span className="tasks-row-title">{t.title}</span>,
  },
  {
    key: "status",
    header: "Status",
    sortable: true,
    width: "12%",
    render: (t) => {
      const nStatus = normalizeStatus(t.status);
      const isMuted = STATUS_MUTED_IN_LIST.has(nStatus);
      return <StatusChip status={nStatus} className={isMuted ? "status-chip--muted" : undefined} />;
    },
  },
  {
    key: "project",
    header: "Project",
    sortable: true,
    width: "15.5%",
    render: (t) => (
      <span className="table-cell-secondary" title={t.projectName}>
        {t.projectName}
      </span>
    ),
  },
  {
    key: "due",
    header: "Due",
    sortable: true,
    width: "13%",
    render: (t) => (
      <span className="table-cell-secondary num">{t.dueAt ? toDateLabel(t.dueAt) : "—"}</span>
    ),
  },
  {
    key: "updated",
    header: "Updated",
    sortable: true,
    width: "13%",
    render: (t) => (
      <span className="table-cell-secondary num" title={formatAbsoluteDate(t.updatedAt)}>
        {formatRelativeTime(t.updatedAt)}
      </span>
    ),
  },
  {
    key: "priority",
    header: "Priority",
    sortable: true,
    width: "12%",
    render: (t) => <PriorityLabel priority={t.priority} />,
  },
];

const STATUSES: Status[] = ["open", "in_progress", "review", "done"];
const PRIORITIES: Priority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

// Labels for filter chips (underscore-form API keys).
const STATUS_CHIP_LABELS: Record<Status, string> = {
  open: "Open",
  in_progress: "In Progress",
  review: "In Review",
  done: "Done",
};

// Full scope labels used as H1.
const SCOPE_LABELS: Record<Scope, string> = {
  all: "All Tasks",
  open: "Open Tasks",
  mine: "My Tasks",
  priority: "Priority (High / Critical)",
  review: "In Review",
  done: "Recently Done",
};

// Shorter labels for the segmented control tabs.
const SCOPE_TAB_LABELS: Record<Scope, string> = {
  all: "All",
  open: "Open",
  mine: "My Tasks",
  priority: "Priority",
  review: "In Review",
  done: "Recently Done",
};

interface ScopePreset {
  statuses?: Status[];
  priorities?: Priority[];
  mine?: boolean;
  defaultSort?: { column: SortColumn; direction: SortDirection };
}

const SCOPE_PRESETS: Record<Scope, ScopePreset> = {
  all: {},
  open: { statuses: ["open", "in_progress"] },
  mine: { mine: true, statuses: ["open", "in_progress", "review"] },
  priority: { priorities: ["CRITICAL", "HIGH"], statuses: ["open", "in_progress", "review"] },
  review: { statuses: ["review"] },
  done: { statuses: ["done"], defaultSort: { column: "updated", direction: "desc" } },
};

const EMPTY_SENTINEL = "__any__";

type FilterSource = "url" | "preset";
interface FilterState<T> {
  values: T[];
  source: FilterSource;
}

function parseCsv<T extends string>(value: string | null, allowed: readonly T[]): T[] {
  if (!value) return [];
  const set = new Set(allowed as readonly string[]);
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v): v is T => set.has(v));
}

// Resolves a multi-value URL param with preset fallback. Supports the
// `__any__` sentinel meaning "user explicitly cleared the filter" so a
// preset-backed scope (e.g. Open) can be overridden to "show everything"
// without the preset snapping back on the next render.
function resolveFilter<T extends string>(
  rawParam: string | null,
  allowed: readonly T[],
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

// Skeleton shown during initial bootstrap and as the Suspense fallback.
// Used by both paths so the transition from Suspense -> inner -> loaded is smooth.
function TasksPageSkeleton() {
  return (
    <main className="tasks-shell" aria-busy="true">
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
    </main>
  );
}

function TasksPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [projects, setProjects] = useState<TeamTasksProject[]>([]);
  const [serverTasks, setServerTasks] = useState<EnrichedTask[]>([]);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [counts, setCounts] = useState<TeamTasksCounts | null>(null);
  // loading = initial bootstrap; isFetching = background data refresh
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  // Incrementing retryToken forces the fetch effect to re-run without
  // changing any real filter params — used by the "Retry" button and to
  // refresh the list after an in-place task create.
  const [retryToken, setRetryToken] = useState(0);
  // In-place create flow (project picker + NewTaskModal), see NewTaskFlow.
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  // ── Parse URL params ──────────────────────────────────────────

  const scope: Scope = (() => {
    const raw = searchParams.get("scope");
    const SCOPES: Scope[] = ["all", "open", "mine", "priority", "review", "done"];
    return SCOPES.includes(raw as Scope) ? (raw as Scope) : "all";
  })();
  const preset = SCOPE_PRESETS[scope];

  const statusState = resolveFilter(searchParams.get("status"), STATUSES, preset.statuses ?? []);
  const priorityState = resolveFilter(searchParams.get("priority"), PRIORITIES, preset.priorities ?? []);
  const statusFilter = statusState.values;
  const priorityFilter = priorityState.values;
  const projectIdFilter = searchParams.get("projectId") ?? "";
  const teamIdParam = searchParams.get("teamId");
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
        setUser(me);
        const fetchedTeams = await getTeams();
        if (fetchedTeams.length === 0) { router.replace("/onboarding"); return; }
        setTeams(fetchedTeams);
        const team =
          fetchedTeams.find((t) => t.id === searchParams.get("teamId")) ?? fetchedTeams[0]!;
        setSelectedTeam(team);
        setLoading(false);
      } catch (err) {
        setBootError(err instanceof Error ? err.message : "Failed to load. Please retry.");
        setLoading(false);
      }
    })();
    // searchParams.get is stable within the render; we only bootstrap once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Keep selectedTeam in sync when the teamId param changes after bootstrap.
  useEffect(() => {
    if (teams.length === 0) return;
    setSelectedTeam(teams.find((t) => t.id === teamIdParam) ?? teams[0]!);
  }, [teams, teamIdParam]);

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

  useEffect(() => {
    if (!selectedTeam) {
      setServerTasks([]);
      setProjects([]);
      setFilteredTotal(0);
      setCounts(null);
      return;
    }
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
        setFetchError(null);
        setProjects(r.projects);
        const projectName = new Map(r.projects.map((p) => [p.id, p.name]));
        setServerTasks(
          r.tasks.map((t) => ({ ...t, projectName: projectName.get(t.projectId) ?? "(unknown)" })),
        );
        setFilteredTotal(r.filteredTotal ?? r.tasks.length);
        setCounts(r.counts ?? null);
      } catch (err) {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : "Failed to load tasks.");
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
        e.preventDefault();
        setNewTaskOpen(true);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [newTaskOpen]);

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

  function clearFilters(): void {
    const next = new URLSearchParams();
    const teamId = searchParams.get("teamId");
    if (teamId) next.set("teamId", teamId);
    if (scope !== "all") next.set("scope", scope);
    router.replace(`/tasks?${next.toString()}`);
  }

  // ── Derived values ────────────────────────────────────────────

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
      <main className="tasks-shell">
        <PageHeader title="All Tasks">
          <Button href="/dashboard" variant="ghost" size="sm">
            Dashboard
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
      </main>
    );
  }

  // ── Main render ───────────────────────────────────────────────

  return (
    <main className="tasks-shell">
      {/* ── Sticky PageHeader: title + search + mine toggle + new task ── */}
      <PageHeader
        title={SCOPE_LABELS[scope]}
        summary={
          <span className="num">
            {totalCount} task{totalCount === 1 ? "" : "s"}
            {activeFilterCount > 0 &&
              ` · ${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"}`}
          </span>
        }
      >
        {/* Team selector (multi-team only) */}
        {teams.length > 1 && (
          <Select
            ariaLabel="Switch team"
            value={selectedTeam?.id ?? ""}
            onChange={(v) => updateParams({ teamId: v, projectId: null })}
            options={teams.map((t) => ({ value: t.id, label: t.name }))}
          />
        )}

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

        {/* Mine toggle — tri-state chip next to search */}
        {user && (
          <button
            type="button"
            className={`filter-chip ${mineOnly ? "filter-chip-active" : ""}`}
            aria-pressed={mineOnly}
            onClick={() => {
              if (mineOnly) {
                updateParams({ mine: preset.mine ? "0" : null });
              } else {
                updateParams({ mine: preset.mine ? null : "1" });
              }
            }}
          >
            Mine
          </button>
        )}

        {/* New task primary button — opens the in-place create flow */}
        <Button size="sm" onClick={() => setNewTaskOpen(true)} keyHint="C">
          <Icon name="plus" size={13} />
          New task
        </Button>
      </PageHeader>

      {/* ── Content area ── */}
      <div className="tasks-content">

        {/* Scope segmented control */}
        <Tabs
          tabs={scopeTabs}
          value={scope}
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
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={statusFilter.includes(s)}
                className={`filter-chip ${statusFilter.includes(s) ? "filter-chip-active" : ""}`}
                onClick={() => toggleInCsv("status", s, preset.statuses ?? [])}
              >
                {STATUS_CHIP_LABELS[s]}
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

        {/* Fetch error banner with working Retry */}
        {fetchError && (
          <AlertBanner
            tone="danger"
            title="Failed to load tasks"
            onDismiss={() => setFetchError(null)}
          >
            {fetchError}
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="tasks-retry-btn"
                onClick={() => {
                  setFetchError(null);
                  setRetryToken((t) => t + 1);
                }}
              >
                Retry
              </Button>
            </div>
          </AlertBanner>
        )}

        {/* Results: table or empty state, dimmed while fetching */}
        <div
          className="tasks-table-region"
          aria-busy={isFetching || undefined}
        >
          {totalCount === 0 && !isFetching ? (
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
                columns={TASK_PAGE_COLUMNS}
                rows={pagedTasks}
                rowKey={(t) => t.id}
                rowHref={(t) => `/tasks/${t.id}?${searchParams.toString()}`}
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
        onTaskCreated={() => setRetryToken((t) => t + 1)}
        onEditTask={(id) => router.push(`/tasks/${id}`)}
      />
    </main>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={<TasksPageSkeleton />}>
      <TasksPageInner />
    </Suspense>
  );
}
