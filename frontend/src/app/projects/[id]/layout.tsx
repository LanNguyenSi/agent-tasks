"use client";

// Hub layout for /projects/[id]/* routes.
// Fetches the project once (name, slug, githubRepo, governanceMode) and renders
// one header band:
//   1. The crumb `Projects / <project name> v`: the name is a picker over the
//      current team's projects (the shared projects for a user without a
//      team); choosing one opens the same tab of that project.
//   2. A compact project identity row (name H1, slug chip, repo chip, gov badge).
//   3. ProjectSubnav tab row (Board | Members | Workflow | Settings).
//   4. {children} in the PageShell content slot (1200px, left-aligned; the
//      board is wide and flush, see below); the board adds its toolbar
//      directly below the band.
// The band is the PageShell header slot, full width with the page gutter, so
// it keeps its place on every tab. The shell renders the page's only <main>.
//
// Child pages render no project heading of their own; this layout owns the
// page's only H1.
// Geometry in .proj-hub-* / .proj-subnav-* in globals.css.

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSelectedLayoutSegment } from "next/navigation";
import {
  ApiRequestError,
  getProject,
  getProjects,
  getTeams,
  type Project,
  type Team,
} from "../../../lib/api";
import { resolveCurrentTeam } from "../../../lib/currentTeam";
import { projectHubHref, projectsHref, type ProjectHubTab } from "../../../lib/routes";
import DocumentTitle from "../../../components/DocumentTitle";
import { Skeleton } from "../../../components/ui/Skeleton";
import ProjectSubnav from "../../../components/projects/ProjectSubnav";
import ProjectPicker, { type ProjectOption } from "../../../components/dashboard/ProjectPicker";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";
import { PageShell } from "../../../components/ui/PageShell";
import { BOARD_REGION_ID } from "../../../components/dashboard/boardRegion";
import { GOVERNANCE_LABELS } from "../../../lib/governance";

const HUB_TAB_TITLES: Record<ProjectHubTab, string> = {
  board: "Board",
  members: "Members",
  workflow: "Workflow",
  settings: "Settings",
};

// The hub root has no segment and redirects to the board.
function hubTabTitle(segment: string | null): string {
  return HUB_TAB_TITLES[(segment ?? "board") as ProjectHubTab] ?? "Project";
}

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();
  const segment = useSelectedLayoutSegment();

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The picker's list. Empty until it loads or when it fails: the picker then
  // offers the current project alone (see `pickerProjects`).
  const [siblings, setSiblings] = useState<ProjectOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const proj = await getProject(projectId);
        if (!cancelled) setProject(proj);
      } catch (err) {
        if (cancelled) return;
        // Missing or not accessible (404/403): back to the Projects page.
        // Not boardHref(): its bare /dashboard resumes the last board, which
        // may be this one. Any other failure (500, network, 401) is not
        // proof the project is gone, so stay and show the error instead.
        if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) {
          router.replace(projectsHref());
        } else {
          setLoadError((err as Error).message || "Could not load the project");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, router, reloadKey]);

  // Picker source. A member of the project's team lists that team's projects.
  // Anyone else (a per-project share) lists their current team's projects, or,
  // with no team at all, only the projects shared with them: the call without
  // a teamId. Both listings carry the projects shared with the caller.
  // Best effort: a failure leaves the picker with the current project only.
  const projectTeamId = project?.teamId;
  useEffect(() => {
    if (!projectTeamId) return;
    let cancelled = false;
    void (async () => {
      try {
        const teams = await getTeams().catch((): Team[] => []);
        const scopeTeamId = teams.some((t) => t.id === projectTeamId)
          ? projectTeamId
          : resolveCurrentTeam(teams, { urlTeamId: null })?.id;
        const list = await getProjects(scopeTeamId);
        if (!cancelled) {
          setSiblings(
            list.map((p) => ({ id: p.id, name: p.name, accessSource: p.accessSource })),
          );
        }
      } catch {
        if (!cancelled) setSiblings([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectTeamId]);

  const pickerProjects: ProjectOption[] = project
    ? siblings.some((p) => p.id === project.id)
      ? siblings
      : [{ id: project.id, name: project.name, accessSource: project.accessSource }, ...siblings]
    : [];

  // Choosing a project keeps the tab (board, members, ...); the hub root
  // has no segment and redirects to the board.
  function switchProject(nextId: string) {
    router.push(projectHubHref(nextId, (segment as ProjectHubTab | null) ?? undefined));
  }

  const govLabel = project?.governanceMode
    ? GOVERNANCE_LABELS[project.governanceMode]
    : null;

  // The Projects page of this project's team. Until the project is loaded the
  // plain Projects link keeps the row height stable.
  const crumbHref = project ? projectsHref({ teamId: project.teamId }) : projectsHref();

  const hubBand = (
    <>
      <DocumentTitle
        title={project ? `${project.name} · ${hubTabTitle(segment)}` : "Project"}
      />
      <div className="proj-hub-header">
        <nav className="proj-hub-breadcrumb" aria-label="Breadcrumb">
          <Link href={crumbHref}>Projects</Link>
          {project && (
            <>
              <span aria-hidden="true">/</span>
              <span className="proj-hub-breadcrumb-current" aria-current="page">
                <ProjectPicker
                  projects={pickerProjects}
                  selectedProjectId={project.id}
                  onSelect={switchProject}
                />
              </span>
            </>
          )}
        </nav>
        {loading ? (
          <div className="proj-hub-title-row">
            <h1 className="sr-only">Project</h1>
            <Skeleton
              width={200}
              height="1.25rem"
              /* dynamic: width/height are Skeleton props */
            />
            <Skeleton
              width={80}
              height="1rem"
              /* dynamic: width/height are Skeleton props */
            />
          </div>
        ) : project ? (
          <div className="proj-hub-title-row">
            <h1 className="proj-hub-name">{project.name}</h1>
            <span className="proj-chip"><span className="proj-chip-text">{project.slug}</span></span>
            {project.githubRepo && (
              <a
                href={`https://github.com/${project.githubRepo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="proj-chip"
              >
                <span className="proj-chip-text">{project.githubRepo}</span>
              </a>
            )}
            {govLabel && (
              <span className="proj-gov-badge">{govLabel}</span>
            )}
          </div>
        ) : (
          <h1 className="sr-only">Project</h1>
        )}
      </div>

      <ProjectSubnav projectId={projectId} />
    </>
  );

  // One <main> for every tab. The hub band (identity header and tab row) is
  // the shell's full-width header slot, so it does not move between tabs. The
  // board keeps the full-width canvas its column breakpoints (.db-board,
  // viewport media queries) are written for and owns its side gutter (flush);
  // the other tabs sit in the 1200px content column, left-aligned.
  if (segment === "board") {
    // The board runs its own project load and shows its own error banner
    // with Retry, so a failed hub load never replaces it.
    // "Skip to board" comes first, before the hub band and the toolbar; the
    // board page renders its target (in every state), the layout knows
    // neither the view nor the load state.
    return (
      <PageShell
        variant="wide"
        flush
        header={
          <>
            <a className="skip-link" href={`#${BOARD_REGION_ID}`}>
              Skip to board
            </a>
            {hubBand}
          </>
        }
      >
        {children}
      </PageShell>
    );
  }

  return (
    <PageShell header={hubBand}>
      {loadError ? (
        <>
          <AlertBanner tone="danger" title="Could not load project">
            {loadError}
          </AlertBanner>
          <Button
            variant="ghost"
            size="sm"
            className="db-retry-btn"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Retry
          </Button>
        </>
      ) : (
        children
      )}
    </PageShell>
  );
}
