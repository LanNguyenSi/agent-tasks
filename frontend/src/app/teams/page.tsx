"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeams,
  getProjects,
  getTasks,
  createProject,
  deleteProject,
  syncTeamFromGitHub,
  type User,
  type Team,
  type Project,
} from "../../lib/api";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import DropdownMenu from "../../components/ui/DropdownMenu";
import EmptyState from "../../components/ui/EmptyState";
import FormField from "../../components/ui/FormField";
import { FullPageLoader } from "../../components/ui/FullPageLoader";
import Modal from "../../components/ui/Modal";
import Pagination from "../../components/ui/Pagination";
import Select from "@/components/ui/Select";
import { Skeleton } from "../../components/ui/Skeleton";

type ProjectSort = "name_asc" | "name_desc" | "newest" | "recent_sync";
const PROJECT_PAGE_SIZE = 9;

function ProjectCard({
  project,
  href,
  onDelete,
  activeTaskCount,
}: {
  project: Project;
  href: string;
  onDelete?: () => void;
  activeTaskCount?: number;
}) {
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Card interactive className="project-card">
      <Link href={href} className="project-card-link">
        <div className="project-card-title-row">
          <h3 className="project-card-title">{project.name}</h3>
        </div>
        {project.githubRepo ? (
          <p className="project-card-repo">GitHub: {project.githubRepo}</p>
        ) : (
          <p className="project-card-repo">Manual project</p>
        )}
        {project.description && (
          <p className="project-card-desc">{project.description}</p>
        )}
        {/* Reserve chip space so the card doesn't reflow when async counts arrive. */}
        <div className="project-card-chip-placeholder">
          {activeTaskCount !== undefined && activeTaskCount > 0 && (
            <span className="status-chip project-card-chip">
              {activeTaskCount} active {activeTaskCount === 1 ? "task" : "tasks"}
            </span>
          )}
        </div>
      </Link>
      <button
        ref={menuBtnRef}
        className="project-card-menu-btn"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        aria-label={`Actions for ${project.name}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>
      <DropdownMenu anchorRef={menuBtnRef} open={menuOpen} onClose={() => setMenuOpen(false)} minWidth={160}>
        <Link
          href={`/projects/workflow?projectId=${project.id}`}
          className="app-dropdown-item"
          onClick={() => setMenuOpen(false)}
        >
          Workflow
        </Link>
        {onDelete ? (
          <button
            className="app-dropdown-item app-dropdown-item-danger"
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
          >
            Delete project
          </button>
        ) : project.githubRepo ? (
          <p className="app-dropdown-item app-dropdown-item-disabled">
            Managed by GitHub sync
          </p>
        ) : null}
      </DropdownMenu>
    </Card>
  );
}

function ProjectCardSkeleton() {
  return (
    <Card className="project-card project-card--skeleton">
      <Skeleton height="1rem" width="60%" />
      <Skeleton height="0.75rem" width="40%" />
      <Skeleton height="0.75rem" width="80%" />
    </Card>
  );
}

export default function TeamsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [feedback, setFeedback] = useState<{
    message: string;
    tone: "success" | "warning" | "danger";
    title: string;
  } | null>(null);

  const [showNewProject, setShowNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [githubRepo, setGithubRepo] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [deletingProject, setDeletingProject] = useState(false);

  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [projectQuery, setProjectQuery] = useState("");
  const [projectSort, setProjectSort] = useState<ProjectSort>("name_asc");
  const [githubOnly, setGithubOnly] = useState(false);
  const [projectPage, setProjectPage] = useState(1);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) {
        router.replace("/auth");
        return;
      }
      setUser(me);

      const userTeams = await getTeams();
      if (userTeams.length === 0) {
        router.replace("/onboarding");
        return;
      }
      setTeams(userTeams);

      const lastTeamId =
        typeof window !== "undefined"
          ? window.localStorage.getItem("agent-tasks:lastTeamId")
          : null;
      const initialTeam =
        userTeams.find((t) => t.id === lastTeamId) ?? userTeams[0]!;
      setSelectedTeam(initialTeam);
      setLoading(false);

      setProjectsLoading(true);
      const initialProjects = await getProjects(initialTeam.id);
      setProjects(initialProjects);
      setProjectsLoading(false);
    })();
  }, [router]);

  async function loadProjects(teamId: string) {
    setProjectsLoading(true);
    try {
      const teamProjects = await getProjects(teamId);
      setProjects(teamProjects);
    } finally {
      setProjectsLoading(false);
    }
  }

  function handleProjectNameChange(name: string) {
    setProjectName(name);
    if (!slugTouched) {
      setProjectSlug(
        name
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 50),
      );
    }
  }

  function handleTeamSwitch(teamId: string) {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;
    setSelectedTeam(team);
    if (typeof window !== "undefined")
      window.localStorage.setItem("agent-tasks:lastTeamId", teamId);
    void loadProjects(teamId);
  }

  function closeNewProjectModal() {
    setShowNewProject(false);
    setProjectName("");
    setProjectSlug("");
    setSlugTouched(false);
    setGithubRepo("");
    setError(null);
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTeam) return;
    setCreating(true);
    setError(null);
    try {
      const project = await createProject({
        teamId: selectedTeam.id,
        name: projectName.trim(),
        slug: projectSlug.trim(),
        githubRepo: githubRepo.trim() || undefined,
      });
      setProjects((prev) => [...prev, project]);
      closeNewProjectModal();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirmDeleteProject() {
    if (!deleteTarget) return;
    setDeletingProject(true);
    setError(null);
    try {
      await deleteProject(deleteTarget.id);
      setProjects((prev) => prev.filter((project) => project.id !== deleteTarget.id));
      setFeedback({
        tone: "success",
        title: "Project deleted",
        message: `Project "${deleteTarget.name}" deleted.`,
      });
      setDeleteTarget(null);
    } catch (err) {
      setFeedback({
        tone: "danger",
        title: "Delete failed",
        message: (err as Error).message,
      });
    } finally {
      setDeletingProject(false);
    }
  }

  const filteredProjects = useMemo(() => {
    const normalizedQuery = projectQuery.trim().toLowerCase();
    const filtered = projects.filter((project) => {
      if (githubOnly && !project.githubRepo) return false;
      if (!normalizedQuery) return true;
      return `${project.name} ${project.slug} ${project.githubRepo ?? ""} ${project.description ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery);
    });

    return filtered.sort((a, b) => {
      if (projectSort === "name_asc") return a.name.localeCompare(b.name);
      if (projectSort === "name_desc") return b.name.localeCompare(a.name);
      if (projectSort === "recent_sync") {
        return (
          new Date(b.githubSyncAt ?? 0).getTime() -
            new Date(a.githubSyncAt ?? 0).getTime() ||
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [projects, projectQuery, projectSort, githubOnly]);

  useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;

    async function fetchTaskCounts() {
      const results = await Promise.allSettled(
        projects.map(async (p) => {
          const tasks = await getTasks(p.id);
          return [p.id, tasks.filter((t) => t.status !== "done").length] as const;
        }),
      );
      if (cancelled) return;
      const counts: Record<string, number> = {};
      for (const r of results) {
        if (r.status === "fulfilled") counts[r.value[0]] = r.value[1];
      }
      setTaskCounts(counts);
    }

    void fetchTaskCounts();
    const interval = setInterval(() => void fetchTaskCounts(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projects]);

  useEffect(() => {
    setProjectPage(1);
  }, [selectedTeam?.id, projectQuery, projectSort, githubOnly]);

  const totalProjectPages = Math.max(1, Math.ceil(filteredProjects.length / PROJECT_PAGE_SIZE));
  const currentProjectPage = Math.min(projectPage, totalProjectPages);
  const pagedProjects = filteredProjects.slice(
    (currentProjectPage - 1) * PROJECT_PAGE_SIZE,
    currentProjectPage * PROJECT_PAGE_SIZE,
  );

  if (loading) {
    return <FullPageLoader label="Loading teams…" />;
  }

  return (
    <main className="page-shell">
      {selectedTeam && (
        <>
          <div className="teams-header-row">
            <div>
              {teams.length > 1 && (
                <div className="teams-team-switcher">
                  <Select
                    ariaLabel="Switch team"
                    value={selectedTeam.id}
                    onChange={handleTeamSwitch}
                    options={teams.map((t) => ({ value: t.id, label: t.name }))}
                  />
                </div>
              )}
              <h1 className="teams-page-title">{selectedTeam.name}</h1>
              <p className="teams-project-count">
                {selectedTeam.projectCount ?? projects.length} projects
              </p>
            </div>
            <div className="teams-actions">
              {!user?.githubConnected ? (
                <Button href="/api/auth/github/connect" variant="primary">
                  Connect GitHub
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    void (async () => {
                      setFeedback(null);
                      setSyncing(true);
                      try {
                        const result = await syncTeamFromGitHub(selectedTeam.id);
                        await loadProjects(selectedTeam.id);
                        if (result.skippedPrune) {
                          setFeedback({
                            tone: "warning",
                            title: "Sync completed",
                            message: result.message,
                          });
                        } else if (
                          result.created === 0 &&
                          result.updated === 0 &&
                          result.pruned === 0
                        ) {
                          setFeedback({
                            tone: "success",
                            title: "Already up to date",
                            message:
                              "No projects were created, updated, or pruned.",
                          });
                        } else {
                          setFeedback({
                            tone: "success",
                            title: "Sync completed",
                            message: `${result.created} created, ${result.updated} updated, ${result.pruned} pruned.`,
                          });
                        }
                      } catch (err) {
                        setFeedback({
                          tone: "danger",
                          title: "Sync failed",
                          message: (err as Error).message,
                        });
                      } finally {
                        setSyncing(false);
                      }
                    })();
                  }}
                  disabled={syncing}
                  loading={syncing}
                >
                  {syncing ? "Syncing…" : "Sync GitHub"}
                </Button>
              )}
              <Button
                onClick={() => {
                  setError(null);
                  setShowNewProject(true);
                }}
              >
                + New Project
              </Button>
            </div>
          </div>

          {!user?.githubConnected && (
            <AlertBanner tone="warning" title="GitHub is not connected yet">
              Sync is unavailable until GitHub is connected.{" "}
              <Link href="/settings" className="settings-inline-link">
                Connect now
              </Link>
            </AlertBanner>
          )}

          {feedback && (
            <AlertBanner
              tone={feedback.tone}
              title={feedback.title}
              onDismiss={() => setFeedback(null)}
            >
              {feedback.message}
            </AlertBanner>
          )}

          <Modal open={showNewProject} onClose={closeNewProjectModal} title="New Project">
            <form onSubmit={(e) => void handleCreateProject(e)}>
              <div className="project-form-grid">
                <FormField label="Name">
                  <input
                    value={projectName}
                    onChange={(e) => handleProjectNameChange(e.target.value)}
                    placeholder="My Project"
                    required
                    className="settings-input"
                  />
                </FormField>
                <FormField label="Slug">
                  <input
                    value={projectSlug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setProjectSlug(e.target.value);
                    }}
                    placeholder="my-project"
                    pattern="[a-z0-9-]+"
                    required
                    className="settings-input settings-input--mono"
                  />
                </FormField>
              </div>
              {!slugTouched && (
                <p className="teams-slug-hint">
                  The slug auto-generates from the name. Edit it to customize
                  (lowercase letters, numbers, hyphens).
                </p>
              )}
              <div className="teams-github-repo-field">
                <FormField label="GitHub Repo (optional)">
                  <input
                    value={githubRepo}
                    onChange={(e) => setGithubRepo(e.target.value)}
                    placeholder="owner/repo"
                    className="settings-input"
                  />
                </FormField>
              </div>
              {error && (
                <AlertBanner tone="danger" title="Failed to create project">
                  {error}
                </AlertBanner>
              )}
              <div className="settings-modal-actions">
                <Button type="submit" disabled={creating} loading={creating} size="sm">
                  {creating ? "Creating…" : "Create"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={closeNewProjectModal}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Modal>

          <Card padding="sm" className="teams-filter-card">
            <div className="teams-filter-bar">
              <input
                type="search"
                aria-label="Search projects"
                value={projectQuery}
                onChange={(e) => setProjectQuery(e.target.value)}
                placeholder="Search projects (name, slug, repo)..."
                className="teams-search-input"
              />
              <Select
                value={projectSort}
                onChange={(v) => setProjectSort(v as ProjectSort)}
                options={[
                  { value: "name_asc", label: "Sort: Name A-Z" },
                  { value: "name_desc", label: "Sort: Name Z-A" },
                  { value: "newest", label: "Sort: Newest first" },
                  { value: "recent_sync", label: "Sort: Recently synced" },
                ]}
              />
              <label className="teams-github-only-label">
                <input
                  type="checkbox"
                  checked={githubOnly}
                  onChange={(e) => setGithubOnly(e.target.checked)}
                />
                GitHub projects only
              </label>
            </div>
            <p className="teams-count-hint">
              {filteredProjects.length === 0
                ? "No projects"
                : `Showing ${(currentProjectPage - 1) * PROJECT_PAGE_SIZE + 1}-${Math.min(currentProjectPage * PROJECT_PAGE_SIZE, filteredProjects.length)} of ${filteredProjects.length}`}
            </p>
          </Card>

          {projectsLoading ? (
            <div className="projects-grid" aria-busy="true" aria-label="Loading projects">
              {Array.from({ length: 6 }, (_, i) => (
                <ProjectCardSkeleton key={i} />
              ))}
            </div>
          ) : filteredProjects.length === 0 ? (
            <EmptyState
              icon="box"
              title={projects.length === 0 ? "No projects yet." : "No projects match this filter."}
              description={
                projects.length === 0
                  ? "Create your first project to get started."
                  : "Try adjusting the search or filter."
              }
              dashed
              action={
                projects.length === 0 ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setError(null);
                      setShowNewProject(true);
                    }}
                  >
                    + New Project
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="projects-grid">
                {pagedProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    href={`/dashboard?teamId=${selectedTeam.id}&projectId=${project.id}`}
                    onDelete={
                      !project.githubRepo
                        ? () =>
                            setDeleteTarget({ id: project.id, name: project.name })
                        : undefined
                    }
                    activeTaskCount={taskCounts[project.id]}
                  />
                ))}
              </div>
              <Pagination
                page={currentProjectPage}
                totalPages={totalProjectPages}
                onPageChange={setProjectPage}
              />
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete project?"
        message={
          deleteTarget
            ? `Project "${deleteTarget.name}" including boards and tasks will be permanently removed.`
            : ""
        }
        confirmLabel="Delete project"
        cancelLabel="Keep project"
        tone="danger"
        busy={deletingProject}
        onConfirm={() => void handleConfirmDeleteProject()}
        onCancel={() => {
          if (deletingProject) return;
          setDeleteTarget(null);
        }}
      />
    </main>
  );
}
