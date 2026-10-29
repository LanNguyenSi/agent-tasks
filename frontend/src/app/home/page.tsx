"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeamTasks,
  type User,
  type Project,
  type Task,
  type TeamTasksCounts,
  type TeamTasksProject,
  type Workflow,
} from "../../lib/api";
import { formatRelativeTime } from "../../lib/time";
import { DONE_RECENT_DAYS, isDoneTaskHidden } from "../../lib/dashboardPrefs";
import {
  HOME_PROJECTS_STRIP_LIMIT,
  readRecentProjects,
} from "../../lib/recentProjects";
import { needsOnboarding } from "../../lib/access";
import { accessContextForTeams, usePageTeams } from "../../lib/teamList";
import { useCurrentTeam } from "../../lib/teamSwitch";
import { normalizeStatus } from "../../lib/taskDisplay";
import { boardHref, projectsHref } from "../../lib/routes";
import Card from "../../components/ui/Card";
import { SkeletonList } from "../../components/ui/Skeleton";
import { FullPageLoader } from "../../components/ui/FullPageLoader";
import { PageHeader } from "../../components/ui/PageHeader";
import { PageShell } from "../../components/ui/PageShell";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import EmptyState from "../../components/ui/EmptyState";
import { StatusChip } from "../../components/ui/StatusChip";
import { PriorityLabel } from "../../components/ui/PriorityLabel";
import { ViewAllLink } from "../../components/ui/ViewAllLink";
import { Icon } from "../../components/ui/Icon";
import { SharedProjectsList } from "../../components/projects/SharedProjectsList";
import {
  WIDGET_LIMIT,
  WIDGET_REQUESTS,
  isActiveTask,
  isBacklogTask,
  isActionableTask,
  isPriorityTask,
  reviewStatesResolver,
  terminalStatesResolver,
  widgetRequest,
  type WidgetKey,
} from "./widgetFilters";
import { loadMissingProjectWorkflows } from "./projectWorkflows";

type EnrichedTask = Task & { projectName: string };

// Label of the done tile and widget: the window comes from the same constant
// as the recency filter, so the label cannot drift from what is counted.
const DONE_LABEL = `Done · ${DONE_RECENT_DAYS} days`;

const WIDGET_KEYS = Object.keys(WIDGET_REQUESTS) as WidgetKey[];

type WidgetRows = Record<WidgetKey, EnrichedTask[]>;

function emptyWidgetRows(): WidgetRows {
  return { mine: [], priority: [], backlog: [], open: [], review: [], done: [] };
}

type ScopeGroup = "filters" | "stages";

type HomeScope = {
  key: string;
  scope: WidgetKey;
  /** Which side of the scope strip the entry sits on. */
  group: ScopeGroup;
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
        {/* Plain text: the scope link above is the one link to this scope
            (the "View all" link here and "+N more" below lead there too).
            The count is text, not part of the link. */}
        <h2 className="home-widget-title">{title}</h2>
        <span className="home-widget-count num">{displayTotal}</span>
        <ViewAllLink href={moreHref} aria-label={`View all ${title}`} />
      </div>

      {displayTotal === 0 ? (
        /* The older-done reveal (when this widget has one) rides in the
           EmptyState action slot, like every other empty state on Home. */
        emptyState
      ) : (
        <>
          <div className="home-widget-tasks">
            {shownTasks.map((task) => (
              <TaskRow key={task.id} task={task} teamId={teamId} />
            ))}
          </div>
          {/* One full-width footer row at the bottom of the card for the
              overflow links, no text-arrow glyphs (the arrow is the
              aria-hidden `arrow-right` Icon). Accessible names contain the
              widget title and the full visible text (WCAG 2.5.3), so links
              that differ in href never share a name. */}
          {(moreCount > 0 || olderCount > 0) && (
            <div className="home-widget-footer">
              {moreCount > 0 && (
                <Link
                  href={moreHref}
                  className="home-widget-footer-link"
                  aria-label={`${title}: ${moreCount} more in Tasks`}
                >
                  <span>{moreCount} more in Tasks</span>
                  <Icon name="arrow-right" size={12} />
                </Link>
              )}
              {olderCount > 0 && (
                <Link
                  href={olderHref}
                  className="home-widget-footer-link home-widget-footer-link--quiet"
                  aria-label={`${title}: ${olderCount} older than ${DONE_RECENT_DAYS} days`}
                >
                  <span>
                    {olderCount} older than {DONE_RECENT_DAYS} days
                  </span>
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ── ScopeLink ─────────────────────────────────────────────────────

function ScopeLink({
  count,
  label,
  href,
}: {
  count: number;
  label: string;
  href: string;
}) {
  // The explicit name keeps "<n> <label>" with a space; the two spans are
  // only presentation.
  return (
    <Link href={href} className="home-scope-link" aria-label={`${count} ${label}`}>
      <span className="home-scope-num num">{count}</span>
      <span className="home-scope-label">{label}</span>
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
 * `HOME_PROJECTS_STRIP_LIMIT` project links above the scope strip, recents
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
        <ViewAllLink href={projectsHref({ teamId })} aria-label="View all projects">
          All projects
        </ViewAllLink>
      </div>
      {projects.length === 0 ? (
        /* Inline prose link, no arrow glyph: the settings inline-link style
           (underlined --link in both themes) so it reads as a link inside
           the sentence. */
        <p className="home-projects-empty">
          No projects in this team yet.{" "}
          <Link href={projectsHref({ teamId })} className="settings-inline-link">
            Go to Projects
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
  // The shell's team list (one lookup for the header and the pages), not a
  // copy of this page's own; empty until the session check answered, so
  // without a session no team resolves and nothing is requested or written
  // into the URL. `teamsHeld`: ?teamId names a team that list lacks and its
  // one refresh is pending.
  const { teams, status: teamsStatus, held: teamsHeld } = usePageTeams(user !== null);
  // Derived from the URL like the header's team (?teamId, remembered, first):
  // no team state of its own, so back/forward and a switch always agree.
  const selectedTeam = useCurrentTeam(teams, { hold: teamsHeld });
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
  // The stored workflows of the team's projects: what makes a custom state
  // terminal, review-like or open for the mine, priority, review and done
  // widgets. Read once per team (a project whose list cannot be read reads as
  // the built-in workflow); the state copy is what the render reads.
  const workflowsRef = useRef<Map<string, Workflow[]>>(new Map());
  // Projects whose workflow list answered 403: asked once per team, not on
  // every poll.
  const forbiddenWorkflowsRef = useRef<Set<string>>(new Set());
  const [workflowsByProject, setWorkflowsByProject] = useState<ReadonlyMap<string, readonly Workflow[]>>(
    () => new Map(),
  );
  // The team whose tasks are on screen.
  const loadedTeamIdRef = useRef<string | null>(null);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) { router.replace("/auth"); return; }
      setUser(me);
    })();
  }, [router]);

  // Access decision once the user and the shell's team list are known.
  // `error` (the list could not be loaded) keeps the page loading, as the
  // page's own failed lookup did.
  useEffect(() => {
    if (!user || teamsStatus !== "ready") return;
    if (teams.length > 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const ctx = await accessContextForTeams(teams);
      if (cancelled) return;
      if (needsOnboarding(ctx)) { router.replace("/onboarding"); return; }
      setSharedProjects(ctx.sharedProjects);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user, teamsStatus, teams, router]);

  useEffect(() => {
    if (!selectedTeam) return;
    let cancelled = false;

    // A different team than the one on screen: drop its tasks and show the
    // loading state until the new team's tasks arrive.
    if (loadedTeamIdRef.current !== selectedTeam.id) {
      loadedTeamIdRef.current = selectedTeam.id;
      hasDataRef.current = false;
      workflowsRef.current = new Map();
      forbiddenWorkflowsRef.current = new Set();
      setWorkflowsByProject(new Map());
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
        // The mine, priority, review and done widgets ask for the names their
        // workflows define (actionable, review-like, terminal states); the
        // others use their fixed request. Until the workflows are known these
        // are the built-in names.
        const requestFor = (key: WidgetKey) => widgetRequest(key, workflowsRef.current);
        const sentStatus = new Map(WIDGET_KEYS.map((key) => [key, requestFor(key).status]));
        const responses = await Promise.all(
          WIDGET_KEYS.map((key) => getTeamTasks(teamId, requestFor(key))),
        );
        if (cancelled) return;
        const first = responses[0];
        if (!first) return;
        // Workflows of projects not seen yet. A widget whose list of names
        // grew with them is asked again once with the full list; the others
        // keep their first response.
        const gained = await loadMissingProjectWorkflows(
          first.projects.map((p) => p.id),
          workflowsRef.current,
          forbiddenWorkflowsRef.current,
        );
        if (cancelled) return;
        if (gained) {
          setWorkflowsByProject(new Map(workflowsRef.current));
          const stale = WIDGET_KEYS.filter((key) => requestFor(key).status !== sentStatus.get(key));
          const again = await Promise.all(
            stale.map(async (key) => {
              try {
                return await getTeamTasks(teamId, requestFor(key));
              } catch {
                return null; // keep the rows of the first request; the next poll asks again
              }
            }),
          );
          if (cancelled) return;
          stale.forEach((key, i) => {
            const r = again[i];
            if (r) responses[WIDGET_KEYS.indexOf(key)] = r;
          });
        }
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

  const terminalStatesOf = useMemo(() => terminalStatesResolver(workflowsByProject), [workflowsByProject]);
  const reviewStatesOf = useMemo(() => reviewStatesResolver(workflowsByProject), [workflowsByProject]);

  const inReviewTasks = useMemo(
    () => widgetRows.review.filter((t) => reviewStatesOf(t).has(t.status)),
    [widgetRows.review, reviewStatesOf],
  );

  const priorityTasks = useMemo(
    () => widgetRows.priority.filter((t) => isPriorityTask(t, terminalStatesOf)),
    [widgetRows.priority, terminalStatesOf],
  );

  const backlogTasks = useMemo(
    () => widgetRows.backlog.filter(isBacklogTask),
    [widgetRows.backlog],
  );

  const recentlyDone = useMemo(() => {
    const now = Date.now();
    return widgetRows.done.filter(
      (t) => terminalStatesOf(t).has(t.status) && !isDoneTaskHidden("recent", t.updatedAt, now),
    );
  }, [widgetRows.done, terminalStatesOf]);

  const olderDoneCount = useMemo(() => {
    if (typeof counts?.doneOlder === "number") return counts.doneOlder;
    const doneTotal = counts?.done ?? recentlyDone.length;
    return Math.max(0, doneTotal - recentlyDone.length);
  }, [counts, recentlyDone]);

  const myTasks = useMemo(
    () =>
      widgetRows.mine.filter(
        (t) => t.claimedByUserId === user?.id && isActionableTask(t, terminalStatesOf),
      ),
    [widgetRows.mine, user, terminalStatesOf],
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
  // Single source of truth for BOTH the scope strip and the widget grid:
  // each surface below renders this list, in this order, and nothing
  // else. D1 (operator-decided): My Tasks, Priority, Backlog, Active
  // Tasks, In Review, Done. To reorder either surface, reorder
  // this array; do not add a second, independently-ordered list. hrefs,
  // counts, and empty states are carried over unchanged from before.
  const homeScopes: HomeScope[] = [
    {
      key: "mine",
      scope: "mine",
      group: "filters",
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
      group: "filters",
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
      group: "stages",
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
      group: "stages",
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
      group: "stages",
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
      group: "stages",
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
      // When the recent window is empty but older done tasks exist, the
      // reveal lives in the EmptyState action slot like the other empty
      // states' actions (a ghost Button; with href it renders an anchor).
      // It only shows while the widget is empty, because the empty state
      // only renders then; the non-empty footer row is TaskWidget's job.
      emptyState: (
        <EmptyState
          title={`No tasks completed in the last ${DONE_RECENT_DAYS} days.`}
          action={
            olderDoneCount > 0 ? (
              <Button
                href={`/tasks?teamId=${teamId}&scope=done&recency=older`}
                variant="ghost"
                size="sm"
                aria-label={`Show ${olderDoneCount} older done tasks in ${DONE_LABEL}`}
              >
                Show {olderDoneCount} older done
              </Button>
            ) : undefined
          }
        />
      ),
    },
  ];

  // ── Scope strip ───────────────────────────────────────────────

  // Two groups from the one homeScopes list: the filters (Mine, Priority)
  // and the stage flow (Backlog to Done), whose links are joined by a
  // decorative chevron. DOM order equals the list order.
  const scopesOf = (group: ScopeGroup) => homeScopes.filter((s) => s.group === group);
  const scopeStrip = (
    <nav className="home-scopes" aria-label="Task scopes">
      <div className="home-scopes-group home-scopes-group--filters">
        {scopesOf("filters").map((s) => (
          <ScopeLink key={s.key} count={s.count} label={s.statLabel} href={s.href} />
        ))}
      </div>
      <div className="home-scopes-group home-scopes-group--stages">
        {scopesOf("stages").map((s, i) => (
          <Fragment key={s.key}>
            {i > 0 && (
              <span className="home-scopes-sep" aria-hidden="true">
                {"\u203A"}
              </span>
            )}
            <ScopeLink count={s.count} label={s.statLabel} href={s.href} />
          </Fragment>
        ))}
      </div>
    </nav>
  );

  // The team name is the H1 in the PageHeader band; a user without a team
  // gets "Home" with the shared-projects hint and the create-team action.
  const header = selectedTeam ? (
    <PageHeader title={selectedTeam.name} />
  ) : (
    <PageHeader title="Home" summary="Projects shared with you.">
      <Button href="/onboarding" variant="secondary">
        Create a team
      </Button>
    </PageHeader>
  );

  return (
    <PageShell header={header}>
      {!selectedTeam && <SharedProjectsList projects={sharedProjects} />}

      {selectedTeam && (
        !tasksLoaded ? (
          <>
            {scopeStrip}
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
            {scopeStrip}

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

            {/* Widgets: same six scopes as the scope strip above, rendered
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
    </PageShell>
  );
}
