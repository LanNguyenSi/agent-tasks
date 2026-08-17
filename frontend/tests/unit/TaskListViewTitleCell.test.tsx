/** @vitest-environment jsdom */
/**
 * Render coverage for the dashboard list view's title-cell column (the
 * "title" entry of TASK_LIST_COLS, src/components/dashboard/TaskListView.tsx):
 * the row must show the 8-char short id next to the title, and the full
 * UUID must stay reachable via a `title` attribute for a hover tooltip.
 * This is the chip a reviewer found untested — deleting it from the row
 * (the mutant) must turn these assertions red; see be016ca3 fix-round-2
 * notes.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TASK_LIST_COLS } from "../../src/components/dashboard/TaskListView";
import type { Task } from "../../src/lib/api";

function task(over: Partial<Task> & { id: string; title: string }): Task {
  return {
    projectId: "p-1",
    description: null,
    status: "open",
    priority: "MEDIUM",
    templateData: null,
    claimedByUserId: null,
    claimedByAgentId: null,
    claimedAt: null,
    dueAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    result: null,
    externalRef: null,
    labels: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attachments: [],
    ...over,
  } as Task;
}

function renderTitleCell(t: Task) {
  const col = TASK_LIST_COLS.find((c) => c.key === "title");
  if (!col?.render) throw new Error("title column has no render function");
  render(<>{col.render(t)}</>);
}

describe("dashboard/TaskListView title cell — short-id chip", () => {
  const t = task({
    id: "8f30a6f3-1234-4abc-9def-000000000000",
    title: "Fix the login flow",
  });

  it("shows the 8-char id prefix next to the title", () => {
    renderTitleCell(t);
    expect(screen.getByText(t.title)).toBeInTheDocument();
    expect(screen.getByText("8f30a6f3")).toBeInTheDocument();
  });

  it("makes the full UUID reachable via a title attribute (hover tooltip)", () => {
    renderTitleCell(t);
    expect(screen.getByTitle(t.id)).toBeInTheDocument();
  });

  it("gives the chip an aria-label carrying the short id (not the decorative ellipsis)", () => {
    renderTitleCell(t);
    expect(screen.getByLabelText(`Task id ${t.id.slice(0, 8)}`)).toBeInTheDocument();
  });
});
