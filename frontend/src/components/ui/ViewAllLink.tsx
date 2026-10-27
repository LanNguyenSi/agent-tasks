// Quiet "View all" link: a secondary-text link with a fixed accessible
// name, used on section and widget headers (Home widgets, "Your projects").
// The arrow is the `arrow-right` Icon (aria-hidden), never a text glyph,
// so the accessible name stays exactly the passed `aria-label`.

import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "./Icon";

interface ViewAllLinkProps {
  href: string;
  /**
   * Required accessible name naming the target (e.g. "View all Backlog
   * tasks"), so links that differ in href never share a name. The visible
   * label (default "View all") must be contained in it.
   */
  "aria-label": string;
  /** Visible label; "View all" unless a section names itself (e.g. "All projects"). */
  children?: ReactNode;
}

export function ViewAllLink({
  href,
  "aria-label": ariaLabel,
  children = "View all",
}: ViewAllLinkProps) {
  return (
    <Link href={href} className="view-all-link" aria-label={ariaLabel}>
      {children}
      <Icon name="arrow-right" size={12} />
    </Link>
  );
}
