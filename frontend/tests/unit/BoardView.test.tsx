/** @vitest-environment jsdom */
/**
 * BoardView -- Backlog column.
 *
 * Backlog is a promotion queue: it must render as its own column, LEFT of
 * Open (agent-created tasks land there first), showing backlog tasks and a
 * visible count badge (the same tinted count-Badge pattern every other
 * column already uses in its header).
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import BoardView from "../../src/components/dashboard/BoardView";
import type { Task } from "../../src/lib/api";

function task(over: Partial<Task> & { id: string; title: string; status: string }): Task {
  return {
    projectId: "p-1",
    description: null,
    priority: "MEDIUM",
    templateData: null,
    claimedByUserId: null,
    claimedByAgentId: null,
    dueAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    result: null,
    labels: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Task;
}

describe("BoardView -- backlog column", () => {
  const tasks: Task[] = [
    task({ id: "b-1", title: "Agent-drafted task", status: "backlog" }),
    task({ id: "o-1", title: "An open task", status: "open" }),
  ];

  it("renders a Backlog column before the Open column", () => {
    render(
      <BoardView
        tasks={tasks}
        activeTaskId={null}
        templateFields={null}
        onSelectTask={() => {}}
      />,
    );
    const board = screen.getByLabelText("Board");
    const columnTitles = within(board)
      .getAllByText(/^(Backlog|Open|In Progress|Review|Done)$/)
      .map((el) => el.textContent);
    expect(columnTitles.indexOf("Backlog")).toBeGreaterThanOrEqual(0);
    expect(columnTitles.indexOf("Backlog")).toBeLessThan(columnTitles.indexOf("Open"));
  });

  it("renders the backlog task inside the Backlog column and shows a count badge", () => {
    render(
      <BoardView
        tasks={tasks}
        activeTaskId={null}
        templateFields={null}
        onSelectTask={() => {}}
      />,
    );
    const backlogColumn = screen.getByLabelText("Backlog, 1 task");
    expect(within(backlogColumn).getByText("Agent-drafted task")).toBeInTheDocument();
    // The column header count Badge -- same "N" element every other column renders.
    expect(within(backlogColumn).getByText("1")).toBeInTheDocument();
  });

  it("shows an empty Backlog column with a 0 count when there are no backlog tasks", () => {
    render(
      <BoardView
        tasks={[task({ id: "o-1", title: "An open task", status: "open" })]}
        activeTaskId={null}
        templateFields={null}
        onSelectTask={() => {}}
      />,
    );
    const backlogColumn = screen.getByLabelText("Backlog, 0 tasks");
    expect(within(backlogColumn).getByText("No tasks")).toBeInTheDocument();
    expect(within(backlogColumn).getByText("0")).toBeInTheDocument();
  });
});
