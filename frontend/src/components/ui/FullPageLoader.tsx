"use client";

// Full-page loading state. All geometry in .full-page-loader-* classes in globals.css.
// Replaces the assorted bare "Loading…" paragraphs that diverged per page.

import { SkeletonList } from "./Skeleton";

interface FullPageLoaderProps {
  /** Announced to assistive tech and shown beneath the centered spinner. */
  label?: string;
  /**
   * "centered", a spinner vertically centered in the viewport, for whole-page
   * bootstraps that have no content shell yet (settings, teams, auth gate).
   * "shell", skeleton rows inside the standard `.page-shell` width, so the
   * placeholder occupies the same column the loaded content will and the
   * layout does not jump on first paint.
   */
  variant?: "centered" | "shell";
  /** Shell variant only: number of skeleton rows. */
  rows?: number;
}

/**
 * The single full-page loading state for the app. Replaces the assorted bare
 * "Loading…" paragraphs that diverged per page. Both variants expose a
 * `role="status"` region so screen readers announce loading once.
 */
export function FullPageLoader({
  label = "Loading…",
  variant = "centered",
  rows = 5,
}: FullPageLoaderProps) {
  if (variant === "shell") {
    return (
      <main className="page-shell">
        <SkeletonList rows={rows} rowHeight="4rem" label={label} />
      </main>
    );
  }

  return (
    <main
      role="status"
      aria-busy="true"
      className="full-page-loader"
    >
      <span className="spinner" aria-hidden="true" />
      <span className="full-page-loader-label">{label}</span>
    </main>
  );
}
