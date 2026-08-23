"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeams,
  getTeamTasks,
  type User,
  type Team,
  type Task,
  type TeamTasksCounts,
} from "../../lib/api";
import { formatRelativeTime } from "../../lib/time";
import { isDoneTaskHidden } from "../../lib/dashboardPrefs";
import { normalizeStatus } from "../../lib/taskDisplay";
import Card from "../../components/ui/Card";
import { SkeletonList } from "../../components/ui/Skeleton";
import { FullPageLoader } from "../../components/ui/FullPageLoader";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import EmptyState from "../../components/ui/EmptyState";
import { StatusChip } from "../../components/ui/StatusChip";
import { PriorityLabel } from "../../components/ui/PriorityLabel";
import { isBacklogTask, isPriorityTask } from "./widgetFilters";

type EnrichedTask = Task & { projectName: string };

// ── TaskRow ───────────────────────────────────────────────────────

function TaskRow({ task, teamId }: { task: EnrichedTask; teamId: string }) {
  return (
    <Link
      href={`/dashboard?teamId=${teamId}&projectId=${task.projectId}&taskId=${task.id}`}
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

// ── Page ──────────────────────────────────────────────────────────

export default function HomeDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [, setFirstProjectId] = useState<string | null>(null);
  const [allTasks, setAllTasks] = useState<EnrichedTask[]>([]);
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

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) { router.replace("/auth"); return; }
      setUser(me);

      const teams = await getTeams();
      if (teams.length === 0) { router.replace("/onboarding"); return; }

      const team = teams[0]!;
      setSelectedTeam(team);
      setLoading(false);
    })();
  }, [router]);

  useEffect(() => {
    if (!selectedTeam) return;
    let cancelled = false;

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
        if (r.projects.length > 0) {
          setFirstProjectId((prev) => prev ?? r.projects[0]!.id);
        }
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

  if (loading) {
    return <FullPageLoader variant="shell" label="Loading your tasks" />;
  }

  const teamId = selectedTeam?.id ?? "";

  // ── Ordered scope list (D1/D3) ───────────────────────────────
  // Single source of truth for BOTH the stat strip and the widget grid:
  // each surface below renders this list, in this order, and nothing
  // else. D1 (operator-decided): My Tasks, Priority, Backlog, Open
  // Tasks, In Review, Recently Done. To reorder either surface, reorder
  // this array; do not add a second, independently-ordered list. hrefs,
  // counts, and empty states are carried over unchanged from before.
  const homeScopes: {
    key: string;
    scope: string;
    statLabel: string;
    widgetTitle: string;
    count: number;
    tasks: EnrichedTask[];
    total?: number;
    href: string;
    moreHrefOverride?: string;
    olderCount?: number;
    emptyState: ReactNode;
  }[] = [
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

  return (
    <main className="page-shell">
      {/* PageHeader-style heading */}
      <div className="home-header">
        <h1 className="home-header-title">
          {selectedTeam?.name ?? "Home"}
        </h1>
        <p className="home-header-sub">Task overview across all your projects.</p>
      </div>

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
