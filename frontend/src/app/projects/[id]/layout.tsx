"use client";

// Hub layout for /projects/[id]/* routes.
// Fetches the project once (name, slug, githubRepo, governanceMode) and renders
// one header band:
//   1. The crumb `Projects / <project name> v`: the name is a picker over the
//      current team's projects (the shared projects for a user without a
//      team); choosing one opens the same tab of that project.
//   2. A compact project identity row (name H1, slug chip, repo chip, gov badge).
//   3. ProjectSubnav tab row (Board | Overview | Members | Workflow | Settings).
//   4. {children} wrapped in a content container (the board excepted, see
//      below); the board adds its toolbar directly below the band.
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
import { Skeleton } from "../../../components/ui/Skeleton";
import ProjectSubnav from "../../../components/projects/ProjectSubnav";
import ProjectPicker, { type ProjectOption } from "../../../components/dashboard/ProjectPicker";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";

const GOV_LABELS: Record<string, string> = {
  REQUIRES_DISTINCT_REVIEWER: "Dual-control",
  AWAITS_CONFIRMATION: "Awaits confirm",
  AUTONOMOUS: "Autonomous",
};

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
  // (Overview) has no segment.
  function switchProject(nextId: string) {
    router.push(projectHubHref(nextId, (segment as ProjectHubTab | null) ?? undefined));
  }

  const govLabel = project?.governanceMode
    ? GOV_LABELS[project.governanceMode]
    : null;

  // The Projects page of this project's team. Until the project is loaded the
  // plain Projects link keeps the row height stable.
  const crumbHref = project ? projectsHref({ teamId: project.teamId }) : projectsHref();

  return (
    <>
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

      {/* The board keeps the full-width canvas its column breakpoints
          (.db-board, viewport media queries) are written for; the
          1200px content container would squeeze its five columns. */}
      {segment === "board" ? (
        // The board runs its own project load and shows its own error banner
        // with Retry, so a failed hub load never replaces it.
        children
      ) : loadError ? (
        <div className="proj-hub-content">
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
        </div>
      ) : (
        <div className="proj-hub-content">{children}</div>
      )}
    </>
  );
}
