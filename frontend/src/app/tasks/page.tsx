"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
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
import { formatAbsoluteDate, formatRelativeTime, formatDueDate } from "../../lib/time";
import { PRIORITY_COLORS } from "../../lib/priorityColors";
import Card from "../../components/ui/Card";
import EmptyState from "../../components/ui/EmptyState";
import { SkeletonList } from "../../components/ui/Skeleton";
import Pagination from "../../components/ui/Pagination";
import Select from "../../components/ui/Select";

type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type Status = "open" | "in_progress" | "review" | "done";
type SortColumn = "title" | "status" | "project" | "due" | "updated" | "priority";
type SortDirection = "asc" | "desc";
type Scope = "all" | "open" | "mine" | "priority" | "review" | "done";

type EnrichedTask = Task & { projectName: string };

const STATUSES: Status[] = ["open", "in_progress", "review", "done"];
const PRIORITIES: Priority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

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

const SCOPE_LABELS: Record<Scope, string> = {
  all: "All Tasks",
  open: "Open Tasks",
  mine: "My Tasks",
  priority: "Priority (High / Critical)",
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

function TasksPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [projects, setProjects] = useState<TeamTasksProject[]>([]);
  // The current page of rows, already filtered/sorted/paginated server-side.
  const [serverTasks, setServerTasks] = useState<EnrichedTask[]>([]);
  // Total rows matching the active filter (drives pagination) and the
  // team-wide counts (drives the empty-state copy + done recency chip totals).
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [counts, setCounts] = useState<TeamTasksCounts | null>(null);
  const [loading, setLoading] = useState(true);

  const scope: Scope = (() => {
    const raw = searchParams.get("scope");
    if (raw === "all" || raw === "open" || raw === "mine" || raw === "priority" || raw === "review" || raw === "done") {
      return raw;
    }
    return "all";
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
  const sort = parseSort(searchParams.get("sort")) ?? preset.defaultSort ?? { column: "updated", direction: "desc" };
  const pageSize = (() => {
    const raw = Number(searchParams.get("pageSize"));
    return PAGE_SIZE_OPTIONS.includes(raw) ? raw : DEFAULT_PAGE_SIZE;
  })();
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Done-scope recency window. The done view defaults to Recent (≤14d) — the
  // scope is literally "Recently Done" — with Older (>14d) / All reachable via
  // the chips. Other scopes ignore recency entirely.
  const recency: "recent" | "older" | "all" = (() => {
    if (scope !== "done") return "all";
    const raw = searchParams.get("recency");
    return raw === "older" || raw === "all" ? raw : "recent";
  })();

  // Stable string keys so the multi-value filters can sit in the fetch
  // effect's dependency array without tripping the exhaustive-deps lint.
  const statusKey = statusFilter.join(",");
  const priorityKey = priorityFilter.join(",");

  // Local mirror of the URL `q` param so typing doesn't router.replace on every
  // keystroke; the debounce effect below pushes it to the URL after a pause.
  const [searchInput, setSearchInput] = useState(searchQuery);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) { router.replace("/auth"); return; }
      setUser(me);

      const fetchedTeams = await getTeams();
      if (fetchedTeams.length === 0) { router.replace("/onboarding"); return; }
      setTeams(fetchedTeams);
      const team = fetchedTeams.find((t) => t.id === searchParams.get("teamId")) ?? fetchedTeams[0]!;
      setSelectedTeam(team);
      setLoading(false);
    })();
    // searchParams.get is fine to omit from deps; we only bootstrap once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Keep selectedTeam in sync when the teamId param changes (team switcher,
  // back/forward nav) after the initial bootstrap.
  useEffect(() => {
    if (teams.length === 0) return;
    setSelectedTeam(teams.find((t) => t.id === teamIdParam) ?? teams[0]!);
  }, [teams, teamIdParam]);

  // Re-sync the search box when the URL query changes from outside (scope
  // switch, clear-filters, back nav).
  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  // Debounce search writes so each keystroke doesn't router.replace + reset
  // pagination; the URL updates ~250ms after the user pauses. Deps are
  // [searchInput] only: searchQuery is read just for the no-op guard and
  // updateParams is a pure helper, so excluding them is intentional (the
  // guard makes the post-write re-run a no-op, avoiding a loop).
  useEffect(() => {
    if (searchInput === searchQuery) return;
    const id = setTimeout(() => updateParams({ q: searchInput || null }), 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // Single aggregation roundtrip: the server-side endpoint returns the
  // union of tasks across all team-accessible projects plus a small
  // projects map (id, name, slug, accessSource). Replaces the previous
  // per-project fan-out that issued one HTTP request per project.
  useEffect(() => {
    if (!selectedTeam) {
      setServerTasks([]);
      setProjects([]);
      setFilteredTotal(0);
      setCounts(null);
      return;
    }
    let cancelled = false;

    // Server-side filter + sort + pagination: the page requests exactly the
    // rows it shows, so the full set (incl. done tasks older than the former
    // 1000-recent fetch cap) is reachable by paging rather than client-slicing.
    async function fetchPage(teamId: string) {
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
      setProjects(r.projects);
      const projectName = new Map(r.projects.map((p) => [p.id, p.name]));
      setServerTasks(
        r.tasks.map((t) => ({ ...t, projectName: projectName.get(t.projectId) ?? "(unknown)" })),
      );
      setFilteredTotal(r.filteredTotal ?? r.tasks.length);
      setCounts(r.counts ?? null);
    }

    void fetchPage(selectedTeam.id);
    const interval = setInterval(() => void fetchPage(selectedTeam.id), 30_000);
    return () => { cancelled = true; clearInterval(interval); };
    // statusKey/priorityKey are the stable serialisations of the array filters.
  }, [selectedTeam, scope, recency, page, pageSize, sort.column, sort.direction,
      projectIdFilter, mineOnly, searchQuery, statusKey, priorityKey]);

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

    // When a preset is active, empty means "explicitly any" (sentinel), not "fall back to preset".
    if (next.length === 0) {
      updateParams({ [param]: presetDefault.length > 0 ? EMPTY_SENTINEL : null });
      return;
    }
    // Clear URL param when selection matches the preset default (clean URLs).
    const matchesPreset =
      next.length === presetDefault.length && next.every((v) => presetDefault.includes(v));
    updateParams({ [param]: matchesPreset ? null : next.join(",") });
  }

  function toggleSort(column: SortColumn): void {
    const next: SortDirection =
      sort.column === column ? (sort.direction === "asc" ? "desc" : "asc") : column === "title" || column === "project" ? "asc" : "desc";
    updateParams({ sort: `${column}:${next}` }, false);
  }

  // Rows are already filtered/sorted/paged server-side; render them directly.
  const totalCount = filteredTotal;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedTasks = serverTasks;

  // If the URL `page` overshoots the filtered set (deep-link, back-nav, or the
  // poll shrinking the count below the current page), snap it back so the user
  // sees the last real page instead of a header with no rows. Guard on
  // filteredTotal > 0 so the genuine empty-state still renders.
  useEffect(() => {
    if (filteredTotal > 0 && page > totalPages) {
      updateParams({ page: null });
    }
    // updateParams is a pure URL helper; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredTotal, totalPages, page]);

  // Count only user-applied overrides (URL-sourced), not preset defaults.
  const activeFilterCount =
    (statusState.source === "url" ? 1 : 0) +
    (priorityState.source === "url" ? 1 : 0) +
    (projectIdFilter ? 1 : 0) +
    (searchQuery.trim() ? 1 : 0) +
    (mineSource === "url" ? 1 : 0);

  if (loading) {
    return (
      <main style={{ minHeight: "100vh", padding: "var(--space-6) var(--space-4)" }}>
        <div style={{ maxWidth: 960, margin: "0 auto" }}>
          <SkeletonList rows={8} rowHeight="3rem" label="Loading tasks" />
        </div>
      </main>
    );
  }


  return (
    <main className="page-shell">
      <Card padding="sm" style={{ marginBottom: "var(--space-4)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: "var(--text-lg)", fontWeight: 700, marginBottom: "0.15rem" }}>{SCOPE_LABELS[scope]}</h1>
            <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>
              {totalCount} task{totalCount === 1 ? "" : "s"}
              {activeFilterCount > 0 && ` · ${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"}`}
            </p>
          </div>
          <Link href="/home" style={{ color: "var(--muted)", fontSize: "var(--text-xs)", textDecoration: "none" }}>
            ← Back to Home
          </Link>
        </div>
        {teams.length > 1 && (
          <div style={{ marginTop: "0.6rem", maxWidth: "240px" }}>
            <Select
              ariaLabel="Switch team"
              value={selectedTeam?.id ?? ""}
              onChange={(v) => updateParams({ teamId: v, projectId: null })}
              options={teams.map((t) => ({ value: t.id, label: t.name }))}
            />
          </div>
        )}
      </Card>

      {/* Scope chips */}
      <div className="scope-chip-row">
        {(Object.keys(SCOPE_LABELS) as Scope[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`filter-chip ${scope === s ? "filter-chip-active" : ""}`}
            onClick={() => {
              const next = new URLSearchParams();
              const teamId = searchParams.get("teamId");
              if (teamId) next.set("teamId", teamId);
              if (s !== "all") next.set("scope", s);
              router.replace(`/tasks?${next.toString()}`);
            }}
          >
            {SCOPE_LABELS[s]}
          </button>
        ))}
      </div>

      {/* Recency sub-filter for the done scope: Recent (≤14d) / Older (>14d) /
          All. Counts are the team-wide done split from the server. */}
      {scope === "done" && (
        <div className="scope-chip-row">
          {([
            ["recent", "Recent (≤14d)", counts?.doneRecent],
            ["older", "Older (>14d)", counts?.doneOlder],
            ["all", "All", counts?.done],
          ] as [typeof recency, string, number | undefined][]).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              className={`filter-chip ${recency === value ? "filter-chip-active" : ""}`}
              onClick={() => updateParams({ recency: value === "recent" ? null : value })}
            >
              {label}
              {typeof count === "number" ? ` · ${count}` : ""}
            </button>
          ))}
        </div>
      )}

      {/* Filter controls */}
      <Card padding="sm" style={{ marginBottom: "var(--space-3)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
          <input
            type="search"
            aria-label="Search tasks"
            placeholder="Search title, description, labels…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{
              flex: "1 1 240px",
              minWidth: 0,
              padding: "0.45rem 0.625rem",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              color: "var(--text)",
              fontSize: "var(--text-sm)",
            }}
          />
          <div style={{ minWidth: "180px" }}>
            <Select
              value={projectIdFilter}
              onChange={(v) => updateParams({ projectId: v })}
              options={[{ value: "", label: "All projects" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
              placeholder="All projects"
            />
          </div>
          <div style={{ minWidth: "140px" }}>
            <Select
              value={String(pageSize)}
              onChange={(v) => updateParams({ pageSize: v === String(DEFAULT_PAGE_SIZE) ? null : v })}
              options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: `${n} per page` }))}
            />
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginTop: "0.6rem", alignItems: "center" }}>
          <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Status:</span>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={`filter-chip ${statusFilter.includes(s) ? "filter-chip-active" : ""}`}
              onClick={() => toggleInCsv("status", s, preset.statuses ?? [])}
            >
              {STATUS_LABELS[s]}
            </button>
          ))}
          <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.04em", marginLeft: "0.75rem" }}>Priority:</span>
          {PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              className={`filter-chip ${priorityFilter.includes(p) ? "filter-chip-active" : ""}`}
              onClick={() => toggleInCsv("priority", p, preset.priorities ?? [])}
            >
              {p}
            </button>
          ))}
          {user && (
            <button
              type="button"
              className={`filter-chip ${mineOnly ? "filter-chip-active" : ""}`}
              onClick={() => {
                // Tri-state respects preset: mine=1 force on, mine=0 force off, absent = preset default.
                if (mineOnly) {
                  updateParams({ mine: preset.mine ? "0" : null });
                } else {
                  updateParams({ mine: preset.mine ? null : "1" });
                }
              }}
              style={{ marginLeft: "0.75rem" }}
            >
              Mine only
            </button>
          )}
          {activeFilterCount > 0 && (
            <button
              type="button"
              className="filter-chip filter-chip-clear"
              onClick={() => {
                const next = new URLSearchParams();
                const teamId = searchParams.get("teamId");
                if (teamId) next.set("teamId", teamId);
                if (scope !== "all") next.set("scope", scope);
                router.replace(`/tasks?${next.toString()}`);
              }}
              style={{ marginLeft: "auto" }}
            >
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {/* Results */}
      {totalCount === 0 ? (
        <EmptyState
          message={
            (counts?.total ?? 0) === 0
              ? "No tasks found for this team yet."
              : "No tasks match the current filters."
          }
        />
      ) : (
        <>
          <div className="task-list-shell">
            <div className="task-list-head">
              {([
                ["title", "Task"],
                ["status", "Status"],
                ["project", "Project"],
                ["due", "Due"],
                ["updated", "Updated"],
                ["priority", "Priority"],
              ] as [SortColumn, string][]).map(([col, label]) => (
                <button
                  key={col}
                  type="button"
                  className={sort.column === col ? "sort-active" : ""}
                  onClick={() => toggleSort(col)}
                  aria-label={
                    sort.column === col
                      ? `Sort by ${label}, currently sorted ${sort.direction === "asc" ? "ascending" : "descending"}`
                      : `Sort by ${label}`
                  }
                >
                  {label}
                  {sort.column === col && (
                    <span aria-hidden="true" style={{ color: "var(--primary)", marginLeft: "0.25rem" }}>
                      {sort.direction === "asc" ? "▲" : "▼"}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {pagedTasks.map((task, index) => (
              <Link
                key={task.id}
                href={`/dashboard?teamId=${selectedTeam?.id ?? ""}&projectId=${task.projectId}&taskId=${task.id}`}
                className="task-list-row"
                style={{
                  textDecoration: "none",
                  color: "var(--text)",
                  padding: "0.72rem 0.78rem",
                  borderBottom: index < pagedTasks.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <span className="task-list-cell-main">
                  <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                    {task.title}
                  </span>
                </span>
                <span className="task-list-cell-status" data-label="Status">
                  <span className="status-chip" style={{ color: STATUS_COLORS[task.status] }}>
                    {STATUS_LABELS[task.status as Status] ?? task.status}
                  </span>
                </span>
                <span className="task-list-cell-muted" data-label="Project" title={task.projectName} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {task.projectName}
                </span>
                <span className="task-list-cell-muted" data-label="Due" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {task.dueAt ? formatDueDate(task.dueAt) : "No due date"}
                </span>
                <span className="task-list-cell-updated" title={formatAbsoluteDate(task.updatedAt)}>
                  {formatRelativeTime(task.updatedAt)}
                </span>
                <span className="task-list-cell-priority" data-label="Priority">
                  <span className="status-chip" style={{ color: PRIORITY_COLORS[task.priority] }}>
                    {task.priority}
                  </span>
                </span>
              </Link>
            ))}
          </div>
          <div style={{ marginTop: "var(--space-3)" }}>
            <Pagination
              page={currentPage}
              totalPages={totalPages}
              onPageChange={(p) => updateParams({ page: p === 1 ? null : String(p) }, false)}
            />
          </div>
        </>
      )}
    </main>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={
      <main style={{ minHeight: "100vh", padding: "var(--space-6) var(--space-4)" }}>
        <div style={{ maxWidth: 960, margin: "0 auto" }}>
          <SkeletonList rows={8} rowHeight="3rem" label="Loading tasks" />
        </div>
      </main>
    }>
      <TasksPageInner />
    </Suspense>
  );
}
