/** @vitest-environment jsdom */
/**
 * Board semantics: column titles are h2, a card is an <article> whose h3 holds
 * the one control (a button named by the task title), priority / spec score /
 * labels / due date (with the word "Overdue") / assignee are the button's
 * accessible description, all five column heads have the same structure, and
 * a click anywhere on the card or Enter / Space on the title opens it once.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BoardView from "../../src/components/dashboard/BoardView";
import type { Task } from "../../src/lib/api";

const DAY = 24 * 60 * 60 * 1000;

function task(over: Partial<Task> & { id: string; title: string; status: string }): Task {
  return {
    projectId: "p-1",
    description: null,
    priority: "HIGH",
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

function renderBoard(tasks: Task[], onSelectTask: (id: string) => void = () => {}) {
  return render(
    <BoardView
      tasks={tasks}
      activeTaskId={null}
      templateFields={null}
      onSelectTask={onSelectTask}
      onAddTask={() => {}}
    />,
  );
}

describe("BoardView -- headings", () => {
  it("renders the five column titles as h2 and each card title as h3", () => {
    renderBoard([task({ id: "o-1", title: "An open task", status: "open" })]);
    const h2 = screen.getAllByRole("heading", { level: 2 });
    expect(h2.map((h) => h.textContent)).toEqual(["Backlog", "Open", "In Progress", "Review", "Done"]);
    const h3 = screen.getAllByRole("heading", { level: 3 });
    expect(h3.map((h) => h.textContent)).toEqual(["An open task"]);
  });

  it("names the board group with a label that axe accepts (a group role, not a bare div)", () => {
    renderBoard([]);
    expect(screen.getByRole("group", { name: "Board" })).toBeInTheDocument();
  });
});

describe("BoardView -- equal column heads", () => {
  it("gives every column head the same children: dot, h2, count, and a + or its empty slot", () => {
    renderBoard([task({ id: "o-1", title: "T", status: "open" })]);
    const heads = [...document.querySelectorAll(".db-col-head")];
    expect(heads).toHaveLength(5);
    for (const head of heads) {
      expect([...head.children].map((c) => c.className.split(" ")[0])).toEqual([
        "db-col-dot",
        "db-col-title",
        "badge",
        "db-col-add",
      ]);
    }
    // The + button on Backlog and Open, the aria-hidden slot elsewhere.
    expect(heads.map((h) => h.querySelector("button.db-col-add") !== null)).toEqual([true, true, false, false, false]);
    for (const head of heads.slice(2)) {
      const slot = head.querySelector("span.db-col-add--slot");
      expect(slot).not.toBeNull();
      expect(slot).toHaveAttribute("aria-hidden", "true");
    }
  });
});

describe("BoardView -- card semantics", () => {
  const overdueAt = new Date(Date.now() - 3 * DAY).toISOString();
  const futureAt = new Date(Date.now() + 3 * DAY).toISOString();

  it("is an article whose h3 holds a button named by the title alone", () => {
    renderBoard([task({ id: "o-1", title: "Ship the board", status: "open", labels: ["backend"] })]);
    const button = screen.getByRole("button", { name: "Ship the board" });
    expect(button.closest("h3")).not.toBeNull();
    expect(button.closest("article")).not.toBeNull();
    expect(button.closest("article")?.querySelectorAll("button")).toHaveLength(1);
  });

  it("describes the card with priority, spec score, labels and due date", () => {
    renderBoard([
      task({ id: "o-1", title: "Ship the board", status: "open", labels: ["backend", "ux", "docs"], dueAt: futureAt }),
    ]);
    const description = screen.getByRole("button", { name: "Ship the board" });
    expect(description).toHaveAccessibleDescription(/Priority: High/);
    expect(description).toHaveAccessibleDescription(/Spec \d+, (complete|partial|thin)/);
    expect(description).toHaveAccessibleDescription(/Labels: backend, ux, docs/);
    expect(description).toHaveAccessibleDescription(new RegExp(`Due ${futureAt.slice(0, 10)}`));
    expect(description).not.toHaveAccessibleDescription(/Overdue/);
  });

  it("says Overdue in words, visibly and in the description, when the due date has passed", () => {
    renderBoard([task({ id: "o-1", title: "Late task", status: "open", dueAt: overdueAt })]);
    const button = screen.getByRole("button", { name: "Late task" });
    expect(button).toHaveAccessibleDescription(new RegExp(`Overdue, due ${overdueAt.slice(0, 10)}`));
    const due = document.querySelector(".db-card-due");
    expect(due).toHaveClass("db-card-due--overdue");
    expect(due).toHaveTextContent(`Overdue${overdueAt.slice(0, 10)}`);
  });

  it("does not say Overdue for a done task past its due date or for a future one", () => {
    renderBoard([
      task({ id: "d-1", title: "Finished late", status: "done", dueAt: overdueAt }),
      task({ id: "o-1", title: "Not yet", status: "open", dueAt: futureAt }),
    ]);
    expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
    expect(document.querySelector(".db-card-due--overdue")).toBeNull();
  });

  it("includes the assignee in the description", () => {
    renderBoard([
      task({
        id: "o-1",
        title: "Owned task",
        status: "in_progress",
        claimedByUser: { id: "u-1", login: "lan", name: "Lan Nguyen" },
      } as Partial<Task> & { id: string; title: string; status: string }),
    ]);
    expect(screen.getByRole("button", { name: "Owned task" })).toHaveAccessibleDescription(/Assigned to Lan Nguyen/);
  });

  it("hides the visible chip rows from assistive tech, since the description repeats them", () => {
    renderBoard([
      task({ id: "o-1", title: "Ship the board", status: "open", labels: ["backend"], dueAt: futureAt }),
    ]);
    const article = screen.getByRole("button", { name: "Ship the board" }).closest("article") as HTMLElement;
    expect(article.querySelector(".db-card-top")).toHaveAttribute("aria-hidden", "true");
    expect(article.querySelector(".db-card-foot")).toHaveAttribute("aria-hidden", "true");
  });

  it("links the description to elements inside the same card", () => {
    renderBoard([task({ id: "o-1", title: "Ship the board", status: "open", labels: ["backend"] })]);
    const button = screen.getByRole("button", { name: "Ship the board" });
    const article = button.closest("article") as HTMLElement;
    for (const id of (button.getAttribute("aria-describedby") ?? "").split(" ")) {
      expect(article.querySelector(`#${CSS.escape(id)}`), `describedby target ${id}`).not.toBeNull();
    }
  });
});

describe("BoardView -- opening a card", () => {
  const tasks = [task({ id: "o-1", title: "Ship the board", status: "open" })];

  it("opens on a click on the title", async () => {
    const onSelect = vi.fn();
    renderBoard(tasks, onSelect);
    await userEvent.click(screen.getByRole("button", { name: "Ship the board" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("o-1");
  });

  it("opens on a click on the card away from the title", async () => {
    const onSelect = vi.fn();
    renderBoard(tasks, onSelect);
    await userEvent.click(screen.getByText(/^Spec \d+/));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("o-1");
  });

  it("opens once on Enter and once on Space from the keyboard", async () => {
    const onSelect = vi.fn();
    renderBoard(tasks, onSelect);
    const button = screen.getByRole("button", { name: "Ship the board" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("does not open a card when the column + is pressed", async () => {
    const onSelect = vi.fn();
    renderBoard(tasks, onSelect);
    const open = screen.getByRole("region", { name: "Open, 1 task" });
    await userEvent.click(within(open).getByRole("button", { name: "Add task to Open" }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
