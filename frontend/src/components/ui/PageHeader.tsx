// 52px sticky toolbar: breadcrumb, H1 title, summary, and right-aligned actions.
// One per page — no page adopts it yet; shown in /dev/ui only for now.
// Geometry in .page-header-* classes in globals.css.
//
// Usage:
//   <PageHeader
//     breadcrumb={<><a href="/home">Home</a> / Tasks</>}
//     title="My project"
//     summary="12 open"
//   >
//     <Button variant="primary" size="sm">New task</Button>
//   </PageHeader>

import type { ReactNode } from "react";

interface PageHeaderProps {
  /** Optional breadcrumb trail rendered above the title. */
  breadcrumb?: ReactNode;
  /** H1 page title (required). */
  title: ReactNode;
  /** Compact summary next to the title (e.g. "12 open"). */
  summary?: ReactNode;
  /** Right-aligned actions (buttons, toggles). */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({
  breadcrumb,
  title,
  summary,
  children,
  className,
}: PageHeaderProps) {
  return (
    <div className={["page-header", className].filter(Boolean).join(" ")}>
      <div className="page-header-left">
        {breadcrumb && (
          <div className="page-header-breadcrumb">{breadcrumb}</div>
        )}
        <div className="page-header-title-row">
          <h1 className="page-header-title">{title}</h1>
          {summary && <div className="page-header-summary">{summary}</div>}
        </div>
      </div>
      {children && <div className="page-header-actions">{children}</div>}
    </div>
  );
}
