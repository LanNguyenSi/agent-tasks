"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { logout } from "../lib/api";
import DropdownMenu from "./ui/DropdownMenu";
import { Icon } from "./ui/Icon";

interface AppHeaderProps {
  user?: {
    login: string;
    avatarUrl?: string | null;
  } | null;
}

export default function AppHeader({ user }: AppHeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const isHome = pathname.startsWith("/home");
  const isDashboard = pathname.startsWith("/dashboard");
  const isTasks = pathname.startsWith("/tasks");
  const isTeams = pathname.startsWith("/teams");
  const isSettings = pathname.startsWith("/settings");

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/home" className="app-brand">
          <Icon name="board" size={15} />
          agent-tasks
        </Link>

        <nav className="app-nav-links" aria-label="Main">
          <Link
            href="/home"
            className="app-nav-link"
            aria-current={isHome ? "page" : undefined}
          >
            Home
          </Link>
          <Link
            href="/dashboard"
            className="app-nav-link"
            aria-current={isDashboard ? "page" : undefined}
          >
            Dashboard
          </Link>
          <Link
            href="/tasks"
            className="app-nav-link"
            aria-current={isTasks ? "page" : undefined}
          >
            Tasks
          </Link>
          <Link
            href="/teams"
            className="app-nav-link"
            aria-current={isTeams ? "page" : undefined}
          >
            Teams
          </Link>
          <Link
            href="/settings"
            className="app-nav-link"
            aria-current={isSettings ? "page" : undefined}
          >
            Settings
          </Link>
        </nav>

        <div className="app-nav-spacer" />

        {user && (
          <>
            <button
              ref={triggerRef}
              type="button"
              className="app-user-trigger"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Account menu for ${user.login}`}
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.login}
                  className="app-avatar"
                />
              ) : (
                <span className="app-avatar">
                  {user.login.slice(0, 2).toUpperCase()}
                </span>
              )}
              <span className="app-user-name">{user.login}</span>
              <Icon name="chevron-down" size={12} />
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
          </>
        )}
      </div>
    </header>
  );
}
