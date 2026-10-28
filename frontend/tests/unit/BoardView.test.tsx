/** @vitest-environment jsdom */
/**
 * BoardView -- Backlog column.
 *
 * Backlog is a promotion queue: it must render as its own column, LEFT of
 * Open (agent-created tasks land there first), showing backlog tasks and a
 * visible count badge (the same tinted count-Badge pattern every other
 * column already uses in its header).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
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

  it("shows no confidence badge on Done-column cards but keeps it on live columns", () => {
    const allColumnTasks: Task[] = [
      task({ id: "o-1", title: "An open task", status: "open" }),
      task({ id: "d-1", title: "A done task", status: "done" }),
    ];
    render(
      <BoardView
        tasks={allColumnTasks}
        activeTaskId={null}
        templateFields={null}
        onSelectTask={() => {}}
      />,
    );
    const openColumn = screen.getByLabelText("Open, 1 task");
    expect(within(openColumn).getByText(/^Spec \d+/)).toBeInTheDocument();
    const doneColumn = screen.getByLabelText("Done, 1 task");
    expect(within(doneColumn).queryByText(/^Spec \d+/)).not.toBeInTheDocument();
    expect(within(doneColumn).getByText("A done task")).toBeInTheDocument();
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

  // Activation is handled in JS: the column scrolls into view and its heading
  // (tabIndex -1) takes focus, so the next Tab continues from the column. The
  // default anchor navigation is prevented, so no #db-col-* hash is ever
  // written (a stale hash also survived the Board to List toggle before).
  it("chip activation scrolls the column into view, focuses its heading, and writes no hash", () => {
    window.history.replaceState(null, "", "/projects/p1/board");
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderBoard();
      const nav = screen.getByRole("navigation", { name: "Jump to column" });
      // fireEvent returns false exactly when the handler prevented the
      // default, i.e. the anchor's hash navigation never happened.
      const notCancelled = fireEvent.click(
        within(nav).getByRole("link", { name: "Jump to Open, 1 task" }),
      );
      const column = document.getElementById("db-col-open");
      expect(column).not.toBeNull();
      expect(notCancelled).toBe(false);
      expect(scrollIntoView).toHaveBeenCalled();
      expect(column!.querySelector(".db-col-title")).toHaveFocus();
      expect(window.location.hash).toBe("");
    } finally {
      Element.prototype.scrollIntoView = original;
      window.history.replaceState(null, "", "/");
    }
  });
});

// Card badge tiers against the project's EFFECTIVE threshold (same resolver
// as the task page), so card and task page never disagree on the tier.
describe("BoardView -- card badge tier vs project threshold", () => {
  // Fixture computed by the client scorer mirror to exactly 70.
  const SCORE70_DESCRIPTION = [
    "Context: endpoint https://example.internal/reports/export reads `src/reports/export.ts`; during a 30-second refresh window viewers receive fifteen-minute-old rows plus duplicated 12-row batches.",
    "",
    "Goal: return rows stamped at request time, cached per session, headers unchanged except freshness markers.",
    "",
    "- verify via integration spec tests/reports-export.test.ts asserting timestamps increase",
    "- run npm test locally until the suite reports green",
    "- check response header `X-Report-Stale` disappears",
    "1. rollback plan: revert the single commit, no migration needed",
    "",
    "Only export.ts and its own tests change; database schema remains untouched.",
  ].join("\n");

  const tasks: Task[] = [
    task({
      id: "o-70",
      title: "Refresh report export rows",
      status: "open",
      description: SCORE70_DESCRIPTION,
    }),
  ];

  it("shows Spec 70, partial when the project threshold is 80 (below it, above half)", () => {
    render(
      <BoardView
        tasks={tasks}
        activeTaskId={null}
        templateFields={null}
        confidenceThreshold={80}
        onSelectTask={() => {}}
      />,
    );
    const badge = within(screen.getByLabelText("Open, 1 task")).getByText(/^Spec 70, partial$/);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 80.",
    );
  });

  it("shows Spec 70, complete with no threshold threaded (global default 60 fallback, unnamed tooltip)", () => {
    render(
      <BoardView
        tasks={tasks}
        activeTaskId={null}
        templateFields={null}
        onSelectTask={() => {}}
      />,
    );
    const badge = within(screen.getByLabelText("Open, 1 task")).getByText(/^Spec 70, complete$/);
    // Threshold unknown to the caller: the global default tiers the badge,
    // but the tooltip does not name a project threshold it does not have.
    expect(badge).toHaveAttribute("title", "How complete the task spec is (0-100).");
  });

  it("prefers the taskType override over the project threshold for a typed card", () => {
    const typed = [
      task({
        id: "o-70-t",
        title: "Refresh report export rows",
        status: "open",
        description: SCORE70_DESCRIPTION,
        templateData: { taskType: "feature" },
      }),
    ];
    render(
      <BoardView
        tasks={typed}
        activeTaskId={null}
        templateFields={null}
        confidenceThreshold={50}
        taskTypeThresholds={{ feature: 80 }}
        onSelectTask={() => {}}
      />,
    );
    const badge = within(screen.getByLabelText("Open, 1 task")).getByText(/^Spec 70, partial$/);
    expect(badge).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 80.",
    );
  });
});
