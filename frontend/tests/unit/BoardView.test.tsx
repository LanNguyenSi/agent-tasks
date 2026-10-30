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
import { buildBoardColumns } from "../../src/lib/boardColumns";
import type { Task, Workflow } from "../../src/lib/api";

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

// ── Custom workflow columns ───────────────────────────────────────

const CUSTOM_WORKFLOW = {
  id: "wf-custom",
  projectId: "p-1",
  name: "Custom",
  isDefault: true,
  definition: {
    initialState: "open",
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "plan", label: "Planning", terminal: false },
      { name: "build", label: "Build", terminal: false },
      { name: "qa", label: "QA", terminal: false },
      { name: "shipped", label: "Shipped", terminal: true },
    ],
    transitions: [
      { from: "open", to: "plan" },
      { from: "plan", to: "build" },
      { from: "build", to: "qa" },
      { from: "qa", to: "shipped" },
    ],
  },
} as unknown as Workflow;

function customColumnTasks(): Task[] {
  return [
    task({ id: "b-1", title: "Queued", status: "backlog" }),
    task({ id: "o-1", title: "Started", status: "open" }),
    task({ id: "pl-1", title: "Planned", status: "plan" }),
    task({ id: "pl-2", title: "Planned too", status: "plan" }),
    task({ id: "bd-1", title: "Built", status: "build" }),
    task({ id: "qa-1", title: "Checked", status: "qa" }),
    task({ id: "sh-1", title: "Shipped", status: "shipped" }),
    task({ id: "x-1", title: "Orphan", status: "legacy_x" }),
    // Work still in a built-in state the custom workflow left out, and a
    // discarded task: the first lands in an extra column under the board's own
    // label, the second gets no column at all.
    task({ id: "ip-1", title: "Left behind", status: "in_progress" }),
    task({ id: "ab-1", title: "Discarded", status: "abandoned" }),
  ];
}

describe("BoardView -- custom workflow columns", () => {
  function renderCustom(tasks = customColumnTasks()) {
    return render(
      <BoardView
        tasks={tasks}
        columns={buildBoardColumns([CUSTOM_WORKFLOW], tasks)}
        activeTaskId={null}
        templateFields={null}
        onSelectTask={() => {}}
        onAddTask={() => {}}
      />,
    );
  }

  it("renders one column per entry of the column list, in order", () => {
    renderCustom();
    const board = screen.getByLabelText("Board");
    const sections = board.querySelectorAll(":scope > section.db-col");
    expect([...sections].map((s) => s.id)).toEqual([
      "db-col-backlog",
      "db-col-open",
      "db-col-plan",
      "db-col-build",
      "db-col-qa",
      "db-col-shipped",
      "db-col-legacy_x",
      "db-col-in_progress",
    ]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Backlog",
      "Open",
      "Planning",
      "Build",
      "QA",
      "Shipped",
      "legacy_x",
      "In Progress",
    ]);
    // An abandoned task is not on the board at all: no column, not counted.
    expect(board.querySelector("#db-col-abandoned")).toBeNull();
    expect(screen.queryByText("Discarded")).not.toBeInTheDocument();
  });

  it("shows the unknown-status task in the extra last column", () => {
    renderCustom();
    const extra = screen.getByLabelText("legacy_x, 1 task");
    expect(within(extra).getByText("Orphan")).toBeInTheDocument();
    // A built-in state the workflow left out reads with the board's own label.
    const builtInExtra = screen.getByLabelText("In Progress, 1 task");
    expect(within(builtInExtra).getByText("Left behind")).toBeInTheDocument();
    expect(builtInExtra).toHaveClass("db-col", "db-col--in-progress", "db-col--custom");
  });

  it("gives the board an inline --db-cols equal to the column count", () => {
    renderCustom();
    const board = screen.getByLabelText("Board");
    expect(board).toHaveStyle({ "--db-cols": "8" });
  });

  it("marks a board wider than the built-in five as horizontally scrollable", () => {
    renderCustom();
    expect(screen.getByLabelText("Board")).toHaveClass("db-board", "db-board--scroll");
  });

  it("starts the scroll treatment at the sixth column, not later", () => {
    render(
      <BoardView
        tasks={[task({ id: "x-1", title: "Orphan", status: "legacy_x" })]}
        columns={buildBoardColumns(undefined, [{ status: "legacy_x" }])}
        activeTaskId={null}
        templateFields={null}
        onSelectTask={() => {}}
      />,
    );
    const board = screen.getByLabelText("Board");
    expect(board).toHaveStyle({ "--db-cols": "6" });
    expect(board).toHaveClass("db-board--scroll");
  });

  it("gives custom columns the neutral fallback class and leaves the built-in classes alone", () => {
    renderCustom();
    expect(document.getElementById("db-col-plan")).toHaveClass("db-col", "db-col--plan", "db-col--custom");
    expect(document.getElementById("db-col-legacy_x")).toHaveClass("db-col--custom");
    expect(document.getElementById("db-col-open")).not.toHaveClass("db-col--custom");
    expect(document.getElementById("db-col-backlog")).toHaveClass("db-col--backlog");
    expect(document.getElementById("db-col-backlog")).not.toHaveClass("db-col--custom");
  });

  it("renders the + on Backlog and Open only, never on a custom column", () => {
    renderCustom();
    expect(screen.getByLabelText("Add task to Backlog")).toBeInTheDocument();
    expect(screen.getByLabelText("Add task to Open")).toBeInTheDocument();
    for (const label of ["Planning", "Build", "QA", "Shipped", "legacy_x", "In Progress"]) {
      expect(screen.queryByLabelText(`Add task to ${label}`)).not.toBeInTheDocument();
    }
  });

  it("applies the Done cap to the terminal custom column and offers the expander", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      task({ id: `sh-${i}`, title: `Shipped ${i + 1}`, status: "shipped" }),
    );
    renderCustom(many);
    const shipped = screen.getByLabelText("Shipped, 11 tasks");
    expect(within(shipped).queryByText("Shipped 11")).not.toBeInTheDocument();
    const expander = within(shipped).getByRole("button", { name: "… 1 more" });
    fireEvent.click(expander);
    expect(within(shipped).getByText("Shipped 11")).toBeInTheDocument();
    fireEvent.click(within(shipped).getByRole("button", { name: "Show less" }));
    expect(within(shipped).queryByText("Shipped 11")).not.toBeInTheDocument();
  });

  it("has one jump chip per column, with counts, in column order", () => {
    renderCustom();
    const nav = screen.getByRole("navigation", { name: "Jump to column" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual([
      "Jump to Backlog, 1 task",
      "Jump to Open, 1 task",
      "Jump to Planning, 2 tasks",
      "Jump to Build, 1 task",
      "Jump to QA, 1 task",
      "Jump to Shipped, 1 task",
      "Jump to legacy_x, 1 task",
      "Jump to In Progress, 1 task",
    ]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "#db-col-backlog",
      "#db-col-open",
      "#db-col-plan",
      "#db-col-build",
      "#db-col-qa",
      "#db-col-shipped",
      "#db-col-legacy_x",
      "#db-col-in_progress",
    ]);
  });

  it("keeps the built-in five columns with no columns prop whatever the tasks are", () => {
    render(
      <BoardView
        tasks={[task({ id: "x-1", title: "Orphan", status: "legacy_x" })]}
        activeTaskId={null}
        templateFields={null}
        onSelectTask={() => {}}
      />,
    );
    const board = screen.getByLabelText("Board");
    expect(board.querySelectorAll(":scope > section.db-col")).toHaveLength(5);
    expect(board).toHaveStyle({ "--db-cols": "5" });
    // Five columns keep today's equal-column grid: no scroll treatment.
    expect(board).not.toHaveClass("db-board--scroll");
    expect(screen.queryByLabelText("legacy_x, 1 task")).not.toBeInTheDocument();
  });
});
