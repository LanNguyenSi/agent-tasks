"use client";

import ThemeToggle from "./ThemeToggle";

/**
 * Fixed-position ThemeToggle for pages without AppHeader/landing-header
 * (auth, onboarding, deep settings pages). Keeps the toggle reachable
 * everywhere the main nav isn't rendered.
 */
export default function ThemeCorner() {
  return (
    <div
      style={{
        position: "fixed",
        top: "1rem",
        right: "1rem",
        zIndex: 40,
      }}
    >
      <ThemeToggle />
    </div>
  );
}
