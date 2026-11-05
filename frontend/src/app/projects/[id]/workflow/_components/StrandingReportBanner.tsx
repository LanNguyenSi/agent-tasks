"use client";

import Link from "next/link";
import AlertBanner from "../../../../../components/ui/AlertBanner";
import type { StrandedTaskRef, StrandingReport } from "../../../../../lib/api";

interface TaskListProps {
  heading: string;
  tasks: StrandedTaskRef[];
  truncated: boolean;
}

function TaskList({ heading, tasks, truncated }: TaskListProps) {
  if (tasks.length === 0) return null;
  return (
    <>
      <p>{heading}</p>
      <ul className="wf-gate-ref-list">
        {tasks.map((t) => (
          <li key={t.id}>
            <code>{t.status}</code> <Link href={`/tasks/${t.id}`}>{t.id}</Link>
          </li>
        ))}
        {truncated && <li>and more</li>}
      </ul>
    </>
  );
}

/**
 * The tasks a successful workflow save, template apply or reset left on a
 * status the workflow no longer has (the 2xx body's stranding report). They
 * keep their status; this names them once, right after the action. Renders
 * nothing when both lists are empty.
 */
export function StrandingReportBanner({ report }: { report: StrandingReport | null }) {
  const terminal = report?.terminalOutsideWorkflow ?? [];
  const outside = report?.outsideWorkflow ?? [];
  if (terminal.length + outside.length === 0) return null;

  const count = terminal.length + outside.length;
  const cut = Boolean(report?.terminalOutsideTruncated || report?.outsideTruncated);
  const title = `${count}${cut ? "+" : ""} ${count === 1 && !cut ? "task keeps" : "tasks keep"} a status this workflow no longer has`;

  return (
    <AlertBanner tone="warning" title={title}>
      <TaskList
        heading="Finished tasks whose status was removed:"
        tasks={terminal}
        truncated={Boolean(report?.terminalOutsideTruncated)}
      />
      <TaskList
        heading="Tasks on a status the workflow does not have:"
        tasks={outside}
        truncated={Boolean(report?.outsideTruncated)}
      />
    </AlertBanner>
  );
}
