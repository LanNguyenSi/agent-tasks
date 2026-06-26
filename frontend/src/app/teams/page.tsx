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
import { formatAbsoluteDate, formatRelativeTime } from "../../lib/time";
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
import { SkeletonList } from "../../components/ui/Skeleton";
import { Table, type ColumnDef } from "../../components/ui/Table";

type ProjectSortColumn = "name" | "repo" | "activeTasks" | "createdAt" | "syncedAt";
const PROJECT_PAGE_SIZE = 25;

function ProjectRowActions({
  project,
  onDelete,
}: {
  project: Project;
  onDelete?: () => void;
}) {
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <button
        ref={menuBtnRef}
        className="project-row-actions-btn"
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
      <DropdownMenu
        anchorRef={menuBtnRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        minWidth={160}
      >
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
    </>
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
  const [githubOnly, setGithubOnly] = useState(false);
  const [projectPage, setProjectPage] = useState(1);
  const [sortColumn, setSortColumn] = useState<ProjectSortColumn>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

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

  // Controlled sort callback: flips direction if same column, else applies natural
  // first-click direction (ascending for name/repo, descending for counts and dates).
  function handleSortChange(key: string): void {
    const col = key as ProjectSortColumn;
    const naturalAsc: ProjectSortColumn[] = ["name", "repo"];
    if (col === sortColumn) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(col);
      setSortDirection(naturalAsc.includes(col) ? "asc" : "desc");
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

    const comparators: Record<ProjectSortColumn, (a: Project, b: Project) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      repo: (a, b) => (a.githubRepo ?? "").localeCompare(b.githubRepo ?? ""),
      activeTasks: (a, b) => (taskCounts[a.id] ?? 0) - (taskCounts[b.id] ?? 0),
      createdAt: (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      syncedAt: (a, b) =>
        new Date(a.githubSyncAt ?? 0).getTime() - new Date(b.githubSyncAt ?? 0).getTime(),
    };

    const cmp = comparators[sortColumn];
    return [...filtered].sort((a, b) => (sortDirection === "asc" ? cmp(a, b) : -cmp(a, b)));
  }, [projects, projectQuery, githubOnly, sortColumn, sortDirection, taskCounts]);

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
  }, [selectedTeam?.id, projectQuery, sortColumn, sortDirection, githubOnly]);

  // Columns are built inside the component so render closures can close over
  // taskCounts and setDeleteTarget (component state, not module-level constants).
  const columns = useMemo<ColumnDef<Project>[]>(
    () => [
      {
        key: "name",
        header: "Name",
        sortable: true,
        width: "30%",
        render: (project) => (
          <span className="tasks-row-title">{project.name}</span>
        ),
      },
      {
        key: "repo",
        header: "Repo",
        sortable: true,
        width: "24%",
        render: (project) => (
          <span
            className="table-cell-secondary"
            // eslint-disable-next-line no-restricted-syntax
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {project.githubRepo ?? "Manual project"}
          </span>
        ),
      },
      {
        key: "activeTasks",
        header: "Active tasks",
        sortable: true,
        align: "right",
        width: "12%",
        render: (project) => {
          const count = taskCounts[project.id];
          return (
            <span className="table-cell-secondary num">
              {count !== undefined ? count : "—"}
            </span>
          );
        },
      },
      {
        key: "createdAt",
        header: "Created",
        sortable: true,
        width: "13%",
        render: (project) => (
          <span
            className="table-cell-secondary num"
            title={formatAbsoluteDate(project.createdAt)}
          >
            {formatRelativeTime(project.createdAt)}
          </span>
        ),
      },
      {
        key: "syncedAt",
        header: "Synced",
        sortable: true,
        width: "13%",
        render: (project) =>
          project.githubSyncAt ? (
            <span
              className="table-cell-secondary num"
              title={formatAbsoluteDate(project.githubSyncAt)}
            >
              {formatRelativeTime(project.githubSyncAt)}
            </span>
          ) : (
            <span className="table-cell-secondary">—</span>
          ),
      },
      {
        key: "actions",
        header: "Actions",
        sortable: false,
        align: "right",
        width: "8%",
        render: (project) => (
          <ProjectRowActions
            project={project}
            onDelete={
              !project.githubRepo
                ? () => setDeleteTarget({ id: project.id, name: project.name })
                : undefined
            }
          />
        ),
      },
    ],
    [taskCounts, setDeleteTarget],
  );

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
            <SkeletonList rows={10} rowHeight="3rem" label="Loading projects" />
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
              <Table
                columns={columns}
                rows={pagedProjects}
                rowKey={(project) => project.id}
                rowHref={
                  selectedTeam
                    ? (project) =>
                        `/dashboard?teamId=${selectedTeam.id}&projectId=${project.id}`
                    : undefined
                }
                sortKey={sortColumn}
                sortDirection={sortDirection === "asc" ? "ascending" : "descending"}
                onSortChange={handleSortChange}
                emptyLabel="No projects match the current filters."
                compactSort={
                  <select
                    className="table-sort-native"
                    aria-label="Sort by"
                    value={`${sortColumn}:${sortDirection}`}
                    onChange={(e) => {
                      const [col, dir] = e.target.value.split(":");
                      setSortColumn(col as ProjectSortColumn);
                      setSortDirection(dir as "asc" | "desc");
                    }}
                  >
                    <optgroup label="Name">
                      <option value="name:asc">Name: A to Z</option>
                      <option value="name:desc">Name: Z to A</option>
                    </optgroup>
                    <optgroup label="Repo">
                      <option value="repo:asc">Repo: A to Z</option>
                      <option value="repo:desc">Repo: Z to A</option>
                    </optgroup>
                    <optgroup label="Active tasks">
                      <option value="activeTasks:asc">Active tasks: Low to High</option>
                      <option value="activeTasks:desc">Active tasks: High to Low</option>
                    </optgroup>
                    <optgroup label="Created">
                      <option value="createdAt:asc">Created: Oldest first</option>
                      <option value="createdAt:desc">Created: Newest first</option>
                    </optgroup>
                    <optgroup label="Synced">
                      <option value="syncedAt:asc">Synced: Oldest first</option>
                      <option value="syncedAt:desc">Synced: Newest first</option>
                    </optgroup>
                  </select>
                }
              />
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
