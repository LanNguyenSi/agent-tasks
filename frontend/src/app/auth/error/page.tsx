export default function AuthErrorPage() {
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
      <div style={{ textAlign: "center", maxWidth: "400px" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem", color: "var(--danger)" }}>
          Authentication Failed
        </h1>
        <p style={{ color: "var(--muted)", marginBottom: "1.5rem" }}>
          Something went wrong during GitHub login. Please try again.
        </p>
        <a
          href="/"
          style={{
            background: "var(--primary)",
            color: "white",
            padding: "0.75rem 1.5rem",
            borderRadius: "8px",
            fontWeight: 600,
            display: "inline-block",
          }}
        >
          Try Again
        </a>
      </div>
    </main>
  );
}
