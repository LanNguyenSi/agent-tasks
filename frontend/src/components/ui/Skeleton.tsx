"use client";

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
      style={{ width, height, borderRadius: radius, ...style }}
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
    <div role="status" aria-busy="true" style={{ display: "flex", flexDirection: "column", gap }}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={rowHeight} />
      ))}
    </div>
  );
}
