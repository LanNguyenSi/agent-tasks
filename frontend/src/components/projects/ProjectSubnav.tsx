"use client";

// ProjectSubnav: tab strip shared across all /projects/[id]/* pages.
// Rendered by the hub layout; resolves the active tab via usePathname.
// Geometry in .proj-subnav / .proj-subnav-link in globals.css.

import Link from "next/link";
import { usePathname } from "next/navigation";

interface ProjectSubnavProps {
  projectId: string;
}

interface Tab {
  label: string;
  /** Path segment after /projects/[id]. Empty string = overview. */
  segment: string;
}

const TABS: Tab[] = [
  { label: "Overview", segment: "" },
  { label: "Settings", segment: "settings" },
  { label: "Members", segment: "members" },
  { label: "Workflow", segment: "workflow" },
];

export default function ProjectSubnav({ projectId }: ProjectSubnavProps) {
  const pathname = usePathname();
  const base = `/projects/${projectId}`;

  return (
    <nav className="proj-subnav" aria-label="Project sections">
      {TABS.map((tab) => {
        const href = tab.segment ? `${base}/${tab.segment}` : base;
        // Overview is an exact match; other tabs use prefix match so
        // nested routes (e.g. /settings/something) stay highlighted.
        const isActive =
          tab.segment === ""
            ? pathname === base || pathname === `${base}/`
            : pathname === href || pathname.startsWith(`${href}/`);
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
