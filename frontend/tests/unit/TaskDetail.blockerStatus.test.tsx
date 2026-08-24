/** @vitest-environment jsdom */
/**
 * TaskDetail blocker status rendering: abandoned blockers should render
 * as non-blocking (done status dot), just like resolved blockers.
 * This test verifies AC1 at both render sites (edit and view mode).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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

describe("TaskDetail — blocker status rendering", () => {
  describe("edit mode (initialEditing) — blockedBy list", () => {
    it("renders abandoned blocker as done (non-blocking)", () => {
      const blockedByList = [
        {
          id: "blocker-1",
          title: "Abandoned task",
          status: "abandoned",
        },
      ];

      const { container } = render(
        <TaskDetail
          task={makeTask({ blockedBy: blockedByList })}
          {...baseProps}
          initialEditing
        />
      );

      // Find the row for the abandoned blocker in edit mode
      const editRows = Array.from(
        container.querySelectorAll(".td-dep-edit-row")
      );
      const abandonedRow = editRows.find((row) =>
        row.textContent?.includes("Abandoned task")
      );

      expect(abandonedRow).toBeTruthy();
      if (abandonedRow) {
        const dot = abandonedRow.querySelector(".td-dep-status-dot");
        expect(dot).toHaveClass("td-dep-status-dot--done");
        expect(dot).not.toHaveClass("td-dep-status-dot--blocked");
      }
    });

    it("renders open blocker as blocked", () => {
      const blockedByList = [
        {
          id: "blocker-1",
          title: "Open task",
          status: "open",
        },
      ];

      const { container } = render(
        <TaskDetail
          task={makeTask({ blockedBy: blockedByList })}
          {...baseProps}
          initialEditing
        />
      );

      // Find the row for the open blocker in edit mode
      const editRows = Array.from(
        container.querySelectorAll(".td-dep-edit-row")
      );
      const openRow = editRows.find((row) =>
        row.textContent?.includes("Open task")
      );

      expect(openRow).toBeTruthy();
      if (openRow) {
        const dot = openRow.querySelector(".td-dep-status-dot");
        expect(dot).toHaveClass("td-dep-status-dot--blocked");
        expect(dot).not.toHaveClass("td-dep-status-dot--done");
      }
    });

    it("renders done blocker as done (non-blocking)", () => {
      const blockedByList = [
        {
          id: "blocker-1",
          title: "Done task",
          status: "done",
        },
      ];

      const { container } = render(
        <TaskDetail
          task={makeTask({ blockedBy: blockedByList })}
          {...baseProps}
          initialEditing
        />
      );

      // Find the row for the done blocker in edit mode
      const editRows = Array.from(
        container.querySelectorAll(".td-dep-edit-row")
      );
      const doneRow = editRows.find((row) =>
        row.textContent?.includes("Done task")
      );

      expect(doneRow).toBeTruthy();
      if (doneRow) {
        const dot = doneRow.querySelector(".td-dep-status-dot");
        expect(dot).toHaveClass("td-dep-status-dot--done");
        expect(dot).not.toHaveClass("td-dep-status-dot--blocked");
      }
    });
  });

  describe("view mode — blockedBy list", () => {
    it("renders abandoned blocker as done (non-blocking)", async () => {
      const blockedByList = [
        {
          id: "blocker-1",
          title: "Abandoned task",
          status: "abandoned",
        },
      ];

      const { container } = render(
        <TaskDetail
          task={makeTask({ blockedBy: blockedByList })}
          {...baseProps}
        />
      );

      // Click the Dependencies button to expand the collapsible section
      const user = userEvent.setup();
      const dependenciesButton = screen.getByRole("button", {
        name: /dependencies/i,
      });
      await user.click(dependenciesButton);

      // Wait for the row to appear and find it
      await waitFor(() => {
        const viewRows = Array.from(
          container.querySelectorAll(".td-dep-view-row")
        );
        const found = viewRows.find((row) =>
          row.textContent?.includes("Abandoned task")
        );
        expect(found).toBeTruthy();
      });

      const viewRows = Array.from(
        container.querySelectorAll(".td-dep-view-row")
      );
      const abandonedRow = viewRows.find((row) =>
        row.textContent?.includes("Abandoned task")
      );

      if (abandonedRow) {
        const dot = abandonedRow.querySelector(".td-dep-status-dot");
        expect(dot).toHaveClass("td-dep-status-dot--done");
        expect(dot).not.toHaveClass("td-dep-status-dot--blocked");
      }
    });

    it("renders open blocker as blocked", async () => {
      const blockedByList = [
        {
          id: "blocker-1",
          title: "Open task",
          status: "open",
        },
      ];

      const { container } = render(
        <TaskDetail
          task={makeTask({ blockedBy: blockedByList })}
          {...baseProps}
        />
      );

      // Click the Dependencies button to expand the collapsible section
      const user = userEvent.setup();
      const dependenciesButton = screen.getByRole("button", {
        name: /dependencies/i,
      });
      await user.click(dependenciesButton);

      // Wait for the row to appear and find it
      await waitFor(() => {
        const viewRows = Array.from(
          container.querySelectorAll(".td-dep-view-row")
        );
        const found = viewRows.find((row) =>
          row.textContent?.includes("Open task")
        );
        expect(found).toBeTruthy();
      });

      const viewRows = Array.from(
        container.querySelectorAll(".td-dep-view-row")
      );
      const openRow = viewRows.find((row) =>
        row.textContent?.includes("Open task")
      );

      if (openRow) {
        const dot = openRow.querySelector(".td-dep-status-dot");
        expect(dot).toHaveClass("td-dep-status-dot--blocked");
        expect(dot).not.toHaveClass("td-dep-status-dot--done");
      }
    });

    it("renders done blocker as done (non-blocking)", async () => {
      const blockedByList = [
        {
          id: "blocker-1",
          title: "Done task",
          status: "done",
        },
      ];

      const { container } = render(
        <TaskDetail
          task={makeTask({ blockedBy: blockedByList })}
          {...baseProps}
        />
      );

      // Click the Dependencies button to expand the collapsible section
      const user = userEvent.setup();
      const dependenciesButton = screen.getByRole("button", {
        name: /dependencies/i,
      });
      await user.click(dependenciesButton);

      // Wait for the row to appear and find it
      await waitFor(() => {
        const viewRows = Array.from(
          container.querySelectorAll(".td-dep-view-row")
        );
        const found = viewRows.find((row) =>
          row.textContent?.includes("Done task")
        );
        expect(found).toBeTruthy();
      });

      const viewRows = Array.from(
        container.querySelectorAll(".td-dep-view-row")
      );
      const doneRow = viewRows.find((row) =>
        row.textContent?.includes("Done task")
      );

      if (doneRow) {
        const dot = doneRow.querySelector(".td-dep-status-dot");
        expect(dot).toHaveClass("td-dep-status-dot--done");
        expect(dot).not.toHaveClass("td-dep-status-dot--blocked");
      }
    });
  });
});
