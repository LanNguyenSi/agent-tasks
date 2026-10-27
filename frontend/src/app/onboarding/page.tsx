"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getCurrentUser, logout, type User } from "../../lib/api";
import { getAccessContext } from "../../lib/access";
import { Button } from "../../components/ui/Button";
import { FullPageLoader } from "../../components/ui/FullPageLoader";
import { AuthShell } from "../../components/AuthShell";
import CreateTeamForm from "../../components/CreateTeamForm";

export default function OnboardingPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<"loading" | "create-team" | "redirect">("loading");
  // A team-less user who already has shared projects may skip team creation.
  const [canSkip, setCanSkip] = useState(false);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) {
        router.replace("/auth");
        return;
      }
      setUser(me);
      const ctx = await getAccessContext();
      setLoading(false);

      if (ctx.teams.length > 0) {
        // Already has teams, send them straight to home. Only this branch
        // redirects: a user without teams stays here (the form, plus a skip
        // link when they have shared projects), so /home <-> /onboarding
        // cannot loop.
        setStep("redirect");
        router.replace("/home");
      } else {
        setCanSkip(ctx.sharedProjects.length > 0);
        setStep("create-team");
      }
    })();
  }, [router]);

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

        <CreateTeamForm />

        {canSkip && (
          <p className="auth-muted-line">
            <Link href="/home">Skip for now</Link>
            {" "}(you can create a team later from Home).
          </p>
        )}

        <p className="auth-muted-line">
          Joining an existing team? Ask a teammate for an invite link instead.
        </p>
      </div>
    </AuthShell>
  );
}
