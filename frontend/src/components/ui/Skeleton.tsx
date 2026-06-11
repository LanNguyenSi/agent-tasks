"use client";

// Shimmer placeholder blocks.
// The .skeleton class carries the animation; .skeleton-list carries the flex
// column layout. Width, height, and border-radius are kept as inline styles
// because they are dynamic prop values (not static geometry).

import type { CSSProperties } from "react";

interface SkeletonProps {
  /** CSS width (default fills its container). */
  width?: string | number;
  /** CSS height (default one line of text). */
  height?: string | number;
  /** CSS border-radius (default the small token). */
  radius?: string | number;
  style?: CSSProperties;
}

/**
 * A single shimmering placeholder block. Decorative — marked
 * `aria-hidden` so screen readers announce the surrounding
 * `aria-busy` container's loading state instead of empty boxes.
 */
export function Skeleton({
  width = "100%",
  height = "1rem",
  radius = "var(--radius-sm)",
  style,
}: SkeletonProps) {
  return (
    <div
      className="skeleton"
      aria-hidden="true"
      // eslint-disable-next-line no-restricted-syntax
      style={{
        /* dynamic: width/height/radius are component props */
        width,
        height,
        borderRadius: radius,
        ...style,
      }}
    />
  );
}

interface SkeletonListProps {
  /** Number of placeholder rows. */
  rows?: number;
  /** Height of each row. */
  rowHeight?: string | number;
  /** Accessible label announced to screen readers while loading. */
  label?: string;
  /** Gap between rows. Dynamic prop — kept as inline style. */
  gap?: string | number;
}

/**
 * A vertical stack of skeleton rows wrapped in an `aria-busy` region so
 * assistive tech announces "loading" once rather than reading each bar.
 */
export function SkeletonList({
  rows = 3,
  rowHeight = "3.5rem",
  label = "Loading",
  gap = "var(--space-2)",
}: SkeletonListProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      className="skeleton-list"
      // eslint-disable-next-line no-restricted-syntax
      style={{
        /* dynamic: gap prop */
        gap,
      }}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={rowHeight} />
      ))}
    </div>
  );
}
