"use client";

// ProjectSubnav: tab strip shared across all /projects/[id]/* pages.
// Rendered by the hub layout; resolves the active tab via usePathname.
// Geometry in .proj-subnav / .proj-subnav-link in globals.css.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { projectHubHref, type ProjectHubTab } from "../../lib/routes";

interface ProjectSubnavProps {
  projectId: string;
}

interface Tab {
  label: string;
  /** Path segment after /projects/[id]. */
  segment: ProjectHubTab;
}

const TABS: Tab[] = [
  { label: "Board", segment: "board" },
  { label: "Members", segment: "members" },
  { label: "Workflow", segment: "workflow" },
  { label: "Settings", segment: "settings" },
];

export default function ProjectSubnav({ projectId }: ProjectSubnavProps) {
  const pathname = usePathname();

  return (
    <nav className="proj-subnav" aria-label="Project sections">
      {TABS.map((tab) => {
        const href = projectHubHref(projectId, tab.segment);
        // Prefix match so nested routes (e.g. /settings/something) stay
        // highlighted. The hub root itself (/projects/[id]) has no tab: it
        // redirects to the board before this row ever shows there.
        const isActive = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={tab.label}
            href={href}
            className="proj-subnav-link"
            aria-current={isActive ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
