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

type ProjectSort = "name_asc" | "name_desc" | "newest" | "recent_sync";
const PROJECT_PAGE_SIZE = 9;

function ProjectCard({ project, href, onDelete, activeTaskCount }: { project: Project; href: string; onDelete?: () => void; activeTaskCount?: number }) {
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Card interactive style={{ height: "100%", position: "relative" }}>
      <Link href={href} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
        <div style={{ marginBottom: "0.25rem", paddingRight: "2rem" }}>
          <h3 style={{ fontWeight: 600, color: "var(--text)" }}>{project.name}</h3>
        </div>
        {project.githubRepo ? (
          <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.5rem" }}>GitHub: {project.githubRepo}</p>
        ) : (
          <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.5rem" }}>Manual project</p>
        )}
        {project.description && <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginBottom: "0.5rem" }}>{project.description}</p>}
        {/* Reserve the chip's space so the card doesn't reflow when the
            async task counts arrive. */}
        <div style={{ minHeight: "1.6rem" }}>
          {activeTaskCount !== undefined && activeTaskCount > 0 && (
            <span
              className="status-chip"
              style={{
                color: "var(--primary, #3b82f6)",
                borderColor: "color-mix(in srgb, var(--primary, #3b82f6) 55%, var(--border) 45%)",
                fontSize: "var(--text-xs)",
              }}
            >
              {activeTaskCount} active {activeTaskCount === 1 ? "task" : "tasks"}
            </span>
          )}
        </div>
      </Link>
      <button
        ref={menuBtnRef}
        className="project-card-menu-btn"
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        aria-label={`Actions for ${project.name}`}
        style={{ position: "absolute", top: "0.75rem", right: "0.75rem" }}
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
            onClick={() => { setMenuOpen(false); onDelete(); }}
          >
            Delete project
          </button>
        ) : project.githubRepo ? (
          <p className="app-dropdown-item" style={{ color: "var(--muted)", cursor: "default", margin: 0 }}>
            Managed by GitHub sync
          </p>
        ) : null}
      </DropdownMenu>
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
  // Single feedback banner for both sync and delete outcomes, each carrying
  // its own title so a deleted project no longer reads as "Sync completed".
  const [feedback, setFeedback] = useState<{ message: string; tone: "success" | "warning" | "danger"; title: string } | null>(null);

  const [showNewProject, setShowNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [githubRepo, setGithubRepo] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
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

      const lastTeamId = typeof window !== "undefined" ? window.localStorage.getItem("agent-tasks:lastTeamId") : null;
      const initialTeam = userTeams.find((t) => t.id === lastTeamId) ?? userTeams[0]!;
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
    // Don't clobber a slug the user has hand-edited.
    if (!slugTouched) {
      setProjectSlug(name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 50));
    }
  }

  function handleTeamSwitch(teamId: string) {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;
    setSelectedTeam(team);
    if (typeof window !== "undefined") window.localStorage.setItem("agent-tasks:lastTeamId", teamId);
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
      setFeedback({ tone: "success", title: "Project deleted", message: `Project "${deleteTarget.name}" deleted.` });
      setDeleteTarget(null);
    } catch (err) {
      // Surface delete failures on the page-level banner; the modal-scoped
      // `error` only renders inside the New Project modal, so a failed delete
      // with that modal closed would otherwise be invisible.
      setFeedback({ tone: "danger", title: "Delete failed", message: (err as Error).message });
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
          new Date(b.githubSyncAt ?? 0).getTime() - new Date(a.githubSyncAt ?? 0).getTime() ||
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
      // allSettled so one project's failed fetch doesn't drop every count.
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
    return () => { cancelled = true; clearInterval(interval); };
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
                <div style={{ maxWidth: "240px", marginBottom: "0.5rem" }}>
                  <Select
                    ariaLabel="Switch team"
                    value={selectedTeam.id}
                    onChange={handleTeamSwitch}
                    options={teams.map((t) => ({ value: t.id, label: t.name }))}
                  />
                </div>
              )}
              <h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700 }}>{selectedTeam.name}</h1>
              <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>{selectedTeam.projectCount ?? projects.length} projects</p>
            </div>
            <div className="teams-actions">
              {!user?.githubConnected ? (
                <Link
                  href="/api/auth/github/connect"
                  className="btn-primary"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "var(--radius-base)",
                    padding: "0.5rem 1rem",
                    fontWeight: 600,
                    fontSize: "var(--text-base)",
                    textDecoration: "none",
                  }}
                >
                  Connect GitHub
                </Link>
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
                          setFeedback({ tone: "warning", title: "Sync completed", message: result.message });
                        } else if (result.created === 0 && result.updated === 0 && result.pruned === 0) {
                          setFeedback({ tone: "success", title: "Already up to date", message: "No projects were created, updated, or pruned." });
                        } else {
                          setFeedback({
                            tone: "success",
                            title: "Sync completed",
                            message: `${result.created} created, ${result.updated} updated, ${result.pruned} pruned.`,
                          });
                        }
                      } catch (err) {
                        setFeedback({ tone: "danger", title: "Sync failed", message: (err as Error).message });
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
              Sync is unavailable until GitHub is connected.
              {" "}
              <Link href="/settings" style={{ color: "var(--primary)", textDecoration: "none" }}>Connect now</Link>
            </AlertBanner>
          )}

          {feedback && (
            <AlertBanner tone={feedback.tone} title={feedback.title} onDismiss={() => setFeedback(null)}>
              {feedback.message}
            </AlertBanner>
          )}

          <Modal open={showNewProject} onClose={closeNewProjectModal} title="New Project">
            <form onSubmit={(e) => void handleCreateProject(e)}>
              <div className="project-form-grid">
                <FormField label="Name">
                  <input value={projectName} onChange={(e) => handleProjectNameChange(e.target.value)} placeholder="My Project" required style={{ width: "100%", display: "block" }} />
                </FormField>
                <FormField label="Slug">
                  <input value={projectSlug} onChange={(e) => { setSlugTouched(true); setProjectSlug(e.target.value); }} placeholder="my-project" pattern="[a-z0-9-]+" required style={{ width: "100%", display: "block", fontFamily: "monospace" }} />
                </FormField>
              </div>
              {!slugTouched && (
                <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginTop: "-0.4rem", marginBottom: "0.75rem" }}>
                  The slug auto-generates from the name. Edit it to customize (lowercase letters, numbers, hyphens).
                </p>
              )}
              <div style={{ marginBottom: "0.75rem" }}>
                <FormField label="GitHub Repo (optional)">
                  <input value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} placeholder="owner/repo" style={{ width: "100%", display: "block" }} />
                </FormField>
              </div>
              {error && (
                <AlertBanner tone="danger" title="Failed to create project">
                  {error}
                </AlertBanner>
              )}
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <Button type="submit" disabled={creating} loading={creating} size="sm">
                  {creating ? "Creating…" : "Create"}
                </Button>
                <Button variant="ghost" size="sm" type="button" onClick={closeNewProjectModal}>
                  Cancel
                </Button>
              </div>
            </form>
          </Modal>

          <Card style={{ marginBottom: "0.9rem" }} padding="sm">
            <div className="teams-filter-bar">
              <input
                type="search"
                aria-label="Search projects"
                value={projectQuery}
                onChange={(e) => setProjectQuery(e.target.value)}
                placeholder="Search projects (name, slug, repo)..."
                style={{ width: "100%" }}
              />
              <Select
                value={projectSort}
                onChange={(v) => setProjectSort(v as ProjectSort)}
                options={[{value:"name_asc",label:"Sort: Name A-Z"},{value:"name_desc",label:"Sort: Name Z-A"},{value:"newest",label:"Sort: Newest first"},{value:"recent_sync",label:"Sort: Recently synced"}]}
                style={{ width: "100%" }}
              />
              <label style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", color: "var(--muted)", fontSize: "var(--text-sm)", paddingLeft: "0.25rem" }}>
                <input
                  type="checkbox"
                  checked={githubOnly}
                  onChange={(e) => setGithubOnly(e.target.checked)}
                />
                GitHub projects only
              </label>
            </div>
            <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>
              {filteredProjects.length === 0
                ? "No projects"
                : `Showing ${(currentProjectPage - 1) * PROJECT_PAGE_SIZE + 1}-${Math.min(currentProjectPage * PROJECT_PAGE_SIZE, filteredProjects.length)} of ${filteredProjects.length}`}
            </p>
          </Card>

          {projectsLoading ? (
            <p style={{ color: "var(--muted)" }}>Loading projects…</p>
          ) : filteredProjects.length === 0 ? (
            <EmptyState
              message={projects.length === 0 ? "No projects yet." : "No projects match this filter."}
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
                    onDelete={!project.githubRepo ? () => setDeleteTarget({ id: project.id, name: project.name }) : undefined}
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
