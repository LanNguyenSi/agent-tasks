import Link from "next/link";
import ThemeCorner from "../../../components/ThemeCorner";

export default function AuthErrorPage() {
  return (
    <>
    <ThemeCorner />
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      <Link href="/" style={{ display: "block", textAlign: "center", marginBottom: "var(--space-4)", color: "var(--muted)", fontSize: "var(--text-sm)", textDecoration: "none" }}>
        ← agent-tasks
      </Link>
      <div style={{ textAlign: "center", maxWidth: "400px" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "var(--space-4)", color: "var(--danger)" }}>
          Authentication Failed
        </h1>
        <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-6, 1.5rem)" }}>
          Something went wrong during GitHub login. Please try again.
        </p>
        <a
          href="/auth"
          className="btn-primary"
          style={{
            display: "inline-block",
            padding: "0.75rem 1.5rem",
            borderRadius: "var(--radius-lg)",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Try Again
        </a>
      </div>
    </main>
    </>
  );
}
