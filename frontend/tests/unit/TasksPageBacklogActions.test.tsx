/** @vitest-environment jsdom */
/**
 * /tasks table -- backlog Promote/Discard row actions
 * (buildTaskPageColumns, src/app/tasks/_components/columns.tsx).
 *
 * Contract:
 *   - Promote/Discard render ONLY for a backlog-status row; a non-backlog
 *     row (e.g. open) must not show either button. This is the assertion
 *     the task's mutation probe (inverting/removing the visibility guard)
 *     is expected to turn red.
 *   - Clicking Promote calls onPromote with the row's task; clicking
 *     Discard calls onDiscard with the row's task.
 *   - Both buttons are disabled while busyTaskId matches the row.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildTaskPageColumns, type EnrichedTask } from "../../src/app/tasks/_components/columns";
import type { Task } from "../../src/lib/api";

function task(over: Partial<Task> & { id: string; title: string; status: string }): EnrichedTask {
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
    attachments: [],
    projectName: "Demo project",
    ...over,
  } as EnrichedTask;
}

function renderActionsCell(t: EnrichedTask, handlers: Partial<Parameters<typeof buildTaskPageColumns>[0]> = {}) {
  const onPromote = handlers.onPromote ?? vi.fn();
  const onDiscard = handlers.onDiscard ?? vi.fn();
  const cols = buildTaskPageColumns({
    onPromote,
    onDiscard,
    busyTaskId: handlers.busyTaskId ?? null,
  });
  const col = cols.find((c) => c.key === "backlogActions");
  if (!col?.render) throw new Error("backlogActions column has no render function");
  render(<>{col.render(t)}</>);
  return { onPromote, onDiscard };
}

describe("/tasks backlog row actions", () => {
  it("renders Promote and Discard for a backlog task", () => {
    renderActionsCell(task({ id: "b-1", title: "Draft task", status: "backlog" }));
    expect(screen.getByRole("button", { name: "Promote" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  it("does not render Promote/Discard for a non-backlog (e.g. open) task", () => {
    renderActionsCell(task({ id: "o-1", title: "Open task", status: "open" }));
    expect(screen.queryByRole("button", { name: "Promote" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
  });

  it("clicking Promote calls onPromote with the row's task", async () => {
    const t = task({ id: "b-2", title: "Draft task 2", status: "backlog" });
    const { onPromote } = renderActionsCell(t);
    await userEvent.click(screen.getByRole("button", { name: "Promote" }));
    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(onPromote).toHaveBeenCalledWith(t);
  });

  it("clicking Discard calls onDiscard with the row's task", async () => {
    const t = task({ id: "b-3", title: "Draft task 3", status: "backlog" });
    const { onDiscard } = renderActionsCell(t);
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledWith(t);
  });

  it("disables both buttons while the row's task is busy", () => {
    const t = task({ id: "b-4", title: "Draft task 4", status: "backlog" });
    renderActionsCell(t, { busyTaskId: "b-4" });
    expect(screen.getByRole("button", { name: "Promote" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });
});
