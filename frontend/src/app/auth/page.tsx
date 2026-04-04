"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getCurrentUser, getTeams, login, register } from "../../lib/api";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import FormField from "../../components/ui/FormField";
import Card from "../../components/ui/Card";

type Mode = "login" | "register";

export default function AuthPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "register") {
        await register({ email, password, name: name || undefined });
      } else {
        await login({ email, password });
      }
      const teams = await getTeams();
      router.replace(teams.length === 0 ? "/onboarding" : "/teams");
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  if (checkingSession) {
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
      <div style={{ width: "100%", maxWidth: "460px" }}>
        <Link href="/" style={{ display: "block", textAlign: "center", marginBottom: "var(--space-4)", color: "var(--muted)", fontSize: "var(--text-sm)", textDecoration: "none" }}>
          ← agent-tasks
        </Link>

        <div style={{ textAlign: "center", marginBottom: "var(--space-4)" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "var(--space-2)" }}>Sign in to agent-tasks</h1>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
            Use email/password or continue with GitHub.
          </p>
        </div>

        <Card style={{ marginBottom: "var(--space-4)" }}>
          <div className="auth-tab-bar" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
            <button
              className={`auth-tab${mode === "login" ? " auth-tab-active" : ""}`}
              onClick={() => setMode("login")}
              type="button"
            >
              Login
            </button>
            <button
              className={`auth-tab${mode === "register" ? " auth-tab-active" : ""}`}
              onClick={() => setMode("register")}
              type="button"
            >
              Register
            </button>
          </div>

          <form onSubmit={(event) => void handleSubmit(event)}>
            {mode === "register" && (
              <FormField label="Name (optional)">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Jane Doe"
                  style={{ width: "100%", display: "block" }}
                />
              </FormField>
            )}

            <FormField label="Email">
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                style={{ width: "100%", display: "block" }}
              />
            </FormField>

            <FormField label="Password">
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
                style={{ width: "100%", display: "block" }}
              />
            </FormField>

            {error && (
              <AlertBanner tone="danger" title="Error">
                {error}
              </AlertBanner>
            )}

            <Button type="submit" disabled={submitting} loading={submitting} style={{ width: "100%", marginTop: "var(--space-2)" }}>
              {mode === "register" ? "Create account" : "Sign in"}
            </Button>
          </form>
        </Card>

        <Card style={{ textAlign: "center" }}>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-3)" }}>
            Prefer GitHub auth?
          </p>
          <a
            href="/api/auth/github"
            className="btn-secondary"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "var(--space-2)",
              borderRadius: "var(--radius-lg)",
              padding: "0.625rem 1rem",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            Continue with GitHub
          </a>
        </Card>
      </div>
    </main>
  );
}
