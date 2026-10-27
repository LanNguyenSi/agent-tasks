"use client";

// Full-page loading state. All geometry in .full-page-loader-* classes in globals.css.
// Replaces the assorted bare "Loading…" paragraphs that diverged per page.

import { PageShell } from "./PageShell";
import { Skeleton, SkeletonList } from "./Skeleton";

interface FullPageLoaderProps {
  /** Announced to assistive tech and shown beneath the centered spinner. */
  label?: string;
  /**
   * "centered", a spinner vertically centered in the viewport, for whole-page
   * bootstraps that have no content shell yet (settings, teams, auth gate).
   * "shell", a PageShell on the default column with a skeleton header band
   * (the PageHeader geometry) and skeleton rows in the content slot, so the
   * placeholder occupies the same band and column the loaded content will
   * and the layout does not jump on first paint.
   */
  variant?: "centered" | "shell";
  /** Shell variant only: number of skeleton rows. */
  rows?: number;
  /**
   * Shell variant only: number of skeleton buttons in the band's actions
   * slot. Pass the count the loaded page shows so the band has the same
   * height in both states (at narrow widths the actions wrap below the
   * title and add a row).
   */
  headerActions?: number;
}

/** Widths of the skeleton action buttons, the common button widths. */
const ACTION_SKELETON_WIDTHS = ["8rem", "8.5rem"];

/**
 * The single full-page loading state for the app. Replaces the assorted bare
 * "Loading…" paragraphs that diverged per page. Both variants expose a
 * `role="status"` region so screen readers announce loading once.
 */
export function FullPageLoader({
  label = "Loading…",
  variant = "centered",
  rows = 5,
  headerActions = 0,
}: FullPageLoaderProps) {
  if (variant === "shell") {
    return (
      <PageShell
        busy
        header={
          <div className="page-header" aria-hidden="true">
            <div className="page-header-left">
              <Skeleton width="160px" height="24px" />
            </div>
            {headerActions > 0 && (
              <div className="page-header-actions">
                {Array.from({ length: headerActions }, (_, i) => (
                  <Skeleton
                    key={i}
                    width={ACTION_SKELETON_WIDTHS[i % ACTION_SKELETON_WIDTHS.length]}
                    height="32px"
                  />
                ))}
              </div>
            )}
          </div>
        }
      >
        <SkeletonList rows={rows} rowHeight="4rem" label={label} />
      </PageShell>
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
