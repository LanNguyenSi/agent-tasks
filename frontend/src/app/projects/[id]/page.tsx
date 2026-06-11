"use client";

// Overview tab for /projects/[id].
// Shows project metadata, task counts by status, and quick-links.
// The project name/slug header is rendered by the hub layout; this page
// renders the content body only.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getProject,
  getTasks,
  type Project,
  type Task,
} from "../../../lib/api";
import Card from "../../../components/ui/Card";
import { normalizeStatus } from "../../../lib/taskDisplay";
import { StatusChip } from "../../../components/ui/StatusChip";
import { Skeleton } from "../../../components/ui/Skeleton";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";

const STATUS_ORDER = ["open", "in-progress", "review", "done"];

const GOV_LABELS: Record<string, string> = {
  REQUIRES_DISTINCT_REVIEWER: "Requires distinct reviewer",
  AWAITS_CONFIRMATION: "Awaits human confirmation",
  AUTONOMOUS: "Autonomous",
};

function countByStatus(tasks: Task[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const t of tasks) {
    const key = normalizeStatus(t.status);
    acc[key] = (acc[key] ?? 0) + 1;
  }
  return acc;
}

export default function ProjectOverviewPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [proj, taskList] = await Promise.all([
          getProject(projectId),
          getTasks(projectId),
        ]);
        if (cancelled) return;
        setProject(proj);
        setTasks(taskList);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading project overview</span>
        <div className="proj-stat-row">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} width={110} height="2.25rem" radius="var(--radius-base)" />
          ))}
        </div>
        <Skeleton height="10rem" radius="var(--radius-lg)" />
      </div>
    );
  }

  if (error) {
    return <AlertBanner tone="danger">{error}</AlertBanner>;
  }

  if (!project) return null;

  const counts = tasks ? countByStatus(tasks) : {};
  const knownStatuses = STATUS_ORDER.filter((s) => s in counts);
  const customStatuses = Object.keys(counts).filter(
    (s) => !STATUS_ORDER.includes(s),
  );
  const allStatuses = [...knownStatuses, ...customStatuses];
  const boardHref = `/dashboard?teamId=${project.teamId}&projectId=${projectId}`;
  const govLabel = project.governanceMode
    ? (GOV_LABELS[project.governanceMode] ?? project.governanceMode)
    : "—";

  return (
    <>
      {allStatuses.length > 0 && (
        <div className="proj-stat-row">
          {allStatuses.map((status) => (
            <div key={status} className="proj-stat">
              <StatusChip status={status} />
              <span className="proj-stat-count num">{counts[status]}</span>
            </div>
          ))}
        </div>
      )}

      <Card
        surface="raised"
        // eslint-disable-next-line no-restricted-syntax
        style={{ maxWidth: 720, marginBottom: "var(--space-4)" }} /* dynamic: max-width + spacing */
      >
        <p className="proj-section-head">Project details</p>
        <div className="proj-overview-grid">
          <div>
            <p className="proj-meta-label">Slug</p>
            <p className="proj-meta-value">{project.slug}</p>
          </div>
          <div>
            <p className="proj-meta-label">Governance</p>
            <p className="proj-meta-value">{govLabel}</p>
          </div>
          {project.githubRepo && (
            <div>
              <p className="proj-meta-label">GitHub repository</p>
              <p className="proj-meta-value">
                <a
                  href={`https://github.com/${project.githubRepo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {project.githubRepo}
                </a>
              </p>
            </div>
          )}
          <div>
            <p className="proj-meta-label">Created</p>
            <p className="proj-meta-value">
              {new Date(project.createdAt).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </p>
          </div>
        </div>
      </Card>

      <div className="proj-overview-actions">
        <Button href={boardHref} variant="primary" size="sm">
          Open board
        </Button>
        <Button
          href={`/projects/${projectId}/settings`}
          variant="ghost"
          size="sm"
        >
          Settings
        </Button>
        <Button
          href={`/projects/${projectId}/members`}
          variant="ghost"
          size="sm"
        >
          Members &amp; invites
        </Button>
      </div>

      {tasks !== null && tasks.length === 0 && (
        <p
          // eslint-disable-next-line no-restricted-syntax
          style={{ marginTop: "var(--space-5)", color: "var(--muted)", fontSize: "var(--text-sm)" }} /* dynamic: top spacing */
        >
          No tasks yet.{" "}
          <Link href={boardHref}>Open the board</Link> to create the first one.
        </p>
      )}
    </>
  );
}
