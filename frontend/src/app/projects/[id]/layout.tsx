"use client";

// Hub layout for /projects/[id]/* routes.
// Fetches the project once (name, slug, githubRepo, governanceMode) and renders:
//   1. A compact project identity header (name H1, slug chip, repo chip, gov badge).
//   2. ProjectSubnav tab row (Board | Members | Workflow | Settings).
//   3. {children} wrapped in a content container (the board excepted, see below).
//
// Child pages no longer render their own project heading; this layout owns it.
// Geometry in .proj-hub-* / .proj-subnav-* in globals.css.

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSelectedLayoutSegment } from "next/navigation";
import { ApiRequestError, getProject, type Project } from "../../../lib/api";
import { boardHref, projectsHref } from "../../../lib/routes";
import { Skeleton } from "../../../components/ui/Skeleton";
import ProjectSubnav from "../../../components/projects/ProjectSubnav";
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

  const govLabel = project?.governanceMode
    ? GOV_LABELS[project.governanceMode]
    : null;

  // This project's board. Until the project is loaded, the bare /dashboard
  // link (resumes the last board) keeps the row height stable.
  const dashboardHref = project
    ? boardHref({ teamId: project.teamId, projectId: project.id })
    : boardHref();

  return (
    <>
      <div className="proj-hub-header">
        <nav className="proj-hub-breadcrumb" aria-label="Breadcrumb">
          <Link href={dashboardHref}>Dashboard</Link>
          {project && (
            <>
              <span aria-hidden="true">/</span>
              <span className="proj-hub-breadcrumb-current" aria-current="page">
                {project.name}
              </span>
            </>
          )}
        </nav>
        {loading ? (
          <div className="proj-hub-title-row">
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
            <span className="proj-chip">{project.slug}</span>
            {project.githubRepo && (
              <a
                href={`https://github.com/${project.githubRepo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="proj-chip"
              >
                {project.githubRepo}
              </a>
            )}
            {govLabel && (
              <span className="proj-gov-badge">{govLabel}</span>
            )}
          </div>
        ) : null}
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
