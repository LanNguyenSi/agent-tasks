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
import { isDoneTaskHidden } from "../../lib/dashboardPrefs";
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
import { isBacklogTask, isPriorityTask } from "./widgetFilters";

type EnrichedTask = Task & { projectName: string };

type HomeScope = {
  key: string;
  scope: "mine" | "priority" | "backlog" | "open" | "review" | "done";
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
          {task.externalRef}
        </span>
      )}
      <PriorityLabel priority={task.priority} />
      <span className="home-task-row-time">{formatRelativeTime(task.updatedAt)}</span>
    </Link>
  );
}

// ── TaskWidget ────────────────────────────────────────────────────

const WIDGET_LIMIT = 10;

interface WidgetProps {
  title: string;
  tasks: EnrichedTask[];
  teamId: string;
  scope: string;
  /** EmptyState content shown when displayTotal === 0 and data is loaded. */
  emptyState: ReactNode;
  /**
   * Team-wide total for this scope, sourced from the server-side counts block.
   * Falls back to loaded-slice length when the backend hasn't been redeployed
   * yet (forward-compat). Drives badges and "+N more" so the numbers don't
   * drift when the team's task count exceeds the row-fetch page size.
   */
  total?: number;
  /**
   * "Recently Done" only: count of done tasks beyond the 14-day window. When
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
  const moreCount = Math.max(0, displayTotal - WIDGET_LIMIT);

  return (
    <Card className="home-widget-card" padding="sm">
      <div className="home-widget-header">
        <Link href={moreHref} className="home-widget-title-link">
          <h2 className="home-widget-title">{title}</h2>
        </Link>
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
            {tasks.slice(0, WIDGET_LIMIT).map((task) => (
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
  const [allTasks, setAllTasks] = useState<EnrichedTask[]>([]);
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
      setAllTasks([]);
      setCounts(null);
      setError(null);
      setStaleWarning(false);
      setTasksLoaded(false);
    }

    async function fetchTeamTasks(teamId: string) {
      try {
        const r = await getTeamTasks(teamId);
        if (cancelled) return;
        const projectName = new Map(r.projects.map((p) => [p.id, p.name]));
        const enriched: EnrichedTask[] = r.tasks.map((t) => ({
          ...t,
          projectName: projectName.get(t.projectId) ?? "(unknown)",
        }));
        setAllTasks(enriched);
        setCounts(r.counts ?? null);
        setTeamProjects(r.projects);
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

  const openTasks = useMemo(
    () => allTasks.filter((t) => t.status === "open" || t.status === "in_progress"),
    [allTasks],
  );

  const inReviewTasks = useMemo(
    () => allTasks.filter((t) => t.status === "review"),
    [allTasks],
  );

  const priorityTasks = useMemo(() => allTasks.filter(isPriorityTask), [allTasks]);

  const backlogTasks = useMemo(() => allTasks.filter(isBacklogTask), [allTasks]);

  const recentlyDone = useMemo(() => {
    const now = Date.now();
    return allTasks.filter((t) => t.status === "done" && !isDoneTaskHidden("recent", t.updatedAt, now));
  }, [allTasks]);

  const olderDoneCount = useMemo(() => {
    if (typeof counts?.doneOlder === "number") return counts.doneOlder;
    const doneTotal = counts?.done ?? allTasks.filter((t) => t.status === "done").length;
    return Math.max(0, doneTotal - recentlyDone.length);
  }, [counts, allTasks, recentlyDone]);

  const myTasks = useMemo(
    () => allTasks.filter((t) => t.claimedByUserId === user?.id && t.status !== "done"),
    [allTasks, user],
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

  // Per-project open/in_progress counts come from the loaded task slice,
  // which the backend caps (DEFAULT_LIMIT = 500 in
  // backend/src/routes/tasks.ts). A slice is provably complete only when
  // counts is present AND counts.total <= allTasks.length; while the
  // aggregation is truncated the slice misses tasks, so no per-project
  // count is shown at all (never a wrong one).
  const activeCounts = useMemo(() => {
    if (counts === null || counts.total > allTasks.length) return null;
    const map = new Map<string, number>();
    for (const t of allTasks) {
      if (t.status === "open" || t.status === "in_progress") {
        map.set(t.projectId, (map.get(t.projectId) ?? 0) + 1);
      }
    }
    return map;
  }, [allTasks, counts]);

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
  // else. D1 (operator-decided): My Tasks, Priority, Backlog, Open
  // Tasks, In Review, Recently Done. To reorder either surface, reorder
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
              Browse open tasks
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
      statLabel: "Open",
      widgetTitle: "Open Tasks",
      count: counts?.open ?? openTasks.length,
      tasks: openTasks,
      total: counts?.open,
      href: `/tasks?teamId=${teamId}&scope=open`,
      emptyState: (
        <EmptyState
          title="No open tasks."
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
      statLabel: "Recently Done",
      widgetTitle: "Recently Done",
      count: counts?.doneRecent ?? recentlyDone.length,
      tasks: recentlyDone,
      // total = the server's recent (<=14d) done count; olderCount = the >14d count.
      // The widget's "more" link stays in the recent window; "older done" deep-links
      // to the >14d slice.
      total: counts?.doneRecent ?? recentlyDone.length,
      href: `/tasks?teamId=${teamId}&scope=done`,
      olderCount: olderDoneCount,
      emptyState: <EmptyState title="No tasks completed in the last 14 days." />,
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

            {/* Stale-warning slot: always present (reserves space, prevents layout jump).
                Visibility controlled by staleWarning state. */}
            <div
              className={["home-stale-slot", staleWarning ? "" : "home-stale-slot--hidden"].filter(Boolean).join(" ")}
              aria-live="polite"
            >
              <AlertBanner
                tone="warning"
                onDismiss={staleWarning ? () => setStaleWarning(false) : undefined}
              >
                Last update failed; showing the most recent data.
              </AlertBanner>
            </div>

            {/* Widgets: same six scopes as the stat strip above, rendered
                from the same `homeScopes` list in the same D1 order (My
                Tasks, Priority, Backlog, Open Tasks, In Review, Recently
                Done) -- see the comment at homeScopes for the ordering
                rule. */}
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
