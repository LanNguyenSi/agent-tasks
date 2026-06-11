// Shimmer placeholder for the full task-detail page while initial data loads.
// Replaces the bare "Loading…" paragraph in tasks/[id]/page.tsx and any
// inner loading path in TaskDetail.

import { Skeleton, SkeletonList } from "@/components/ui/Skeleton";

export default function TaskDetailSkeleton() {
  return (
    <div
      className="td-skeleton"
      role="status"
      aria-busy="true"
      aria-label="Loading task"
    >
      <span className="sr-only">Loading task details…</span>

      {/* Breadcrumb + title area */}
      <div className="td-skeleton-header">
        <Skeleton width="28%" height="0.7rem" />
        <Skeleton width="58%" height="1.5rem" />
        <Skeleton width="42%" height="1rem" />
      </div>

      {/* Two-column ghost (main + sidebar) */}
      <div className="td-skeleton-layout">
        <div className="td-skeleton-main">
          <Skeleton width="22%" height="0.7rem" />
          <SkeletonList rows={3} rowHeight="0.875rem" gap="0.375rem" />
          <Skeleton width="28%" height="0.7rem" />
          <SkeletonList rows={5} rowHeight="0.875rem" gap="0.375rem" />
          <Skeleton width="20%" height="0.7rem" />
          <SkeletonList rows={2} rowHeight="3rem" gap="0.5rem" />
        </div>
        <div className="td-skeleton-sidebar">
          <SkeletonList rows={7} rowHeight="1.25rem" gap="0.75rem" />
        </div>
      </div>
    </div>
  );
}
