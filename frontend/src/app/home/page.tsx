"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { PRIORITY_COLORS } from "../../lib/priorityColors";
import AppHeader from "../../components/AppHeader";
import Card from "../../components/ui/Card";
import { SkeletonList } from "../../components/ui/Skeleton";
import { FullPageLoader } from "../../components/ui/FullPageLoader";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";

const STATUS_COLORS: Record<string, string> = {
  open: "var(--muted)",
  in_progress: "var(--primary)",
  review: "var(--warning)",
  done: "var(--success)",
};

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  review: "In Review",
  done: "Done",
};

type EnrichedTask = Task & { projectName: string };

function TaskRow({ task, teamId }: { task: EnrichedTask; teamId: string }) {
  return (
    <Link
      href={`/dashboard?teamId=${teamId}&projectId=${task.projectId}&taskId=${task.id}`}
      aria-label={`${task.title}, ${task.projectName}, ${STATUS_LABELS[task.status] ?? task.status}, ${task.priority} priority`}
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <div className="open-task-row" style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0.5rem", borderRadius: "var(--radius-base)", transition: "background 0.12s ease" }}>
        <span
          aria-hidden="true"
          title={STATUS_LABELS[task.status] ?? task.status}
          style={{ width: "7px", height: "7px", borderRadius: "50%", background: STATUS_COLORS[task.status] ?? "var(--muted)", flexShrink: 0 }}
        />
        {/* `open-task-row-title` keeps the hook that the <480px
           viewport rule in globals.css uses to promote the title
           to its own full-width line. Don't rename without updating
           the CSS. */}
        <span className="open-task-row-title" style={{ flex: 1, fontSize: "var(--text-sm)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {task.title}
        </span>
        <span title={task.projectName} style={{ color: "var(--muted)", fontSize: "var(--text-xs)", maxWidth: "8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {task.projectName}
        </span>
        {task.externalRef && (
          <span title={task.externalRef} style={{ fontSize: "var(--text-xs)", color: "var(--primary)", background: "var(--primary-muted)", borderRadius: "4px", padding: "0.05rem 0.3rem", fontWeight: 600, fontFamily: "monospace", maxWidth: "6rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            {task.externalRef}
          </span>
        )}
        <span className="status-chip" style={{ color: PRIORITY_COLORS[task.priority] ?? "var(--muted)", fontSize: "var(--text-xs)", flexShrink: 0 }}>
          {task.priority}
        </span>
        <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)", flexShrink: 0 }}>
          {formatRelativeTime(task.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

const WIDGET_LIMIT = 10;

interface WidgetProps {
  title: string;
  tasks: EnrichedTask[];
  teamId: string;
  scope: string;
  emptyText: string;
  // Team-wide total for this scope, sourced from the server-side counts
  // block. Falls back to the loaded slice length when the backend hasn't
  // been redeployed yet (forward-compat). Use this for badges and "+N
  // more" so the numbers don't drift once the team's task count exceeds
  // the row-fetch page size.
  total?: number;
  // "Recently Done" only: count of done tasks beyond the 14-day window. When
  // set, the widget offers a link to reveal them via the full done list,
  // since the recent-capped list/count would otherwise hide them.
  olderCount?: number;
}

function TaskWidget({ title, tasks, teamId, scope, emptyText, total, olderCount = 0 }: WidgetProps) {
  const listHref = `/tasks?teamId=${teamId}&scope=${scope}`;
  const displayTotal = total ?? tasks.length;
  const moreCount = Math.max(0, displayTotal - WIDGET_LIMIT);
  return (
    <Card style={{ marginBottom: "0.75rem" }} padding="sm">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem", gap: "0.5rem" }}>
        <Link href={listHref} style={{ textDecoration: "none", color: "inherit", flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </h2>
        </Link>
        <Link href={listHref} className="widget-link" style={{ fontSize: "var(--text-xs)", flexShrink: 0 }}>
          {displayTotal} total →
        </Link>
      </div>
      {displayTotal === 0 ? (
        <>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", padding: "0.25rem 0" }}>{emptyText}</p>
          {olderCount > 0 && (
            <p style={{ textAlign: "right", marginTop: "0.2rem", fontSize: "var(--text-xs)" }}>
              <Link href={listHref} className="widget-link">
                Show all {olderCount} done →
              </Link>
            </p>
          )}
        </>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {tasks.slice(0, WIDGET_LIMIT).map((task) => (
              <TaskRow key={task.id} task={task} teamId={teamId} />
            ))}
          </div>
          {/* moreCount = items past the widget cap; olderCount = done tasks
              outside the 14-day recency window. Both are only reachable via
              the same unfiltered scope list (listHref has no recency filter),
              so a single combined link avoids two links to the identical
              destination. olderCount is 0 for non-done widgets. */}
          {moreCount + olderCount > 0 && (
            <p style={{ textAlign: "right", marginTop: "0.4rem", fontSize: "var(--text-xs)" }}>
              <Link href={listHref} className="widget-link">
                +{moreCount + olderCount} more →
              </Link>
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export default function HomeDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [firstProjectId, setFirstProjectId] = useState<string | null>(null);
  const [allTasks, setAllTasks] = useState<EnrichedTask[]>([]);
  const [counts, setCounts] = useState<TeamTasksCounts | null>(null);
  const [loading, setLoading] = useState(true);
  // Distinct from `loading` (auth/team bootstrap): the task aggregation is a
  // second roundtrip, so without this the widgets would briefly render their
  // empty states before the first fetch resolves.
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A background-poll failure while data is already on screen should keep the
  // stale data and flag a soft hint, not wipe back to empty widgets.
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

  // Single aggregation roundtrip per refresh: server returns the union of
  // tasks across every team-accessible project (team-owned + per-project
  // shares) plus a projects map for the project-name decoration. Replaces
  // the previous fan-out that issued one HTTP request per project (with
  // 40 projects this was ~40 parallel requests, each carrying its own
  // 3-query ACL — see the perf regression ticket for details).
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
        // Server orders by updatedAt desc; preserve that here.
        setAllTasks(enriched);
        // counts is optional during the rollout window; null means
        // TaskWidget will fall back to `tasks.length` (the legacy
        // off-by-page-size behavior).
        setCounts(r.counts ?? null);
        if (r.projects.length > 0) {
          setFirstProjectId((prev) => prev ?? r.projects[0]!.id);
        }
        hasDataRef.current = true;
        setError(null);
        setStaleWarning(false);
      } catch (err) {
        if (cancelled) return;
        // First load with nothing on screen yet: surface a real error so the
        // empty widgets don't read as "you have 0 tasks". A background-poll
        // failure after data is shown keeps the stale data and only flags a
        // soft hint (matches the dashboard's silent-poll behavior).
        if (hasDataRef.current) {
          setStaleWarning(true);
        } else {
          setError((err as Error).message);
        }
      } finally {
        // Flip the gate even if the fetch rejects, so a failed first request
        // falls back to the error branch instead of hanging on the skeleton.
        if (!cancelled) setTasksLoaded(true);
      }
    }

    void fetchTeamTasks(selectedTeam.id);
    const interval = setInterval(() => void fetchTeamTasks(selectedTeam.id), 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selectedTeam, refetchKey]);

  const openTasks = useMemo(
    () => allTasks.filter((t) => t.status === "open" || t.status === "in_progress"),
    [allTasks],
  );

  const inReviewTasks = useMemo(
    () => allTasks.filter((t) => t.status === "review"),
    [allTasks],
  );

  const priorityTasks = useMemo(
    () => allTasks.filter((t) => (t.priority === "CRITICAL" || t.priority === "HIGH") && t.status !== "done"),
    [allTasks],
  );

  // Only the genuinely recent completions, matching the dashboard's default
  // done window (reusing the same predicate). Keeps the widget from claiming
  // a huge "N total" when the team has accumulated months of done tasks.
  const recentlyDone = useMemo(() => {
    const now = Date.now();
    return allTasks.filter((t) => t.status === "done" && !isDoneTaskHidden("recent", t.updatedAt, now));
  }, [allTasks]);

  // Done tasks beyond the 14-day window, so the Recently Done widget can offer
  // a link to reveal them (its list only shows the recent ones).
  const olderDoneCount = useMemo(() => {
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

  const boardHref = selectedTeam && firstProjectId
    ? `/dashboard?teamId=${selectedTeam.id}&projectId=${firstProjectId}`
    : "/dashboard";

  return (
    <main className="page-shell">
      <AppHeader
        user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null}
        boardHref={boardHref}
      />

      <Card padding="sm" style={{ marginBottom: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--text)" }}>Your task overview</h1>
        <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginTop: "var(--space-1)" }}>Across all your projects.</p>
      </Card>

      {selectedTeam && (
        !tasksLoaded ? (
          <SkeletonList rows={5} rowHeight="4rem" label="Loading your tasks" />
        ) : error ? (
          <AlertBanner tone="danger" title="Couldn't load your tasks">
            {error}
            <div style={{ marginTop: "var(--space-3)" }}>
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
            {staleWarning && (
              <p style={{ color: "var(--warning)", fontSize: "var(--text-xs)", marginBottom: "var(--space-2)" }}>
                Last update failed; showing the most recent data.
              </p>
            )}
            <div className="home-widgets-grid">
              <TaskWidget title="Open Tasks" tasks={openTasks} teamId={selectedTeam.id} scope="open" emptyText="No open tasks." total={counts?.open} />
              <TaskWidget title="My Tasks" tasks={myTasks} teamId={selectedTeam.id} scope="mine" emptyText="No tasks assigned to you." total={counts?.mine} />
              <TaskWidget title="Priority (High / Critical)" tasks={priorityTasks} teamId={selectedTeam.id} scope="priority" emptyText="No high-priority tasks." total={counts?.priority} />
              <TaskWidget title="In Review" tasks={inReviewTasks} teamId={selectedTeam.id} scope="review" emptyText="Nothing in review." total={counts?.review} />
              {/* total is the local 14-day count by design (the /tasks list has no
                  recency filter); olderCount surfaces a link to the done tasks
                  beyond that window so they stay reachable from here. */}
              <TaskWidget title="Recently Done" tasks={recentlyDone} teamId={selectedTeam.id} scope="done" emptyText="No tasks completed in the last 14 days." total={recentlyDone.length} olderCount={olderDoneCount} />
            </div>
          </>
        )
      )}
    </main>
  );
}
