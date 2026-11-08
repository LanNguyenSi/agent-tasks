import type { Metadata } from "next";
import type { ReactNode } from "react";

// Segment metadata for /tasks/<id>: no server-rendered title. The tab title
// names the task ("<task title> - agent-tasks"), which only the client knows
// (auth is client-side, so the server cannot fetch it); the page sets it. The
// "Tasks" inherited from ../layout.tsx would be rendered as a <title> that
// Next mounts again on a soft navigation to the same URL while no title prop
// changes, and the tab would fall back to it. `null` renders no <title>, and
// the one the client sets stays.
export const metadata: Metadata = {
  title: null,
};

export default function TaskSegmentLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
