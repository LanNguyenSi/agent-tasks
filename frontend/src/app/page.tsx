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
        router.replace(teams.length === 0 ? "/onboarding" : "/home");
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
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header className="landing-header">
        <span className="landing-logo">agent-tasks</span>
        <Link href="/auth" className="landing-header-link">Sign in</Link>
      </header>

      <main className="landing-shell" style={{ flex: 1 }}>
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
              <h2>Confidence Scoring</h2>
              <p>Every task gets a quality score - no AI, pure heuristics. Agents are blocked from claiming vague tasks. Humans get warnings, not blockers.</p>
            </article>
            <article className="landing-feature">
              <h2>Task Templates</h2>
              <p>Define structured fields per project. Ship reusable presets so your team writes complete specs in one click.</p>
            </article>
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
            <article className="landing-feature">
              <h2>Description Quality</h2>
              <p>Built-in bullshit meter: measures information density, structure, and concreteness. Not character count - actual signal.</p>
            </article>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <a href="https://github.com/LanNguyenSi/agent-tasks" target="_blank" rel="noopener noreferrer" className="landing-footer-link">
          GitHub
        </a>
        <span className="landing-footer-sep">/</span>
        <a href="/docs" className="landing-footer-link">API Docs</a>
        <span className="landing-footer-sep">/</span>
        <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>MIT License</span>
      </footer>
    </div>
  );
}
