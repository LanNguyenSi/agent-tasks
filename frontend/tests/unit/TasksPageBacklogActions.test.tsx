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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTaskPageColumns,
  TASK_PAGE_COLUMNS,
  type EnrichedTask,
} from "../../src/app/tasks/_components/columns";
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

function renderActionsCell(
  t: EnrichedTask,
  handlers: Partial<Parameters<typeof buildTaskPageColumns>[0]> = {},
  rows: EnrichedTask[] = [t],
) {
  const onPromote = handlers.onPromote ?? vi.fn();
  const onDiscard = handlers.onDiscard ?? vi.fn();
  const cols = buildTaskPageColumns(
    {
      onPromote,
      onDiscard,
      busyTaskId: handlers.busyTaskId ?? null,
    },
    rows,
  );
  const col = cols.find((c) => c.key === "backlogActions");
  render(<>{col?.render ? col.render(t) : null}</>);
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

  describe("buildTaskPageColumns -- conditional backlogActions column", () => {
    it("omits the backlogActions column when no rendered row is backlog", () => {
      const rows = [task({ id: "o-1", title: "Open task", status: "open" })];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), busyTaskId: null },
        rows,
      );
      expect(cols.find((c) => c.key === "backlogActions")).toBeUndefined();
      expect(cols).toHaveLength(TASK_PAGE_COLUMNS.length);
    });

    it("includes the backlogActions column, with a visually-hidden accessible header, when a rendered row is backlog", () => {
      const rows = [
        task({ id: "o-1", title: "Open task", status: "open" }),
        task({ id: "b-1", title: "Draft task", status: "backlog" }),
      ];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), busyTaskId: null },
        rows,
      );
      const col = cols.find((c) => c.key === "backlogActions");
      expect(col).toBeDefined();
      expect(col?.header).toBe("Backlog actions");
      expect(col?.headerVisuallyHidden).toBe(true);
      expect(cols).toHaveLength(TASK_PAGE_COLUMNS.length + 1);
    });

    // Regression test for the clipped-Discard-button bug (operator report
    // 2026-08-20): the /tasks table uses table-layout: fixed once any
    // column declares a width (globals.css .table--fixed), so declared
    // percentage widths are binding. If they summed to more than 100%, the
    // browser scales every column down proportionally, shrinking the
    // trailing actions column enough to clip its Promote/Discard buttons.
    // Pin the present-case (backlog row -> backlogActions column appended)
    // sum at exactly 100 so a future width edit that reintroduces overflow
    // fails loudly here instead of only showing up as a visual clip.
    it("sums declared column widths to exactly 100% when the backlogActions column is present", () => {
      const rows = [task({ id: "b-1", title: "Draft task", status: "backlog" })];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), busyTaskId: null },
        rows,
      );
      const total = cols.reduce((sum, c) => {
        const pct = c.width ? parseFloat(c.width) : 0;
        return sum + pct;
      }, 0);
      expect(total).toBe(100);
    });
  });

  // Regression test for the same clipped-Discard-button bug, second half: at
  // <=1200px the Updated column is hidden (globals.css, "Hide the Updated
  // column" media query) without the remaining columns being renormalized
  // to 100%, so the backlogActions column can still be too narrow for two
  // sm buttons side by side. .tasks-row-actions must wrap (stack Promote
  // above Discard) instead of overflowing the fixed-width cell -- verified
  // visually via a full-CSS repro render at 1000px (see task report); this
  // pins the CSS declaration mechanically so a future edit that drops the
  // wrap fails loudly here too.
  it("wraps the backlog row actions instead of letting them overflow their fixed-width cell", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const match = css.match(/\.tasks-row-actions\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/flex-wrap:\s*wrap/);
  });
});
