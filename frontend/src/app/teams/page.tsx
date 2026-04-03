"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeams,
  getProjects,
  createProject,
  syncTeamFromGitHub,
  type User,
  type Team,
  type Project,
} from "../../lib/api";
import AppHeader from "../../components/AppHeader";

type ProjectSort = "name_asc" | "name_desc" | "newest" | "recent_sync";
const PROJECT_PAGE_SIZE = 9;

export default function TeamsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const [showNewProject, setShowNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projectQuery, setProjectQuery] = useState("");
  const [projectSort, setProjectSort] = useState<ProjectSort>("name_asc");
  const [githubOnly, setGithubOnly] = useState(false);
  const [projectPage, setProjectPage] = useState(1);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) {
        router.replace("/");
        return;
      }
      setUser(me);

      const userTeams = await getTeams();
      if (userTeams.length === 0) {
        router.replace("/onboarding");
        return;
      }

      setTeams(userTeams);
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
      setShowNewProject(false);
      setProjectName("");
      setProjectSlug("");
      setGithubRepo("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
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

      <div style={{ border: "1px solid var(--border)", background: "var(--surface)", borderRadius: "10px", padding: "0.75rem 0.9rem", marginBottom: "1rem", color: "var(--muted)", fontSize: "0.84rem" }}>
        Startpunkt: Team auswählen, danach Projekt öffnen. Ohne GitHub-Verbindung kannst du Projekte manuell anlegen, mit Verbindung kannst du synchronisieren.
      </div>

      {selectedTeam && (
        <>
          <div className="teams-header-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", gap: "0.75rem", flexWrap: "wrap" }}>
            <div>
              <h1 style={{ fontSize: "1.25rem", fontWeight: 700 }}>{selectedTeam.name}</h1>
              <p style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>{selectedTeam.projectCount ?? projects.length} projects</p>
            </div>
            <div className="teams-actions" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {teams.length > 1 && (
                <select
                  value={selectedTeam.id}
                  onChange={(e) => {
                    const next = teams.find((team) => team.id === e.target.value);
                    if (!next) return;
                    setSelectedTeam(next);
                    void loadProjects(next.id);
                  }}
                  style={{ minWidth: "200px" }}
                >
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name} ({team.projectCount ?? 0})
                    </option>
                  ))}
                </select>
              )}
              {!user?.githubConnected ? (
                <Link
                  href="/api/auth/github/connect"
                  style={{
                    background: "#0f172a",
                    color: "white",
                    borderRadius: "8px",
                    padding: "0.5rem 1rem",
                    fontWeight: 600,
                    fontSize: "0.875rem",
                    textDecoration: "none",
                  }}
                >
                  GitHub verbinden
                </Link>
              ) : (
                <button
                  onClick={() => {
                    void (async () => {
                      setSyncMessage(null);
                      setSyncing(true);
                      try {
                        const result = await syncTeamFromGitHub(selectedTeam.id);
                        await loadProjects(selectedTeam.id);
                        setSyncMessage(`GitHub-Sync fertig: ${result.created} erstellt, ${result.updated} aktualisiert.`);
                      } catch (err) {
                        setSyncMessage((err as Error).message);
                      } finally {
                        setSyncing(false);
                      }
                    })();
                  }}
                  disabled={syncing}
                  style={{
                    background: "#0f172a",
                    color: "white",
                    border: "none",
                    borderRadius: "8px",
                    padding: "0.5rem 1rem",
                    fontWeight: 600,
                    cursor: syncing ? "not-allowed" : "pointer",
                    fontSize: "0.875rem",
                    fontFamily: "inherit",
                  }}
                >
                  {syncing ? "Sync läuft…" : "Sync GitHub"}
                </button>
              )}
              <button
                onClick={() => setShowNewProject(true)}
                style={{ background: "var(--primary)", color: "white", border: "none", borderRadius: "8px", padding: "0.5rem 1.25rem", fontWeight: 600, cursor: "pointer", fontSize: "0.875rem", fontFamily: "inherit" }}
              >
                + New Project
              </button>
            </div>
          </div>

          {!user?.githubConnected && (
            <div
              style={{
                border: "1px solid var(--border)",
                background: "var(--surface)",
                borderRadius: "10px",
                padding: "0.75rem 0.875rem",
                marginBottom: "1rem",
                color: "var(--muted)",
                fontSize: "0.875rem",
              }}
            >
              GitHub ist noch nicht verbunden. Ohne Verbindung ist kein Sync möglich.
              {" "}
              <Link href="/settings" style={{ color: "var(--primary)", textDecoration: "none" }}>Jetzt verbinden</Link>
            </div>
          )}

          {syncMessage && (
            <div
              style={{
                border: "1px solid var(--border)",
                background: "var(--surface)",
                borderRadius: "10px",
                padding: "0.75rem 0.875rem",
                marginBottom: "1rem",
                color: "var(--muted)",
                fontSize: "0.875rem",
              }}
            >
              {syncMessage}
            </div>
          )}

          {showNewProject && (
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1.25rem", marginBottom: "1rem" }}>
              <h3 style={{ fontSize: "0.9375rem", fontWeight: 600, marginBottom: "1rem" }}>New Project</h3>
              <form onSubmit={(e) => void handleCreateProject(e)}>
                <div className="project-form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "0.75rem" }}>
                  <div>
                    <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>Name</label>
                    <input value={projectName} onChange={(e) => handleProjectNameChange(e.target.value)} placeholder="My Project" required style={{ width: "100%", display: "block" }} />
                  </div>
                  <div>
                    <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>Slug</label>
                    <input value={projectSlug} onChange={(e) => setProjectSlug(e.target.value)} placeholder="my-project" pattern="[a-z0-9-]+" required style={{ width: "100%", display: "block", fontFamily: "monospace" }} />
                  </div>
                </div>
                <div style={{ marginBottom: "0.75rem" }}>
                  <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>GitHub Repo (optional)</label>
                  <input value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} placeholder="owner/repo" style={{ width: "100%", display: "block" }} />
                </div>
                {error && <p style={{ color: "var(--danger)", fontSize: "0.8125rem", marginBottom: "0.75rem" }}>{error}</p>}
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button type="submit" disabled={creating} style={{ background: "var(--primary)", color: "white", border: "none", borderRadius: "6px", padding: "0.5rem 1rem", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{creating ? "Creating…" : "Create"}</button>
                  <button type="button" onClick={() => setShowNewProject(false)} style={{ background: "transparent", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: "6px", padding: "0.5rem 1rem", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                </div>
              </form>
            </div>
          )}

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "0.75rem", marginBottom: "0.9rem" }}>
            <div className="teams-filter-bar">
              <input
                value={projectQuery}
                onChange={(e) => setProjectQuery(e.target.value)}
                placeholder="Projekte suchen (Name, Slug, Repo)…"
                style={{ width: "100%" }}
              />
              <select
                value={projectSort}
                onChange={(e) => setProjectSort(e.target.value as ProjectSort)}
                style={{ width: "100%" }}
              >
                <option value="name_asc">Sort: Name A-Z</option>
                <option value="name_desc">Sort: Name Z-A</option>
                <option value="newest">Sort: Neueste zuerst</option>
                <option value="recent_sync">Sort: Kürzlich synchronisiert</option>
              </select>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", color: "var(--muted)", fontSize: "0.82rem", paddingLeft: "0.25rem" }}>
                <input
                  type="checkbox"
                  checked={githubOnly}
                  onChange={(e) => setGithubOnly(e.target.checked)}
                />
                Nur GitHub-Projekte
              </label>
            </div>
            <p style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
              {filteredProjects.length} Ergebnisse
            </p>
          </div>

          {projectsLoading ? (
            <p style={{ color: "var(--muted)" }}>Loading projects…</p>
          ) : filteredProjects.length === 0 ? (
            <div style={{ textAlign: "center", padding: "3rem", border: "1px dashed var(--border)", borderRadius: "10px", color: "var(--muted)" }}>
              <p style={{ marginBottom: "0.5rem" }}>{projects.length === 0 ? "No projects yet." : "Keine Projekte für diesen Filter."}</p>
              {projects.length === 0 && (
                <button onClick={() => setShowNewProject(true)} style={{ color: "var(--primary)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }}>Create your first project →</button>
              )}
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "1rem" }}>
                {pagedProjects.map((project) => (
                  <Link key={project.id} href={`/dashboard?teamId=${selectedTeam.id}&projectId=${project.id}`} style={{ textDecoration: "none", display: "block" }}>
                    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1.25rem", transition: "border-color 0.15s", cursor: "pointer" }}>
                      <h3 style={{ fontWeight: 600, marginBottom: "0.25rem", color: "var(--text)" }}>{project.name}</h3>
                      {project.githubRepo && <p style={{ color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.5rem" }}>⚡ {project.githubRepo}</p>}
                      {project.description && <p style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>{project.description}</p>}
                      <div style={{ marginTop: "0.7rem", color: "var(--primary)", fontSize: "0.82rem", fontWeight: 600 }}>
                        Board öffnen →
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
              {totalProjectPages > 1 && (
                <div className="teams-pagination">
                  <span>Seite {currentProjectPage} von {totalProjectPages}</span>
                  <div style={{ display: "flex", gap: "0.4rem" }}>
                    <button
                      type="button"
                      disabled={currentProjectPage <= 1}
                      onClick={() => setProjectPage((page) => Math.max(1, page - 1))}
                      style={{ border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: "6px", padding: "0.3rem 0.6rem", opacity: currentProjectPage <= 1 ? 0.5 : 1 }}
                    >
                      Zurück
                    </button>
                    <button
                      type="button"
                      disabled={currentProjectPage >= totalProjectPages}
                      onClick={() => setProjectPage((page) => Math.min(totalProjectPages, page + 1))}
                      style={{ border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: "6px", padding: "0.3rem 0.6rem", opacity: currentProjectPage >= totalProjectPages ? 0.5 : 1 }}
                    >
                      Weiter
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
