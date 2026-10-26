import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ExactPathTitle } from "../../components/DocumentTitle";

// Segment metadata: the document (tab) title for `/projects` and its project
// hub children is "Projects" instead of the root "agent-tasks".
// `frontend/src/app/projects/page.tsx` is a client component and cannot
// export metadata itself, so the title lives in this pass-through layout;
// it renders no DOM of its own. The tab title is set
// client-side by DocumentTitle (see components/DocumentTitle.tsx); this
// metadata is the server-rendered fallback.
export const metadata: Metadata = {
  title: "Projects",
};

export default function ProjectsSegmentLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ExactPathTitle path="/projects" title="Projects" />
      <ExactPathTitle path="/projects/workflow" title="Workflow" />
      {children}
    </>
  );
}
