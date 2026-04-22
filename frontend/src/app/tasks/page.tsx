"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  getCurrentUser,
  getProjects,
  getTasks,
  getTeams,
  type Project,
  type Task,
  type Team,
  type User,
} from "../../lib/api";
import { formatAbsoluteDate, formatRelativeTime } from "../../lib/time";
import AppHeader from "../../components/AppHeader";
import Card from "../../components/ui/Card";
import EmptyState from "../../components/ui/EmptyState";
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

const PRIORITY_COLORS: Record<Priority, string> = {
  LOW: "#8d99ab",
  MEDIUM: "#f59e0b",
  HIGH: "#ef4444",
  CRITICAL: "#be123c",
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

function compareTasks(a: EnrichedTask, b: EnrichedTask, sort: { column: SortColumn; direction: SortDirection }): number {
  let cmp = 0;
  switch (sort.column) {
    case "title":
      cmp = a.title.localeCompare(b.title);
      break;
    case "status":
      cmp = (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99);
      break;
    case "project":
      cmp = a.projectName.localeCompare(b.projectName);
      break;
    case "due": {
      const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
      const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
      cmp = ad - bd;
      break;
    }
    case "updated":
      cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      break;
    case "priority":
      cmp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      break;
  }
  if (cmp === 0) cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
  return sort.direction === "asc" ? cmp : -cmp;
}

function TasksPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [user, setUser] = useState<User | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [allTasks, setAllTasks] = useState<EnrichedTask[]>([]);
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

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) { router.replace("/auth"); return; }
      setUser(me);

      const teams = await getTeams();
      if (teams.length === 0) { router.replace("/onboarding"); return; }

      const teamIdParam = searchParams.get("teamId");
      const team = teams.find((t) => t.id === teamIdParam) ?? teams[0]!;
      setSelectedTeam(team);

      const teamProjects = await getProjects(team.id);
      setProjects(teamProjects);
      setLoading(false);
    })();
    // searchParams.get is fine to omit from deps; we only bootstrap once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    if (projects.length === 0) {
      setAllTasks([]);
      return;
    }
    let cancelled = false;

    async function fetchAll() {
      const collected: EnrichedTask[] = [];
      await Promise.all(
        projects.map(async (p) => {
          const tasks = await getTasks(p.id);
          for (const t of tasks) collected.push({ ...t, projectName: p.name });
        }),
      );
      if (!cancelled) setAllTasks(collected);
    }

    void fetchAll();
    const interval = setInterval(() => void fetchAll(), 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [projects]);

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

  const filteredTasks = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return allTasks
      .filter((t) => {
        if (statusFilter.length > 0 && !statusFilter.includes(t.status as Status)) return false;
        if (priorityFilter.length > 0 && !priorityFilter.includes(t.priority)) return false;
        if (projectIdFilter && t.projectId !== projectIdFilter) return false;
        if (mineOnly && t.claimedByUserId !== user?.id) return false;
        if (normalizedQuery) {
          const hay = `${t.title} ${t.description ?? ""} ${t.externalRef ?? ""} ${(t.labels ?? []).join(" ")}`.toLowerCase();
          if (!hay.includes(normalizedQuery)) return false;
        }
        return true;
      })
      .sort((a, b) => compareTasks(a, b, sort));
  }, [allTasks, statusFilter, priorityFilter, projectIdFilter, mineOnly, searchQuery, sort, user?.id]);

  const totalCount = filteredTasks.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedTasks = useMemo(
    () => filteredTasks.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filteredTasks, currentPage, pageSize],
  );

  // Count only user-applied overrides (URL-sourced), not preset defaults.
  const activeFilterCount =
    (statusState.source === "url" ? 1 : 0) +
    (priorityState.source === "url" ? 1 : 0) +
    (projectIdFilter ? 1 : 0) +
    (searchQuery.trim() ? 1 : 0) +
    (mineSource === "url" ? 1 : 0);

  if (loading) {
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--muted)" }}>Loading...</p>
      </main>
    );
  }

  const boardHref = selectedTeam && projects[0]
    ? `/dashboard?teamId=${selectedTeam.id}&projectId=${projects[0].id}`
    : "/dashboard";

  return (
    <main className="page-shell">
      <AppHeader
        user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null}
        boardHref={boardHref}
      />

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

      {/* Filter controls */}
      <Card padding="sm" style={{ marginBottom: "var(--space-3)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
          <input
            type="search"
            placeholder="Search title, description, labels…"
            value={searchQuery}
            onChange={(e) => updateParams({ q: e.target.value })}
            style={{
              flex: "1 1 240px",
              minWidth: 0,
              padding: "0.42rem 0.6rem",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-base)",
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
            allTasks.length === 0
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
                >
                  {label}
                  {sort.column === col && (
                    <span style={{ color: "var(--primary)", marginLeft: "0.25rem" }}>
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
                <span className="task-list-cell-status">
                  <span className="status-chip" style={{ color: STATUS_COLORS[task.status] }}>
                    {STATUS_LABELS[task.status as Status] ?? task.status}
                  </span>
                </span>
                <span className="task-list-cell-muted" title={task.projectName} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {task.projectName}
                </span>
                <span className="task-list-cell-muted">
                  {task.dueAt ? task.dueAt.slice(0, 10) : "—"}
                </span>
                <span className="task-list-cell-updated" title={formatAbsoluteDate(task.updatedAt)}>
                  {formatRelativeTime(task.updatedAt)}
                </span>
                <span className="task-list-cell-priority">
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
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--muted)" }}>Loading...</p>
      </main>
    }>
      <TasksPageInner />
    </Suspense>
  );
}
