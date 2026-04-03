"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { logout } from "../lib/api";
import DropdownMenu from "./ui/DropdownMenu";

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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const isTeams = pathname.startsWith("/teams");
  const isDashboard = pathname.startsWith("/dashboard");

  return (
    <header
      className="app-header"
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
      <div className="app-header-nav" style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <Link href="/teams" style={{ fontWeight: 700, color: "var(--primary)", textDecoration: "none" }}>
          agent-tasks
        </Link>
        <Link href="/teams" style={{ color: isTeams ? "var(--text)" : "var(--muted)", fontSize: "0.85rem", textDecoration: "none" }}>
          Teams
        </Link>
        <Link href={boardHref} style={{ color: isDashboard ? "var(--text)" : "var(--muted)", fontSize: "0.85rem", textDecoration: "none" }}>
          Board
        </Link>
      </div>

      {user && (
        <div>
          <button
            ref={triggerRef}
            type="button"
            className="app-user-trigger"
            onClick={() => setMenuOpen((value) => !value)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--muted)",
              borderRadius: "8px",
              padding: "0.3rem 0.55rem",
            }}
          >
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt={user.login} style={{ width: "24px", height: "24px", borderRadius: "50%" }} />
            ) : (
              <span
                style={{
                  width: "24px",
                  height: "24px",
                  borderRadius: "999px",
                  background: "var(--border)",
                  color: "var(--text)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.75rem",
                  fontWeight: 700,
                }}
              >
                {user.login.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="app-user-name" style={{ color: "var(--text)", fontSize: "0.85rem" }}>{user.login}</span>
            <span style={{ color: "var(--muted)", fontSize: "0.7rem" }}>{menuOpen ? "▲" : "▼"}</span>
          </button>

          <DropdownMenu
            anchorRef={triggerRef}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            align="end"
            minWidth={190}
          >
            <div role="menu">
              <Link
                href="/settings"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                className="app-dropdown-item"
              >
                Settings
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void logout().then(() => {
                    router.replace("/");
                  });
                }}
                className="app-dropdown-item app-dropdown-item-danger"
              >
                Logout
              </button>
            </div>
          </DropdownMenu>
        </div>
      )}
    </header>
  );
}
