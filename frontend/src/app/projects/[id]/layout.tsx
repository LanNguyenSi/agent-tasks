import type { Metadata } from "next";
import type { ReactNode } from "react";
import ProjectHubLayout from "./_components/ProjectHubLayout";

// Segment metadata for /projects/<id>/*: no server-rendered title. The tab
// title names the project and the tab ("<project name> · Board - agent-tasks"),
// which only the client knows; ProjectHubLayout sets it. A static title here,
// or the "Projects" inherited from ../layout.tsx, is rendered as a <title>
// that Next mounts again on a soft navigation to the same URL (a click on the
// current tab) while no title prop changes, so the tab would fall back to it.
// `null` renders no <title>, and the one the client sets stays.
export const metadata: Metadata = {
  title: null,
};

export default function ProjectSegmentLayout({ children }: { children: ReactNode }) {
  return <ProjectHubLayout>{children}</ProjectHubLayout>;
}
