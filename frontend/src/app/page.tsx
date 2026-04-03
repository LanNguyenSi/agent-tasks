"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getCurrentUser, getTeams } from "../lib/api";

export default function HomePage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (me) {
        const teams = await getTeams();
        router.replace(teams.length === 0 ? "/onboarding" : "/teams");
        return;
      }
      setCheckingSession(false);
    })();
  }, [router]);

  if (checkingSession) {
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      </main>
    );
  }

  return (
    <main className="landing-shell">
      <section className="landing-card">
        <p className="landing-eyebrow">agent-tasks</p>
        <h1 className="landing-title">Plan and ship work without workflow chaos.</h1>
        <p className="landing-copy">
          Keep every repository as a project, run a board and list for execution, and let humans plus agents
          collaborate with team-scoped API tokens.
        </p>

        <div className="landing-cta-row">
          <Link href="/auth" className="landing-cta-primary">
            Sign in with email
          </Link>
          <a href="/api/auth/github" className="landing-cta-secondary">
            Continue with GitHub
          </a>
        </div>

        <div className="landing-feature-grid">
          <article className="landing-feature">
            <h2>Project Sync</h2>
            <p>Connect GitHub and sync repositories directly into projects.</p>
          </article>
          <article className="landing-feature">
            <h2>Focused Boards</h2>
            <p>Each project gets a default board plus a list view with filters and pagination.</p>
          </article>
          <article className="landing-feature">
            <h2>Agent API</h2>
            <p>Generate team-scoped tokens and use Swagger docs to automate task operations.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
