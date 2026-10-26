"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeamTasks,
  type User,
  type Team,
  type Project,
  type Task,
  type TeamTasksCounts,
  type TeamTasksProject,
} from "../../lib/api";
import { formatRelativeTime } from "../../lib/time";
import { DONE_RECENT_DAYS, isDoneTaskHidden } from "../../lib/dashboardPrefs";
import {
  HOME_PROJECTS_STRIP_LIMIT,
  readRecentProjects,
} from "../../lib/recentProjects";
import { getAccessContext, needsOnboarding } from "../../lib/access";
import { useCurrentTeam } from "../../lib/teamSwitch";
import { normalizeStatus } from "../../lib/taskDisplay";
import { boardHref, projectsHref } from "../../lib/routes";
import Card from "../../components/ui/Card";
import { SkeletonList } from "../../components/ui/Skeleton";
import { FullPageLoader } from "../../components/ui/FullPageLoader";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import EmptyState from "../../components/ui/EmptyState";
import { StatusChip } from "../../components/ui/StatusChip";
import { PriorityLabel } from "../../components/ui/PriorityLabel";
import { SharedProjectsList } from "../../components/projects/SharedProjectsList";
import {
  WIDGET_LIMIT,
  WIDGET_REQUESTS,
  isActiveTask,
  isBacklogTask,
  isPriorityTask,
  type WidgetKey,
} from "./widgetFilters";

type EnrichedTask = Task & { projectName: string };

// Label of the done tile and widget: the window comes from the same constant
// as the recency filter, so the label cannot drift from what is counted.
const DONE_LABEL = `Done · ${DONE_RECENT_DAYS} days`;

const WIDGET_KEYS = Object.keys(WIDGET_REQUESTS) as WidgetKey[];

type WidgetRows = Record<WidgetKey, EnrichedTask[]>;

function emptyWidgetRows(): WidgetRows {
  return { mine: [], priority: [], backlog: [], open: [], review: [], done: [] };
}

type HomeScope = {
  key: string;
  scope: WidgetKey;
  statLabel: string;
  widgetTitle: string;
  count: number;
  tasks: EnrichedTask[];
  total?: number;
  href: string;
  moreHrefOverride?: string;
  olderCount?: number;
  emptyState: ReactNode;
};

// ── TaskRow ───────────────────────────────────────────────────────

function TaskRow({ task, teamId }: { task: EnrichedTask; teamId: string }) {
  return (
    <Link
      href={boardHref({ teamId, projectId: task.projectId, taskId: task.id })}
      aria-label={`${task.title}, ${task.projectName}, ${task.status.replace(/_/g, " ")}, ${task.priority} priority`}
      className="home-task-row"
    >
      <StatusChip status={normalizeStatus(task.status)} />
      {/* `home-task-row-title` is referenced in the <480px responsive rule
         in globals.css to promote the title to its own full-width line.
         Do not rename without updating the CSS. */}
      <span className="home-task-row-title">{task.title}</span>
      <span className="home-task-row-project" title={task.projectName}>
        {task.projectName}
      </span>
      {task.externalRef && (
        <span className="home-task-row-ref" title={task.externalRef}>
          {/* The distinctive part of a ref is its end: the CSS truncates from
              the start, and <bdi> keeps the characters in reading order. */}
          <bdi>{task.externalRef}</bdi>
        </span>
      )}
      <PriorityLabel priority={task.priority} />
      <span className="home-task-row-time">{formatRelativeTime(task.updatedAt)}</span>
    </Link>
  );
}

// ── TaskWidget ────────────────────────────────────────────────────

interface WidgetProps {
  title: string;
  tasks: EnrichedTask[];
  teamId: string;
  scope: string;
  /** EmptyState content shown when displayTotal === 0 and data is loaded. */
  emptyState: ReactNode;
  /**
   * Team-wide total for this scope, sourced from the server-side counts block.
   * Falls back to the loaded rows when the backend hasn't been redeployed
   * yet (forward-compat). Drives the "N total" badge; "+N more" is this total
   * minus the rows the widget shows.
   */
  total?: number;
  /**
   * Done widget only: count of done tasks beyond the recency window. When
   * set, the widget offers a link to reveal them via the full done list.
   */
  olderCount?: number;
  /**
   * Overrides the computed "more" link. Needed for scopes the /tasks page
   * doesn't have a preset for (e.g. "backlog") — those fall back to the
   * status filter param instead of the scope preset.
   */
  moreHrefOverride?: string;
}

function TaskWidget({ title, tasks, teamId, scope, emptyState, total, olderCount = 0, moreHrefOverride }: WidgetProps) {
  const listHref = `/tasks?teamId=${teamId}&scope=${scope}`;
  const moreHref = moreHrefOverride ?? (scope === "done" ? `${listHref}&recency=recent` : listHref);
  const olderHref = `/tasks?teamId=${teamId}&scope=done&recency=older`;
  const displayTotal = total ?? tasks.length;
  const shownTasks = tasks.slice(0, WIDGET_LIMIT);
  // Rows not shown = team-wide total minus the rows on screen (not minus the
  // row limit: a scope may load fewer than WIDGET_LIMIT rows of a larger total).
  const moreCount = Math.max(0, displayTotal - shownTasks.length);

  return (
    <Card className="home-widget-card" padding="sm">
      <div className="home-widget-header">
        {/* Plain text: the stat tile above is the one link to this scope
            ("N total" and "+N more" below lead there too). */}
        <h2 className="home-widget-title">{title}</h2>
        <Link href={moreHref} className="widget-link home-widget-more">
          <span className="num">{displayTotal}</span> total &rarr;
        </Link>
      </div>

      {displayTotal === 0 ? (
        <>
          {emptyState}
          {olderCount > 0 && (
            <p className="home-widget-footer">
              <Link href={olderHref} className="widget-link">
                Show {olderCount} older done &rarr;
              </Link>
            </p>
          )}
        </>
      ) : (
        <>
          <div className="home-widget-tasks">
            {shownTasks.map((task) => (
              <TaskRow key={task.id} task={task} teamId={teamId} />
            ))}
          </div>
          {moreCount > 0 && (
            <p className="home-widget-footer">
              <Link href={moreHref} className="widget-link">
                +{moreCount} more &rarr;
              </Link>
            </p>
          )}
          {olderCount > 0 && (
            <p className="home-widget-footer">
              <Link href={olderHref} className="widget-link">
                +{olderCount} older done &rarr;
              </Link>
            </p>
          )}
        </>
      )}
    </Card>
  );
}

// ── StatTile ──────────────────────────────────────────────────────

function StatTile({
  count,
  label,
  href,
}: {
  count: number;
  label: string;
  href: string;
}) {
  return (
    <Link href={href} className="home-stat-tile">
      <span className="home-stat-tile-number num">{count}</span>
      <span className="home-stat-tile-label">{label}</span>
    </Link>
  );
}

// ── ProjectsStrip ─────────────────────────────────────────────────

interface ProjectsStripProps {
  /** Jump-list order already resolved (recents first, then the
   * `getTeamTasks` projects order); the component caps the rendering. */
  projects: TeamTasksProject[];
  teamId: string;
  /** Active (open + in_progress) task count per project. Present only when
   * the team aggregation is known to be complete — see the truncation
   * guard in the page — so a count is never shown when it could be wrong. */
  activeCounts: Map<string, number> | null;
}

/**
 * "Your projects" jump strip (T05, UI/IA S1): up to
 * `HOME_PROJECTS_STRIP_LIMIT` project links above the stat strip, recents
 * first (localStorage, recorded when a board is opened) and then the
 * remaining projects in the order `getTeamTasks` returns them, plus the
 * "All projects" link to the team's Projects page. Shared projects
 * (`accessSource: "project"`) are listed like any other project; the
 * dedicated "Shared with you" group is a later stage.
 */
function ProjectsStrip({ projects, teamId, activeCounts }: ProjectsStripProps) {
  return (
    <section className="home-projects-strip" aria-label="Your projects">
      <div className="home-projects-head">
        <h2 className="home-projects-title">Your projects</h2>
        <Link href={projectsHref({ teamId })} className="widget-link home-projects-all">
          All projects &rarr;
        </Link>
      </div>
      {projects.length === 0 ? (
        <p className="home-projects-empty">
          No projects in this team yet.{" "}
          <Link href={projectsHref({ teamId })} className="widget-link">
            Go to Projects &rarr;
          </Link>
        </p>
      ) : (
        <ul className="home-projects-items">
          {projects.slice(0, HOME_PROJECTS_STRIP_LIMIT).map((project) => (
            <li key={project.id} className="home-projects-item-wrap">
              <Link
                href={boardHref({ projectId: project.id })}
                className="home-projects-item"
                aria-label={
                  activeCounts
                    ? `${project.name}, ${activeCounts.get(project.id) ?? 0} active`
                    : project.name
                }
              >
                <span className="home-projects-item-name">{project.name}</span>
                {activeCounts && (
                  <span className="home-projects-item-count num">
                    {activeCounts.get(project.id) ?? 0} active
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function HomeDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  // Derived from the URL like the header's team (?teamId, remembered, first):
  // no team state of its own, so back/forward and a switch always agree.
  const selectedTeam = useCurrentTeam(teams);
  // Zero-team user with shared projects: the project list replaces the task
  // widgets (the team task aggregation needs a team).
  const [sharedProjects, setSharedProjects] = useState<Project[]>([]);
  // Raw rows of each widget's scoped request (see WIDGET_REQUESTS).
  const [widgetRows, setWidgetRows] = useState<WidgetRows>(emptyWidgetRows);
  // Team projects for the "Your projects" jump strip, in the order
  // getTeamTasks returns them.
  const [teamProjects, setTeamProjects] = useState<TeamTasksProject[]>([]);
  // Recents are read once per team after the team resolves (not on every
  // 15s refetch), so the strip order does not shuffle under a poll.
  const [recentProjectIds, setRecentProjectIds] = useState<string[]>([]);
  const selectedTeamId = selectedTeam?.id ?? null;
  useEffect(() => {
    setRecentProjectIds(selectedTeamId ? readRecentProjects(selectedTeamId) : []);
  }, [selectedTeamId]);
  const [counts, setCounts] = useState<TeamTasksCounts | null>(null);
  const [loading, setLoading] = useState(true);
  // Distinct from `loading` (auth/team bootstrap): the task aggregation is a
  // second roundtrip, so without this the widgets briefly render their empty
  // states before the first fetch resolves.
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A background-poll failure while data is already on screen keeps the stale
  // data and flags a soft hint, not wiping back to empty widgets.
  const [staleWarning, setStaleWarning] = useState(false);
  const [refetchKey, setRefetchKey] = useState(0);
  const hasDataRef = useRef(false);
  // The team whose tasks are on screen.
  const loadedTeamIdRef = useRef<string | null>(null);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) { router.replace("/auth"); return; }
      setUser(me);

      const ctx = await getAccessContext();
      if (needsOnboarding(ctx)) { router.replace("/onboarding"); return; }
      const teams = ctx.teams;
      if (teams.length === 0) {
        setSharedProjects(ctx.sharedProjects);
        setLoading(false);
        return;
      }

      setTeams(teams);
      setLoading(false);
    })();
  }, [router]);

  useEffect(() => {
    if (!selectedTeam) return;
    let cancelled = false;

    // A different team than the one on screen: drop its tasks and show the
    // loading state until the new team's tasks arrive.
    if (loadedTeamIdRef.current !== selectedTeam.id) {
      loadedTeamIdRef.current = selectedTeam.id;
      hasDataRef.current = false;
      setWidgetRows(emptyWidgetRows());
      setCounts(null);
      setError(null);
      setStaleWarning(false);
      setTasksLoaded(false);
    }

    async function fetchTeamTasks(teamId: string) {
      try {
        // One scoped request per widget, in parallel: the rows of every
        // widget come from its own scope, not from filtering one capped slice
        // of the whole team. `counts` and `projects` are team-wide and the
        // same in every response, so the first one supplies them.
        const responses = await Promise.all(
          WIDGET_KEYS.map((key) => getTeamTasks(teamId, WIDGET_REQUESTS[key])),
        );
        if (cancelled) return;
        const first = responses[0];
        if (!first) return;
        const projectName = new Map(first.projects.map((p) => [p.id, p.name]));
        const rows = emptyWidgetRows();
        WIDGET_KEYS.forEach((key, i) => {
          rows[key] = (responses[i]?.tasks ?? []).map((t) => ({
            ...t,
            projectName: projectName.get(t.projectId) ?? "(unknown)",
          }));
        });
        setWidgetRows(rows);
        setCounts(first.counts ?? null);
        setTeamProjects(first.projects);
        hasDataRef.current = true;
        setError(null);
        setStaleWarning(false);
      } catch (err) {
        if (cancelled) return;
        if (hasDataRef.current) {
          setStaleWarning(true);
        } else {
          setError((err as Error).message);
        }
      } finally {
        if (!cancelled) setTasksLoaded(true);
      }
    }

    void fetchTeamTasks(selectedTeam.id);
    const interval = setInterval(() => void fetchTeamTasks(selectedTeam.id), 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selectedTeam, refetchKey]);

  // ── Filtered task sets ────────────────────────────────────────

  // The requests already filter by scope; the predicates below are the same
  // rules applied again to what came back, so a response that ignores a
  // filter cannot put a task into the wrong widget.

  const openTasks = useMemo(() => widgetRows.open.filter(isActiveTask), [widgetRows.open]);

  const inReviewTasks = useMemo(
    () => widgetRows.review.filter((t) => t.status === "review"),
    [widgetRows.review],
  );

  const priorityTasks = useMemo(
    () => widgetRows.priority.filter(isPriorityTask),
    [widgetRows.priority],
  );

  const backlogTasks = useMemo(
    () => widgetRows.backlog.filter(isBacklogTask),
    [widgetRows.backlog],
  );

  const recentlyDone = useMemo(() => {
    const now = Date.now();
    return widgetRows.done.filter(
      (t) => t.status === "done" && !isDoneTaskHidden("recent", t.updatedAt, now),
    );
  }, [widgetRows.done]);

  const olderDoneCount = useMemo(() => {
    if (typeof counts?.doneOlder === "number") return counts.doneOlder;
    const doneTotal = counts?.done ?? recentlyDone.length;
    return Math.max(0, doneTotal - recentlyDone.length);
  }, [counts, recentlyDone]);

  const myTasks = useMemo(
    () =>
      widgetRows.mine.filter(
        (t) => t.claimedByUserId === user?.id && t.status !== "done" && t.status !== "abandoned",
      ),
    [widgetRows.mine, user],
  );

  // ── "Your projects" strip (T05) ──────────────────────────────
  // Recents first in recorded order (ids no longer in the team's project
  // list are skipped), then the remaining projects in the order
  // getTeamTasks returned them.
  const stripProjects = useMemo(() => {
    const byId = new Map(teamProjects.map((p) => [p.id, p]));
    const recentIds = new Set(recentProjectIds);
    const recents = recentProjectIds
      .map((id) => byId.get(id))
      .filter((p): p is TeamTasksProject => p !== undefined);
    return [...recents, ...teamProjects.filter((p) => !recentIds.has(p.id))];
  }, [teamProjects, recentProjectIds]);

  // Per-project active counts come from the active widget's rows, which the
  // backend caps (ACTIVE_FETCH_LIMIT, at most 500 per request). Those rows
  // are provably complete only when counts is present AND counts.open (the
  // team-wide active count: open + in_progress) <= the rows loaded; while the
  // active scope is truncated the rows miss tasks, so no per-project count
  // is shown at all (never a wrong one).
  const activeCounts = useMemo(() => {
    if (counts === null || counts.open > openTasks.length) return null;
    const map = new Map<string, number>();
    for (const t of openTasks) {
      map.set(t.projectId, (map.get(t.projectId) ?? 0) + 1);
    }
    return map;
  }, [openTasks, counts]);

  if (loading) {
    return <FullPageLoader variant="shell" label="Loading your tasks" />;
  }

  const teamId = selectedTeam?.id ?? "";

  const projectsStrip = (
    <ProjectsStrip projects={stripProjects} teamId={teamId} activeCounts={activeCounts} />
  );

  // ── Ordered scope list (D1/D3) ───────────────────────────────
  // Single source of truth for BOTH the stat strip and the widget grid:
  // each surface below renders this list, in this order, and nothing
  // else. D1 (operator-decided): My Tasks, Priority, Backlog, Active
  // Tasks, In Review, Done. To reorder either surface, reorder
  // this array; do not add a second, independently-ordered list. hrefs,
  // counts, and empty states are carried over unchanged from before.
  const homeScopes: HomeScope[] = [
    {
      key: "mine",
      scope: "mine",
      statLabel: "Mine",
      widgetTitle: "My Tasks",
      count: counts?.mine ?? myTasks.length,
      tasks: myTasks,
      total: counts?.mine,
      href: `/tasks?teamId=${teamId}&scope=mine`,
      emptyState: (
        <EmptyState
          title="Nothing assigned to you."
          action={
            <Button href={`/tasks?teamId=${teamId}&scope=open`} variant="ghost" size="sm">
              Browse active tasks
            </Button>
          }
        />
      ),
    },
    {
      key: "priority",
      scope: "priority",
      statLabel: "Priority",
      widgetTitle: "Priority (High / Critical)",
      count: counts?.priority ?? priorityTasks.length,
      tasks: priorityTasks,
      total: counts?.priority,
      href: `/tasks?teamId=${teamId}&scope=priority`,
      emptyState: <EmptyState title="No high-priority tasks." />,
    },
    {
      key: "backlog",
      scope: "backlog",
      statLabel: "Backlog",
      widgetTitle: "Backlog",
      count: counts?.backlog ?? backlogTasks.length,
      tasks: backlogTasks,
      total: counts?.backlog,
      href: `/tasks?teamId=${teamId}&status=backlog`,
      moreHrefOverride: `/tasks?teamId=${teamId}&status=backlog`,
      emptyState: <EmptyState title="No drafts waiting for promotion." />,
    },
    {
      key: "open",
      scope: "open",
      statLabel: "Active",
      widgetTitle: "Active Tasks",
      count: counts?.open ?? openTasks.length,
      tasks: openTasks,
      total: counts?.open,
      href: `/tasks?teamId=${teamId}&scope=open`,
      emptyState: (
        <EmptyState
          title="No active tasks."
          action={
            <Button href={`/tasks?teamId=${teamId}&scope=all`} variant="ghost" size="sm">
              View all tasks
            </Button>
          }
        />
      ),
    },
    {
      key: "review",
      scope: "review",
      statLabel: "In Review",
      widgetTitle: "In Review",
      count: counts?.review ?? inReviewTasks.length,
      tasks: inReviewTasks,
      total: counts?.review,
      href: `/tasks?teamId=${teamId}&scope=review`,
      emptyState: <EmptyState title="Nothing in review." />,
    },
    {
      key: "done",
      scope: "done",
      statLabel: DONE_LABEL,
      widgetTitle: DONE_LABEL,
      count: counts?.doneRecent ?? recentlyDone.length,
      tasks: recentlyDone,
      // total = the server's recent (<=14d) done count; olderCount = the >14d count.
      // The widget's "more" link stays in the recent window; "older done" deep-links
      // to the >14d slice.
      total: counts?.doneRecent ?? recentlyDone.length,
      href: `/tasks?teamId=${teamId}&scope=done`,
      olderCount: olderDoneCount,
      emptyState: <EmptyState title={`No tasks completed in the last ${DONE_RECENT_DAYS} days.`} />,
    },
  ];

  // ── Stat strip ────────────────────────────────────────────────

  const statStrip = (
    <div className="home-stat-strip">
      {homeScopes.map((s) => (
        <StatTile key={s.key} count={s.count} label={s.statLabel} href={s.href} />
      ))}
    </div>
  );

  const heading = (
    <div className="home-header">
      <h1 className="home-header-title">
        {selectedTeam?.name ?? "Home"}
      </h1>
      <p className="home-header-sub">
        {selectedTeam
          ? "Task overview across all your projects."
          : "Projects shared with you."}
      </p>
    </div>
  );

  return (
    <main className="page-shell">
      {selectedTeam ? (
        heading
      ) : (
        <>
          <div className="teams-header-row">
            {heading}
            <div className="teams-actions">
              <Button href="/onboarding" variant="secondary">
                Create a team
              </Button>
            </div>
          </div>
          <SharedProjectsList projects={sharedProjects} />
        </>
      )}

      {selectedTeam && (
        !tasksLoaded ? (
          <>
            {statStrip}
            <SkeletonList rows={5} rowHeight="4rem" label="Loading your tasks" />
          </>
        ) : error ? (
          <AlertBanner tone="danger" title="Couldn't load your tasks">
            {error}
            <div className="home-error-retry">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setError(null);
                  setTasksLoaded(false);
                  setRefetchKey((k) => k + 1);
                }}
              >
                Retry
              </Button>
            </div>
          </AlertBanner>
        ) : (
          <>
            {projectsStrip}
            {statStrip}

            {/* Stale-warning slot: the live region is always mounted so the
                warning is announced when it appears; the banner itself (and its
                role="alert") exists only while the warning is active. */}
            <div
              className={["home-stale-slot", staleWarning ? "" : "home-stale-slot--hidden"].filter(Boolean).join(" ")}
              aria-live="polite"
            >
              {staleWarning && (
                <AlertBanner tone="warning" onDismiss={() => setStaleWarning(false)}>
                  Last update failed; showing the most recent data.
                </AlertBanner>
              )}
            </div>

            {/* Widgets: same six scopes as the stat strip above, rendered
                from the same `homeScopes` list in the same D1 order (My
                Tasks, Priority, Backlog, Active Tasks, In Review, Done) --
                see the comment at homeScopes for the ordering rule. */}
            <div className="home-widgets-grid">
              {homeScopes.map((s) => (
                <TaskWidget
                  key={s.key}
                  title={s.widgetTitle}
                  tasks={s.tasks}
                  teamId={teamId}
                  scope={s.scope}
                  total={s.total}
                  moreHrefOverride={s.moreHrefOverride}
                  olderCount={s.olderCount}
                  emptyState={s.emptyState}
                />
              ))}
            </div>
          </>
        )
      )}
    </main>
  );
}
