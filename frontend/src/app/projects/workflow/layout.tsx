import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: { absolute: "Workflow - agent-tasks" } };

export default function ProjectsWorkflowLayout({ children }: { children: ReactNode }) {
  return children;
}
