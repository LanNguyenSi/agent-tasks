// The page frame: one <main>, a full-width header slot and a content slot.
// Geometry in .pshell-* classes in globals.css; the side gutter is the single
// --page-gutter token (24px, 12px under 600px), shared with the app header,
// PageHeader, the project hub band and the content slot.
//
// The column is centred. Each variant puts its column width on <main> as
// --page-column (class pshell--<variant>):
//   default  1200px, the standard page column
//   wide     100%,   tables and boards that use the whole width (the column
//                    is the viewport, so everything sits on the gutter)
// The content slot is capped at the column plus its gutters and centred with
// auto side margins, so its first child starts at
// max(gutter, (viewport - column) / 2). Bands in the header slot keep their
// full-width background and bottom border but pad their inner content with
// that same expression, so breadcrumb, H1, tabs and the first content child
// share one left edge at every width. The band formula resolves its
// percentage against <main>, so a band must stay a direct child of <main>
// (or of a full-width slot).
//
// The header slot renders straight into <main> (no wrapper, so a sticky
// PageHeader keeps <main> as its containing block). `flush` drops the
// content slot's gutter for children that own theirs (the board, the tasks
// table region, task detail); a flush slot may also hold its own sticky
// header, as /tasks does with its PageHeader.
//
// Usage:
//   <PageShell header={<PageHeader title="Settings" />}>
//     ...page body...
//   </PageShell>

import type { ReactNode } from "react";

export type PageShellVariant = "default" | "wide";

interface PageShellProps {
  /** Content max width. Default `default` (1200px). */
  variant?: PageShellVariant;
  /** Full-width band(s) above the content (PageHeader, project hub band). */
  header?: ReactNode;
  /** No gutter on the content slot: the children own their side padding. */
  flush?: boolean;
  /** Extra class on the content slot. */
  contentClassName?: string;
  /** Sets aria-busy on the <main> (loading skeletons). */
  busy?: boolean;
  children?: ReactNode;
}

export function PageShell({
  variant = "default",
  header,
  flush = false,
  contentClassName,
  busy = false,
  children,
}: PageShellProps) {
  const contentClass = [
    "pshell-content",
    `pshell-content--${variant}`,
    flush && "pshell-content--flush",
    contentClassName,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main className={`pshell pshell--${variant}`} aria-busy={busy || undefined}>
      {header}
      <div className={contentClass}>{children}</div>
    </main>
  );
}
