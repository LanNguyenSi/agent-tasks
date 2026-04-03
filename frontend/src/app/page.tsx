"use client";

import { useState } from "react";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getCurrentUser, getTeams, login, register } from "../lib/api";
import AlertBanner from "../components/ui/AlertBanner";

type Mode = "login" | "register";

export default function HomePage() {
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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
        background:
          "radial-gradient(circle at 10% 10%, rgba(56, 189, 248, 0.16), transparent 40%), radial-gradient(circle at 90% 20%, rgba(16, 185, 129, 0.12), transparent 40%), var(--bg)",
      }}
    >
      <div style={{ width: "100%", maxWidth: "460px" }}>
        <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
          <h1 style={{ fontSize: "2rem", fontWeight: 700, marginBottom: "0.5rem" }}>agent-tasks</h1>
          <p style={{ color: "var(--muted)" }}>
            Register and sign in with email/password. GitHub connection is optional in settings.
          </p>
        </div>

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "12px",
            padding: "1.25rem",
            marginBottom: "1rem",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "1rem" }}>
            <button
              onClick={() => setMode("login")}
              type="button"
              style={{
                border: "1px solid var(--border)",
                background: mode === "login" ? "var(--border)" : "transparent",
                color: "var(--text)",
                borderRadius: "8px",
                padding: "0.5rem",
                cursor: "pointer",
                fontFamily: "inherit",
                fontWeight: 600,
              }}
            >
              Login
            </button>
            <button
              onClick={() => setMode("register")}
              type="button"
              style={{
                border: "1px solid var(--border)",
                background: mode === "register" ? "var(--border)" : "transparent",
                color: "var(--text)",
                borderRadius: "8px",
                padding: "0.5rem",
                cursor: "pointer",
                fontFamily: "inherit",
                fontWeight: 600,
              }}
            >
              Register
            </button>
          </div>

          <form onSubmit={(e) => void handleSubmit(e)}>
            {mode === "register" && (
              <div style={{ marginBottom: "0.75rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted)", marginBottom: "0.25rem" }}>
                  Name (optional)
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                  style={{ width: "100%", display: "block" }}
                />
              </div>
            )}

            <div style={{ marginBottom: "0.75rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted)", marginBottom: "0.25rem" }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                style={{ width: "100%", display: "block" }}
              />
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted)", marginBottom: "0.25rem" }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
                style={{ width: "100%", display: "block" }}
              />
            </div>

            {error && (
              <AlertBanner tone="danger" title="Error">
                {error}
              </AlertBanner>
            )}

            <button
              type="submit"
              disabled={submitting}
              style={{
                width: "100%",
                border: "none",
                borderRadius: "8px",
                padding: "0.75rem",
                background: "var(--primary)",
                color: "white",
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? "Please wait…" : mode === "register" ? "Create account" : "Sign in"}
            </button>
          </form>
        </div>

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "12px",
            padding: "1rem",
            textAlign: "center",
          }}
        >
          <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginBottom: "0.625rem" }}>
            Or continue directly with GitHub.
          </p>
          <a
            href="/api/auth/github"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.5rem",
              borderRadius: "8px",
              padding: "0.625rem 1rem",
              background: "#0f172a",
              color: "white",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            Continue with GitHub
          </a>
        </div>
      </div>
    </main>
  );
}
