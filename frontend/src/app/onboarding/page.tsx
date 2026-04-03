"use client";

import { useState, useEffect } from "react";
import { getCurrentUser, getTeams, createTeam, type User, type Team } from "../../lib/api";

export default function OnboardingPage() {
  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<"loading" | "create-team" | "redirect">("loading");

  // Create team form
  const [teamName, setTeamName] = useState("");
  const [teamSlug, setTeamSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) {
        window.location.href = "/";
        return;
      }
      setUser(me);
      const existingTeams = await getTeams();
      setTeams(existingTeams);
      setLoading(false);

      if (existingTeams.length > 0) {
        // Already has teams — redirect to teams page
        setStep("redirect");
        window.location.href = "/teams";
      } else {
        setStep("create-team");
      }
    })();
  }, []);

  // Auto-generate slug from name
  function handleNameChange(name: string) {
    setTeamName(name);
    setTeamSlug(
      name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 50),
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!teamName.trim() || !teamSlug.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const team = await createTeam({ name: teamName.trim(), slug: teamSlug.trim() });
      window.location.href = '/teams';
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  }

  if (loading || step === "loading" || step === "redirect") {
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      <div style={{ maxWidth: "480px", width: "100%" }}>
        {user && (
          <div style={{ textAlign: "center", marginBottom: "2rem" }}>
            {user.avatarUrl && (
              <img
                src={user.avatarUrl}
                alt={user.login}
                style={{ width: "56px", height: "56px", borderRadius: "50%", marginBottom: "0.75rem" }}
              />
            )}
            <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}>
              Welcome, {user.name ?? user.login}!
            </h1>
            <p style={{ color: "var(--muted)" }}>Create your first team to get started.</p>
          </div>
        )}

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "12px",
            padding: "1.5rem",
          }}
        >
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "1.25rem" }}>Create a team</h2>

          <form onSubmit={(e) => void handleCreate(e)}>
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", color: "var(--muted)", fontSize: "0.8125rem", marginBottom: "0.375rem" }}>
                Team name
              </label>
              <input
                type="text"
                value={teamName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="My Team"
                required
                style={{ width: "100%", display: "block" }}
              />
            </div>

            <div style={{ marginBottom: "1.25rem" }}>
              <label style={{ display: "block", color: "var(--muted)", fontSize: "0.8125rem", marginBottom: "0.375rem" }}>
                Slug
              </label>
              <input
                type="text"
                value={teamSlug}
                onChange={(e) => setTeamSlug(e.target.value)}
                placeholder="my-team"
                pattern="[a-z0-9-]+"
                required
                style={{ width: "100%", display: "block", fontFamily: "monospace" }}
              />
              <p style={{ color: "var(--muted)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
                Used in URLs. Lowercase, hyphens only.
              </p>
            </div>

            {error && (
              <div
                style={{
                  background: "#2a1a1a",
                  border: "1px solid var(--danger)",
                  borderRadius: "6px",
                  padding: "0.625rem 0.75rem",
                  color: "var(--danger)",
                  fontSize: "0.875rem",
                  marginBottom: "1rem",
                }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={creating || !teamName || !teamSlug}
              style={{
                width: "100%",
                background: "var(--primary)",
                color: "white",
                border: "none",
                borderRadius: "8px",
                padding: "0.75rem",
                fontWeight: 600,
                fontSize: "0.9375rem",
                cursor: creating || !teamName || !teamSlug ? "not-allowed" : "pointer",
                opacity: creating || !teamName || !teamSlug ? 0.7 : 1,
                fontFamily: "inherit",
              }}
            >
              {creating ? "Creating…" : "Create Team"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
