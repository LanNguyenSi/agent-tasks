// AuthShell: centered full-viewport shell for auth, onboarding, invite, and error pages.
// All geometry in .auth-shell-* classes in globals.css (Auth v2 section).
// Brand mark is inlined from src/app/icon.svg so no /public copy is needed.

"use client";

import Link from "next/link";
import type { ReactNode } from "react";

interface AuthShellProps {
  heading: string;
  subtitle?: string;
  children: ReactNode;
}

// Inline brand mark from src/app/icon.svg.
// The gradient id is namespaced (at-brand-g) to avoid collisions when multiple
// SVGs appear on the same page.
function BrandMark() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      role="img"
      aria-label="agent-tasks"
      className="auth-shell-logo"
    >
      <defs>
        <linearGradient id="at-brand-g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0ea5e9" />
          <stop offset="100%" stopColor="#3ba55c" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="14" fill="#111827" />
      <path d="M16 22h32v6H16zM16 30h22v6H16zM16 38h18v6H16z" fill="url(#at-brand-g)" />
      <circle cx="45" cy="41" r="7" fill="#f59e0b" />
    </svg>
  );
}

export function AuthShell({ heading, subtitle, children }: AuthShellProps) {
  return (
    <main className="auth-shell">
      <div className="auth-shell-inner">
        <header className="auth-shell-brand">
          <Link href="/" className="auth-shell-home-link" aria-label="Back to home">
            <BrandMark />
          </Link>
          <h1 className="auth-shell-heading">{heading}</h1>
          {subtitle && <p className="auth-shell-subtitle">{subtitle}</p>}
        </header>
        <div className="auth-shell-card">{children}</div>
      </div>
    </main>
  );
}
