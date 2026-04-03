"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { logout } from "../lib/api";

interface AppHeaderProps {
  user?: {
    login: string;
    avatarUrl?: string | null;
  } | null;
  boardHref?: string;
}

export default function AppHeader({ user, boardHref = "/dashboard" }: AppHeaderProps) {
  const pathname = usePathname();
  const router = useRouter();

  const isTeams = pathname.startsWith("/teams");
  const isSettings = pathname.startsWith("/settings");
  const isDashboard = pathname.startsWith("/dashboard");

  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "1rem",
        marginBottom: "1rem",
        borderBottom: "1px solid var(--border)",
        paddingBottom: "0.9rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <Link href="/teams" style={{ fontWeight: 700, color: "var(--primary)", textDecoration: "none" }}>
          agent-tasks
        </Link>
        <Link href="/teams" style={{ color: isTeams ? "var(--text)" : "var(--muted)", fontSize: "0.85rem", textDecoration: "none" }}>
          Teams
        </Link>
        <Link href={boardHref} style={{ color: isDashboard ? "var(--text)" : "var(--muted)", fontSize: "0.85rem", textDecoration: "none" }}>
          Board
        </Link>
        <Link href="/settings" style={{ color: isSettings ? "var(--text)" : "var(--muted)", fontSize: "0.85rem", textDecoration: "none" }}>
          Settings
        </Link>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
        {user?.avatarUrl && (
          <img src={user.avatarUrl} alt={user.login} style={{ width: "28px", height: "28px", borderRadius: "50%" }} />
        )}
        <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>{user?.login}</span>
        <button
          onClick={() => {
            void logout().then(() => {
              router.replace("/");
            });
          }}
          style={{
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--muted)",
            borderRadius: "6px",
            padding: "0.25rem 0.6rem",
          }}
        >
          Logout
        </button>
      </div>
    </header>
  );
}
