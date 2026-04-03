"use client";

import { useEffect, useState } from "react";
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

  // New project form
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) { router.replace("/"); return; }
      setUser(me);

      const t = await getTeams();
      if (t.length === 0) { router.replace("/onboarding"); return; }

      setTeams(t);
      const first = t[0]!;
      setSelectedTeam(first);
      setLoading(false);

      setProjectsLoading(true);
      const p = await getProjects(first.id);
      setProjects(p);
      setProjectsLoading(false);
    })();
  }, [router]);

  async function loadProjects(teamId: string) {
    setProjectsLoading(true);
    try {
      const p = await getProjects(teamId);
      setProjects(p);
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
      const p = await createProject({
        teamId: selectedTeam.id,
        name: projectName.trim(),
        slug: projectSlug.trim(),
        githubRepo: githubRepo.trim() || undefined,
      });
      setProjects((prev) => [...prev, p]);
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

  if (loading) {
    return <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}><p style={{ color: "var(--muted)" }}>Loading…</p></main>;
  }

  return (
    <main style={{ padding: "1.25rem", maxWidth: "1200px", margin: "0 auto", minHeight: "100vh" }}>
      <AppHeader
        user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null}
        boardHref={selectedTeam && projects[0] ? `/dashboard?teamId=${selectedTeam.id}&projectId=${projects[0].id}` : "/dashboard"}
      />

      <div style={{ border: "1px solid var(--border)", background: "var(--surface)", borderRadius: "10px", padding: "0.75rem 0.9rem", marginBottom: "1rem", color: "var(--muted)", fontSize: "0.84rem" }}>
        Startpunkt: Team auswählen, danach Projekt öffnen. Ohne GitHub-Verbindung kannst du Projekte manuell anlegen, mit Verbindung kannst du synchronisieren.
      </div>

      <div className="teams-layout" style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: "1.5rem" }}>
        {/* Sidebar */}
        <aside>
          <p style={{ color: "var(--muted)", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.5rem" }}>Teams</p>
          {teams.map((team) => (
            <button
              key={team.id}
              onClick={() => {
                setSelectedTeam(team);
                void loadProjects(team.id);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: selectedTeam?.id === team.id ? "var(--border)" : "transparent",
                border: "none",
                borderRadius: "6px",
                padding: "0.5rem 0.75rem",
                color: "var(--text)",
                cursor: "pointer",
                fontSize: "0.875rem",
                fontWeight: selectedTeam?.id === team.id ? 600 : 400,
                marginBottom: "0.25rem",
              }}
            >
              {team.name}
            </button>
          ))}
        </aside>

        {/* Main */}
        <div>
          {selectedTeam && (
            <>
              <div className="teams-header-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem", gap: "0.75rem" }}>
                <div>
                  <h1 style={{ fontSize: "1.25rem", fontWeight: 700 }}>{selectedTeam.name}</h1>
                  <p style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>{selectedTeam.projectCount ?? projects.length} projects</p>
                </div>
                <div className="teams-actions" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
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
                        if (!selectedTeam) return;
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
                <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1.25rem", marginBottom: "1.25rem" }}>
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

              {projectsLoading ? (
                <p style={{ color: "var(--muted)" }}>Loading projects…</p>
              ) : projects.length === 0 ? (
                <div style={{ textAlign: "center", padding: "3rem", border: "1px dashed var(--border)", borderRadius: "10px", color: "var(--muted)" }}>
                  <p style={{ marginBottom: "0.5rem" }}>No projects yet.</p>
                  <button onClick={() => setShowNewProject(true)} style={{ color: "var(--primary)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }}>Create your first project →</button>
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "1rem" }}>
                  {projects.map((project) => (
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
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
