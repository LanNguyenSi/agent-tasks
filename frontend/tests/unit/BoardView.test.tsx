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

  it("renders an add-task button on Backlog and Open only, not on In Progress/Review/Done (column gating, operator decision 2026-08-20)", () => {
    const allColumnTasks: Task[] = [
      task({ id: "b-1", title: "Agent-drafted task", status: "backlog" }),
      task({ id: "o-1", title: "An open task", status: "open" }),
      task({ id: "i-1", title: "An in-progress task", status: "in_progress" }),
      task({ id: "r-1", title: "A review task", status: "review" }),
      task({ id: "d-1", title: "A done task", status: "done" }),
    ];
    render(
      <BoardView
        tasks={allColumnTasks}
        activeTaskId={null}
        templateFields={null}
        onSelectTask={() => {}}
        onAddTask={() => {}}
      />,
    );
    const backlogColumn = screen.getByLabelText("Backlog, 1 task");
    expect(within(backlogColumn).getByLabelText("Add task to Backlog")).toBeInTheDocument();
    const openColumn = screen.getByLabelText("Open, 1 task");
    expect(within(openColumn).getByLabelText("Add task to Open")).toBeInTheDocument();
    const inProgressColumn = screen.getByLabelText("In Progress, 1 task");
    expect(within(inProgressColumn).queryByLabelText("Add task to In Progress")).not.toBeInTheDocument();
    const reviewColumn = screen.getByLabelText("Review, 1 task");
    expect(within(reviewColumn).queryByLabelText("Add task to Review")).not.toBeInTheDocument();
    const doneColumn = screen.getByLabelText("Done, 1 task");
    expect(within(doneColumn).queryByLabelText("Add task to Done")).not.toBeInTheDocument();
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

describe("BoardView -- column jump bar", () => {
  const tasks: Task[] = [
    task({ id: "b-1", title: "B1", status: "backlog" }),
    task({ id: "b-2", title: "B2", status: "backlog" }),
    task({ id: "o-1", title: "O1", status: "open" }),
    task({ id: "d-1", title: "D1", status: "done" }),
  ];

  function renderBoard() {
    return render(
      <BoardView tasks={tasks} activeTaskId={null} templateFields={null} onSelectTask={() => {}} />,
    );
  }

  it("has one link per column, in column order, with the task count", () => {
    renderBoard();
    const nav = screen.getByRole("navigation", { name: "Jump to column" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual([
      "Jump to Backlog, 2 tasks",
      "Jump to Open, 1 task",
      "Jump to In Progress, 0 tasks",
      "Jump to Review, 0 tasks",
      "Jump to Done, 1 task",
    ]);
    expect(links.map((l) => l.textContent)).toEqual([
      "Backlog2",
      "Open1",
      "In Progress0",
      "Review0",
      "Done1",
    ]);
  });

  it("links each chip to the id of its column section", () => {
    renderBoard();
    const nav = screen.getByRole("navigation", { name: "Jump to column" });
    for (const link of within(nav).getAllByRole("link")) {
      const id = link.getAttribute("href")!.slice(1);
      const target = document.getElementById(id);
      expect(target, `target for ${link.getAttribute("href")}`).not.toBeNull();
      expect(target!.tagName).toBe("SECTION");
    }
    expect(within(nav).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
      "#db-col-backlog",
      "#db-col-open",
      "#db-col-in_progress",
      "#db-col-review",
      "#db-col-done",
    ]);
  });
});
