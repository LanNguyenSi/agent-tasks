"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getCurrentUser, getTeams, createTeam, type User } from "../../lib/api";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import FormField from "../../components/ui/FormField";
import ThemeCorner from "../../components/ThemeCorner";

export default function OnboardingPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
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
        router.replace("/auth");
        return;
      }
      setUser(me);
      const existingTeams = await getTeams();
      setLoading(false);

      if (existingTeams.length > 0) {
        // Already has teams — redirect to teams page
        setStep("redirect");
        router.replace("/teams");
      } else {
        setStep("create-team");
      }
    })();
  }, [router]);

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
      await createTeam({ name: teamName.trim(), slug: teamSlug.trim() });
      router.replace("/teams");
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  }

  if (loading || step === "loading" || step === "redirect") {
    return (
      <>
        <ThemeCorner />
        <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <p style={{ color: "var(--muted)" }}>Loading…</p>
        </main>
      </>
    );
  }

  return (
    <>
    <ThemeCorner />
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <Link href="/" style={{ color: "var(--muted)", fontSize: "var(--text-sm)", textDecoration: "none" }}>
            ← agent-tasks
          </Link>
          <a href="/api/auth/logout" style={{ color: "var(--muted)", fontSize: "var(--text-sm)", textDecoration: "none" }}>
            Sign out
          </a>
        </div>

        {user && (
          <div style={{ textAlign: "center", marginBottom: "var(--space-6, 1.5rem)" }}>
            {user.avatarUrl && (
              <img
                src={user.avatarUrl}
                alt={user.login}
                style={{ width: "56px", height: "56px", borderRadius: "50%", marginBottom: "var(--space-3)" }}
              />
            )}
            <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "var(--space-1)" }}>
              Welcome, {user.name ?? user.login}!
            </h1>
            <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>Create your first team to get started.</p>
          </div>
        )}

        <Card>
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 600, marginBottom: "var(--space-4)" }}>Create a team</h2>

          <form onSubmit={(e) => void handleCreate(e)}>
            <FormField label="Team name">
              <input
                type="text"
                value={teamName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="My Team"
                required
                style={{ width: "100%", display: "block" }}
              />
            </FormField>

            <FormField label="Slug">
              <input
                type="text"
                value={teamSlug}
                onChange={(e) => setTeamSlug(e.target.value)}
                placeholder="my-team"
                pattern="[a-z0-9-]+"
                required
                style={{ width: "100%", display: "block", fontFamily: "monospace" }}
              />
              <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
                Used in URLs. Lowercase, hyphens only.
              </p>
            </FormField>

            {error && (
              <AlertBanner tone="danger" title="Failed to create team">
                {error}
              </AlertBanner>
            )}

            <Button
              type="submit"
              disabled={creating || !teamName || !teamSlug}
              loading={creating}
              style={{ width: "100%" }}
            >
              Create Team
            </Button>
          </form>
        </Card>
      </div>
    </main>
    </>
  );
}
