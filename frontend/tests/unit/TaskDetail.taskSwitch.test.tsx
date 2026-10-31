/** @vitest-environment jsdom */
/**
 * TaskDetail resets its local state when the task id changes (switching to
 * another task) and only then: a re-render with the same id, as a poll refresh
 * produces, keeps what the user typed and the edit mode they are in.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/lib/api", () => ({
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  claimTask: vi.fn(),
  releaseTask: vi.fn(),
  startTask: vi.fn(),
  createComment: vi.fn(),
  deleteComment: vi.fn(),
  addDependency: vi.fn(),
  removeDependency: vi.fn(),
  reviewTask: vi.fn(),
  transitionTask: vi.fn(),
}));

import TaskDetail from "../../src/components/TaskDetail";
import type { Task } from "../../src/lib/api";

afterEach(cleanup);
beforeEach(() => {
  // jsdom does not implement scrollIntoView; the Select listbox calls it.
  Element.prototype.scrollIntoView = vi.fn();
});

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "First task",
    description: "First description",
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
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    attachments: [],
    artifacts: [],
    comments: [],
    blockedBy: [],
    blocks: [],
    ...over,
  } as Task;
}

const first = makeTask();
const second = makeTask({
  id: "task-2",
  title: "Second task",
  description: "Second description",
});

const baseProps = {
  tasks: [first, second],
  user: null,
  templateFields: null,
  confidenceThreshold: 60,
  enforcementMode: null,
  onUpdate: () => {},
  onDelete: () => {},
  onClose: () => {},
  onError: () => {},
};

function composer() {
  return screen.getByRole("textbox", { name: "Write a comment" }) as HTMLTextAreaElement;
}

describe("TaskDetail: task switch", () => {
  describe("initialEditing set", () => {
    it("seeds the edit fields from the new task when the id changes", () => {
      const { rerender } = render(<TaskDetail task={first} {...baseProps} initialEditing />);
      expect(screen.getByDisplayValue("First task")).toBeInTheDocument();

      rerender(<TaskDetail task={second} {...baseProps} initialEditing />);
      expect(screen.getByDisplayValue("Second task")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Second description")).toBeInTheDocument();
      expect(screen.queryByDisplayValue("First task")).not.toBeInTheDocument();
    });

    it("keeps the user's edit-mode input when the same task id re-renders", async () => {
      const { rerender } = render(<TaskDetail task={first} {...baseProps} initialEditing />);
      const title = screen.getByDisplayValue("First task");
      await userEvent.clear(title);
      await userEvent.type(title, "Edited by me");

      // A poll refresh: same id, new object with a newer updatedAt.
      rerender(
        <TaskDetail
          task={{ ...first, updatedAt: "2026-05-02T00:00:00.000Z" }}
          {...baseProps}
          initialEditing
        />,
      );
      expect(screen.getByDisplayValue("Edited by me")).toBeInTheDocument();
    });
  });

  describe("initialEditing not set", () => {
    it("leaves edit mode when the id changes", async () => {
      const { rerender } = render(<TaskDetail task={first} {...baseProps} />);
      await userEvent.click(screen.getByRole("button", { name: "Edit" }));
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

      rerender(<TaskDetail task={second} {...baseProps} />);
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });

    it("stays in edit mode, with the typed input, when the same task id re-renders", async () => {
      const { rerender } = render(<TaskDetail task={first} {...baseProps} />);
      await userEvent.click(screen.getByRole("button", { name: "Edit" }));
      const title = screen.getByDisplayValue("First task");
      await userEvent.type(title, " plus");

      rerender(
        <TaskDetail task={{ ...first, updatedAt: "2026-05-02T00:00:00.000Z" }} {...baseProps} />,
      );
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(screen.getByDisplayValue("First task plus")).toBeInTheDocument();
    });
  });

  it("clears an unsent comment when the id changes", async () => {
    const { rerender } = render(<TaskDetail task={first} {...baseProps} />);
    await userEvent.type(composer(), "half-written note");
    expect(composer().value).toBe("half-written note");

    rerender(<TaskDetail task={second} {...baseProps} />);
    expect(composer().value).toBe("");
  });

  it("keeps an unsent comment when the same task id re-renders", async () => {
    const { rerender } = render(<TaskDetail task={first} {...baseProps} />);
    await userEvent.type(composer(), "half-written note");

    rerender(
      <TaskDetail task={{ ...first, updatedAt: "2026-05-02T00:00:00.000Z" }} {...baseProps} />,
    );
    expect(composer().value).toBe("half-written note");
  });

  it("clears the chosen blocker when the id changes and keeps it on a same-id re-render", async () => {
    const third = makeTask({ id: "task-3", title: "Third task" });
    const props = { ...baseProps, tasks: [first, second, third] };
    const { rerender } = render(<TaskDetail task={first} {...props} initialEditing />);
    // The Add button is enabled exactly while a blocker is picked.
    const addButton = () => screen.getByRole("button", { name: "Add" });
    expect(addButton()).toBeDisabled();
    await userEvent.click(screen.getByRole("combobox", { name: "Add blocker" }));
    await userEvent.click(screen.getByRole("option", { name: /Third task/ }));
    expect(addButton()).toBeEnabled();

    rerender(
      <TaskDetail task={{ ...first, updatedAt: "2026-05-02T00:00:00.000Z" }} {...props} initialEditing />,
    );
    expect(addButton()).toBeEnabled();

    rerender(<TaskDetail task={second} {...props} initialEditing />);
    expect(addButton()).toBeDisabled();
  });

  it("closes an open delete confirmation when the id changes and keeps it on a same-id re-render", async () => {
    const props = { ...baseProps, isProjectAdmin: true };
    const { rerender } = render(<TaskDetail task={first} {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete task" }));
    expect(screen.getByText(/will be permanently removed/)).toBeInTheDocument();

    rerender(
      <TaskDetail task={{ ...first, updatedAt: "2026-05-02T00:00:00.000Z" }} {...props} />,
    );
    expect(screen.getByText(/will be permanently removed/)).toBeInTheDocument();

    rerender(<TaskDetail task={second} {...props} />);
    expect(screen.queryByText(/will be permanently removed/)).not.toBeInTheDocument();
  });

  it("closes an open discard confirmation when the id changes and keeps it on a same-id re-render", async () => {
    const backlogA = makeTask({ status: "backlog" });
    const backlogB = makeTask({ id: "task-2", title: "Second task", status: "backlog" });
    const { rerender } = render(<TaskDetail task={backlogA} {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /Discard/ }));
    expect(screen.getByText(/will be marked abandoned/)).toBeInTheDocument();

    rerender(
      <TaskDetail task={{ ...backlogA, updatedAt: "2026-05-02T00:00:00.000Z" }} {...baseProps} />,
    );
    expect(screen.getByText(/will be marked abandoned/)).toBeInTheDocument();

    rerender(<TaskDetail task={backlogB} {...baseProps} />);
    expect(screen.queryByText(/will be marked abandoned/)).not.toBeInTheDocument();
  });

  describe("expanded result", () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    beforeEach(() => {
      // jsdom has no layout: report an overflowing result box so the
      // Show more toggle renders.
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get: () => 500,
      });
    });
    afterEach(() => {
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    });

    it("collapses when the id changes and stays expanded on a same-id re-render", async () => {
      const a = makeTask({ result: "Long result A" });
      const b = makeTask({ id: "task-2", title: "Second task", result: "Long result B" });
      const { rerender } = render(<TaskDetail task={a} {...baseProps} />);
      await userEvent.click(screen.getByRole("button", { name: "Show more" }));
      expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();

      rerender(<TaskDetail task={{ ...a, updatedAt: "2026-05-02T00:00:00.000Z" }} {...baseProps} />);
      expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();

      rerender(<TaskDetail task={b} {...baseProps} />);
      expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();
    });
  });
});
