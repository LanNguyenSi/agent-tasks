"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getCurrentUser, getTeams, createTeam, logout, type User } from "../../lib/api";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import FormField from "../../components/ui/FormField";
import { FullPageLoader } from "../../components/ui/FullPageLoader";
import { AuthShell } from "../../components/AuthShell";

export default function OnboardingPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<"loading" | "create-team" | "redirect">("loading");

  // Create team form
  const [teamName, setTeamName] = useState("");
  const [teamSlug, setTeamSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
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
        // Already has teams, send them straight to home.
        setStep("redirect");
        router.replace("/home");
      } else {
        setStep("create-team");
      }
    })();
  }, [router]);

  // Auto-generate slug from name.
  function handleNameChange(name: string) {
    setTeamName(name);
    // Don't clobber a slug the user has hand-edited.
    if (!slugTouched) {
      setTeamSlug(
        name
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 50),
      );
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!teamName.trim() || !teamSlug.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createTeam({ name: teamName.trim(), slug: teamSlug.trim() });
      router.replace("/home");
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  }

  if (loading || step === "loading" || step === "redirect") {
    return <FullPageLoader label="Loading..." />;
  }

  return (
    <AuthShell
      heading="Create your first team"
      subtitle="You will be up and running in under a minute."
    >
      {/* Sign-out link: ghost Button aligned to the right, above the card */}
      <div className="auth-signout-row">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            void logout().then(() => router.replace("/"));
          }}
        >
          Sign out
        </Button>
      </div>

      <div className="auth-form-grid">
        {user && (
          <div className="auth-welcome-header">
            {user.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- external avatar URL, not a static asset
              <img
                src={user.avatarUrl}
                alt={user.login}
                className="auth-avatar"
              />
            )}
            <p className="auth-welcome-name">
              Welcome, {user.name ?? user.login}!
            </p>
            <p className="auth-welcome-sub">
              Create a team to get started.
            </p>
          </div>
        )}

        <form onSubmit={(e) => void handleCreate(e)} className="auth-form-grid">
          <FormField label="Team name">
            <input
              type="text"
              autoComplete="organization"
              value={teamName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="My Team"
              required
            />
          </FormField>

          <FormField
            label="Slug"
            hint={
              "Used in URLs. Lowercase, hyphens only." +
              (!slugTouched ? " Auto-generated from the name." : "")
            }
          >
            <input
              type="text"
              autoComplete="off"
              value={teamSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setTeamSlug(e.target.value);
              }}
              placeholder="my-team"
              pattern="[a-z0-9-]+"
              required
              className="auth-slug-input"
            />
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
            className="auth-btn-full"
          >
            Create Team
          </Button>
        </form>

        <p className="auth-muted-line">
          Joining an existing team? Ask a teammate for an invite link instead.
        </p>
      </div>
    </AuthShell>
  );
}
