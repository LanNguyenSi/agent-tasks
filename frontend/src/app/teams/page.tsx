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
  type Task,
} from "../../lib/api";
import { formatRelativeTime } from "../../lib/time";
import AppHeader from "../../components/AppHeader";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import DropdownMenu from "../../components/ui/DropdownMenu";
import EmptyState from "../../components/ui/EmptyState";
import FormField from "../../components/ui/FormField";
import Modal from "../../components/ui/Modal";
import Pagination from "../../components/ui/Pagination";
import Select from "@/components/ui/Select";

type ProjectSort = "name_asc" | "name_desc" | "newest" | "recent_sync";
const PROJECT_PAGE_SIZE = 9;

function ProjectCard({ project, href, onDelete, activeTaskCount }: { project: Project; href: string; onDelete?: () => void; activeTaskCount?: number }) {
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Link href={href} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card interactive style={{ height: "100%", position: "relative" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", marginBottom: "0.25rem" }}>
          <h3 style={{ fontWeight: 600, color: "var(--text)" }}>{project.name}</h3>
          <button
            ref={menuBtnRef}
            className="project-card-menu-btn"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen((v) => !v); }}
            aria-label={`Actions for ${project.name}`}
          >
            ···
          </button>
        </div>
        {project.githubRepo ? (
          <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.5rem" }}>GitHub: {project.githubRepo}</p>
        ) : (
          <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.5rem" }}>Manual project</p>
        )}
        {project.description && <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginBottom: "0.5rem" }}>{project.description}</p>}
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
        <DropdownMenu anchorRef={menuBtnRef} open={menuOpen} onClose={() => setMenuOpen(false)} minWidth={160}>
          <Link
            href={`/projects/workflows?projectId=${project.id}`}
            className="app-dropdown-item"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
          >
            Workflow
          </Link>
          {onDelete && (
            <button
              className="app-dropdown-item app-dropdown-item-danger"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onDelete(); }}
            >
              Delete project
            </button>
          )}
        </DropdownMenu>
      </Card>
    </Link>
  );
}

export default function TeamsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncTone, setSyncTone] = useState<"success" | "warning" | "danger">("success");

  const [showNewProject, setShowNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);

  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [openTasks, setOpenTasks] = useState<(Task & { projectName: string })[]>([]);
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

      const initialTeam = userTeams[0]!;
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
    setProjectSlug(name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 50));
  }

  function closeNewProjectModal() {
    setShowNewProject(false);
    setProjectName("");
    setProjectSlug("");
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
      setSyncTone("success");
      setSyncMessage(`Project "${deleteTarget.name}" deleted.`);
      setDeleteTarget(null);
    } catch (err) {
      setError((err as Error).message);
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
      const allOpen: (Task & { projectName: string })[] = [];
      const results = await Promise.all(
        projects.map(async (p) => {
          const tasks = await getTasks(p.id);
          for (const t of tasks) {
            // Widget shows actionable tasks only; "review" tasks are tracked in project counts but excluded here
            if (t.status === "open" || t.status === "in_progress") {
              allOpen.push({ ...t, projectName: p.name });
            }
          }
          return [p.id, tasks.filter((t) => t.status !== "done").length] as const;
        }),
      );
      if (!cancelled) {
        setTaskCounts(Object.fromEntries(results));
        allOpen.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        setOpenTasks(allOpen);
      }
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
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <AppHeader
        user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null}
        boardHref={selectedTeam && projects[0] ? `/dashboard?teamId=${selectedTeam.id}&projectId=${projects[0].id}` : "/dashboard"}
      />

      <Card padding="sm" style={{ marginBottom: "var(--space-4)", color: "var(--muted)", fontSize: "var(--text-sm)" }}>
        Your team workspace: create or sync projects, then jump straight into the board.
      </Card>

      {selectedTeam && (
        <>
          <div className="teams-header-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", gap: "0.75rem", flexWrap: "wrap" }}>
            <div>
              <h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700 }}>{selectedTeam.name}</h1>
              <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>{selectedTeam.projectCount ?? projects.length} projects</p>
            </div>
            <div className="teams-actions" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {!user?.githubConnected ? (
                <Link
                  href="/api/auth/github/connect"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "#0f172a",
                    color: "white",
                    borderRadius: "8px",
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
                      setSyncMessage(null);
                      setSyncTone("success");
                      setSyncing(true);
                      try {
                        const result = await syncTeamFromGitHub(selectedTeam.id);
                        await loadProjects(selectedTeam.id);
                        if (result.skippedPrune) {
                          setSyncMessage(result.message);
                          setSyncTone("warning");
                        } else {
                          setSyncMessage(
                            `GitHub sync complete: ${result.created} created, ${result.updated} updated, ${result.pruned} pruned.`,
                          );
                          setSyncTone("success");
                        }
                      } catch (err) {
                        setSyncMessage((err as Error).message);
                        setSyncTone("danger");
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

          {syncMessage && (
            <AlertBanner tone={syncTone} title={syncTone === "success" ? "Sync completed" : "Sync failed"}>
              {syncMessage}
            </AlertBanner>
          )}

          <Modal open={showNewProject} onClose={closeNewProjectModal} title="New Project">
            <form onSubmit={(e) => void handleCreateProject(e)}>
              <div className="project-form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "0.75rem" }}>
                <FormField label="Name">
                  <input value={projectName} onChange={(e) => handleProjectNameChange(e.target.value)} placeholder="My Project" required style={{ width: "100%", display: "block" }} />
                </FormField>
                <FormField label="Slug">
                  <input value={projectSlug} onChange={(e) => setProjectSlug(e.target.value)} placeholder="my-project" pattern="[a-z0-9-]+" required style={{ width: "100%", display: "block", fontFamily: "monospace" }} />
                </FormField>
              </div>
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

          {openTasks.length > 0 && (
            <Card style={{ marginBottom: "0.9rem" }} padding="sm">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <h2 style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>Open Tasks</h2>
                <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>{openTasks.length} total</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {openTasks.slice(0, 10).map((task) => (
                  <Link
                    key={task.id}
                    href={`/dashboard?teamId=${selectedTeam.id}&projectId=${task.projectId}&taskId=${task.id}`}
                    style={{ textDecoration: "none", color: "inherit" }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        padding: "0.4rem 0.5rem",
                        borderRadius: "var(--radius-base)",
                        transition: "background 0.12s ease",
                      }}
                      className="open-task-row"
                    >
                      <span
                        style={{
                          width: "7px",
                          height: "7px",
                          borderRadius: "50%",
                          background: task.status === "in_progress" ? "var(--primary)" : "var(--muted)",
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ flex: 1, fontSize: "var(--text-sm)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {task.title}
                      </span>
                      <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)", flexShrink: 0 }}>
                        {task.projectName}
                      </span>
                      <span
                        className="status-chip"
                        style={{
                          color: task.priority === "CRITICAL" ? "#be123c" : task.priority === "HIGH" ? "#ef4444" : task.priority === "MEDIUM" ? "#f59e0b" : "#6b7280",
                          fontSize: "var(--text-xs)",
                          flexShrink: 0,
                        }}
                      >
                        {task.priority}
                      </span>
                      <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)", flexShrink: 0 }}>
                        {formatRelativeTime(task.updatedAt)}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
              {openTasks.length > 10 && (
                <p style={{ textAlign: "right", marginTop: "0.4rem", color: "var(--muted)", fontSize: "var(--text-xs)" }}>
                  +{openTasks.length - 10} more tasks across your projects
                </p>
              )}
            </Card>
          )}

          <Card style={{ marginBottom: "0.9rem" }} padding="sm">
            <div className="teams-filter-bar">
              <input
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
              {filteredProjects.length} results
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
                    Create your first project →
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="projects-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "1rem" }}>
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
