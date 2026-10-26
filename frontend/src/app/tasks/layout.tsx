import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ExactPathTitle } from "../../components/DocumentTitle";

// The list sets its tab title here; `/tasks/[id]` sets its own from the task.
export const metadata: Metadata = { title: "Tasks" };

export default function TasksLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ExactPathTitle path="/tasks" title="Tasks" />
      {children}
    </>
  );
}
