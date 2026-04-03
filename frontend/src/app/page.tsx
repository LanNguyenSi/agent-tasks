export default function HomePage() {
  return (
    <main style={{ padding: "4rem", maxWidth: "800px", margin: "0 auto" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "1rem" }}>agent-tasks</h1>
      <p style={{ color: "var(--muted)", marginBottom: "2rem" }}>
        Collaborative task platform for humans and agents.
      </p>
      <div style={{ display: "flex", gap: "1rem" }}>
        <a
          href="/api/auth/github"
          style={{
            background: "var(--primary)",
            color: "white",
            padding: "0.75rem 1.5rem",
            borderRadius: "0.5rem",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Login with GitHub
        </a>
        <a
          href="/dashboard"
          style={{
            border: "1px solid var(--border)",
            padding: "0.75rem 1.5rem",
            borderRadius: "0.5rem",
            textDecoration: "none",
          }}
        >
          Dashboard →
        </a>
      </div>
    </main>
  );
}
