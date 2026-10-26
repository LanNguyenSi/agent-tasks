// The page frame: one <main>, a full-width header slot and a content slot.
// Geometry in .pshell-* classes in globals.css; the side gutter is the single
// --page-gutter token (24px, 12px under 600px), shared with the app header,
// PageHeader, the project hub band and the content slot, so every page's
// first element starts on the same left edge.
//
// Variants set the max width of the content slot (left-aligned, never centred
// unless `centered` is set):
//   default  1200px, the standard page column
//   narrow    760px, single-form pages
//   wide      none,  tables and boards that use the whole width
//
// The header slot is always full width and renders straight into <main> (no
// wrapper, so a sticky PageHeader keeps <main> as its containing block).
// Bands rendered in it (PageHeader, the project hub header and tab row) carry
// their own gutter so their bottom borders can span the viewport. `flush` drops the content slot's gutter for
// children that own theirs (the board, the tasks table region).
//
// Usage:
//   <PageShell variant="narrow" header={<PageHeader title="Settings" />}>
//     ...page body...
//   </PageShell>

import type { ReactNode } from "react";

export type PageShellVariant = "default" | "narrow" | "wide";

interface PageShellProps {
  /** Content max width. Default `default` (1200px). */
  variant?: PageShellVariant;
  /** Full-width band(s) above the content (PageHeader, project hub band). */
  header?: ReactNode;
  /** Centre the content column instead of left-aligning it. */
  centered?: boolean;
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
  centered = false,
  flush = false,
  contentClassName,
  busy = false,
  children,
}: PageShellProps) {
  const contentClass = [
    "pshell-content",
    `pshell-content--${variant}`,
    centered && "pshell-content--centered",
    flush && "pshell-content--flush",
    contentClassName,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main className="pshell" aria-busy={busy || undefined}>
      {header}
      <div className={contentClass}>{children}</div>
    </main>
  );
}
