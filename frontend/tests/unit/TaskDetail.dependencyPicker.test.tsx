/** @vitest-environment jsdom */
/**
 * TaskDetail dependency picker (task 7c6768d4): in edit mode the "Add blocker"
 * control is a searchable text-input combobox, so tasks with the same title can
 * be found by their id prefix.
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

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Main task",
    description: "Some description",
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

const baseProps = {
  tasks: [] as Task[],
  user: null,
  templateFields: null,
  confidenceThreshold: 60,
  enforcementMode: null,
  onUpdate: () => {},
  onDelete: () => {},
  onClose: () => {},
  onError: () => {},
};


describe("TaskDetail dependency picker", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  const twinA = makeTask({ id: "3f2a91c0-7b1e-4d2a-9add-0c5e8f1b2a33", title: "Fix login", status: "open" });
  const twinB = makeTask({ id: "8c1d0e4f-2a3b-4c5d-8e6f-7a8b9c0d1e2f", title: "Fix login", status: "done" });

  function renderEdit() {
    return render(
      <TaskDetail task={makeTask()} {...baseProps} tasks={[makeTask(), twinA, twinB]} initialEditing />,
    );
  }

  it("is a text-input combobox named 'Add blocker'", () => {
    renderEdit();
    const input = screen.getByRole("combobox", { name: "Add blocker" });
    expect(input.tagName).toBe("INPUT");
  });

  it("an 8-char id prefix lists exactly that task, with id prefix and status in the option", async () => {
    renderEdit();
    const input = screen.getByRole("combobox", { name: "Add blocker" });
    await userEvent.type(input, "8c1d0e4f");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Fix login");
    expect(options[0].textContent).toContain("8c1d0e4f · done");
  });

  it("the shared title lists both twins, told apart by id prefix", async () => {
    renderEdit();
    await userEvent.type(screen.getByRole("combobox", { name: "Add blocker" }), "fix");
    const texts = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes("3f2a91c0 · open"))).toBe(true);
    expect(texts.some((t) => t.includes("8c1d0e4f · done"))).toBe(true);
  });
});
