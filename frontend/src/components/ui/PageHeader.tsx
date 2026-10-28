// 52px sticky toolbar: breadcrumb, H1 title, summary, and right-aligned actions.
// One per page. In use on /tasks and /settings (+ team, sso); the project
// board toolbar reuses its .page-header geometry. Pages render it in the
// `header` slot of PageShell, which keeps it full width (background and bottom
// border span the viewport); the band pads its inner content to the page
// column, max(--page-gutter, (100% - --page-column) / 2), so its breadcrumb
// and H1 sit on the same left edge as the centred content.
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
  /**
   * Opt in when the summary can be arbitrarily long (a user-chosen name): the
   * title keeps its full width and the summary shrinks with an ellipsis
   * instead of pushing the band wider than the viewport. The text stays in
   * the DOM, so assistive tech still reads all of it, and a string summary
   * also gets the full text as `title` on the truncated element. Off by
   * default: the summary then stays on one line at its natural width.
   */
  truncateSummary?: boolean;
  /** Right-aligned actions (buttons, toggles). */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({
  breadcrumb,
  title,
  summary,
  truncateSummary = false,
  children,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={[
        "page-header",
        truncateSummary && "page-header--summary-truncates",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="page-header-left">
        {breadcrumb && (
          <div className="page-header-breadcrumb">{breadcrumb}</div>
        )}
        <div className="page-header-title-row">
          <h1 className="page-header-title">{title}</h1>
          {summary && (
            // An ellipsised summary is unreadable past the ellipsis, so the
            // truncated element carries the full text as a tooltip. Only
            // then: without truncateSummary the text is never cut, and a
            // non-string summary has no text to title.
            <div
              className="page-header-summary"
              title={
                truncateSummary && typeof summary === "string" ? summary : undefined
              }
            >
              {summary}
            </div>
          )}
        </div>
      </div>
      {children && <div className="page-header-actions">{children}</div>}
    </div>
  );
}
