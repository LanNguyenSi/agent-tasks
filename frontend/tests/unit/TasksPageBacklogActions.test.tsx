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
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  buildTaskPageColumns,
  TASK_PAGE_COLUMNS,
  type EnrichedTask,
} from "../../src/app/tasks/_components/columns";
import { Table } from "../../src/components/ui/Table";
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
    // Before summing, validate that every column width is a percentage
    // (not px or missing), so a width-less or incorrectly-typed column
    // gets caught.
    it("sums declared column widths to exactly 100% when the backlogActions column is present", () => {
      const rows = [task({ id: "b-1", title: "Draft task", status: "backlog" })];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), busyTaskId: null },
        rows,
      );
      // Assert each column has a width and it's in percentage format.
      for (const col of cols) {
        expect(col.width, `Column "${col.key}" must have a width`).toBeDefined();
        expect(col.width, `Column "${col.key}" width must be a percentage (e.g., "34%")`).toMatch(
          /^\d+(\.\d+)?%$/,
        );
      }
      const total = cols.reduce((sum, c) => {
        const pct = parseFloat(c.width!);
        return sum + pct;
      }, 0);
      expect(total).toBe(100);
    });

    // Regression test for the same clipped-Discard-button bug, second half:
    // .tasks-row-actions must use flex-wrap: wrap so buttons stack instead of
    // overflowing their fixed-width cell. This pins the CSS mechanically so a
    // future edit that drops flex-wrap or changes it to nowrap fails loudly.
    // Check ALL .tasks-row-actions blocks (including any in media queries) to
    // ensure none override wrap to nowrap.
    it("pins .tasks-row-actions flex-wrap behavior via CSS", () => {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const css = readFileSync(join(__dirname, "../../src/app/globals.css"), "utf8");
      const matches = [...css.matchAll(/\.tasks-row-actions\s*\{([^}]*)\}/g)];
      expect(matches.length, ".tasks-row-actions must be defined at least once").toBeGreaterThan(0);
      // First block (base case) must have flex-wrap: wrap AND justify-content: flex-end.
      const firstBlock = matches[0]?.[1];
      expect(firstBlock).toBeDefined();
      expect(firstBlock, "First .tasks-row-actions must have flex-wrap: wrap").toMatch(
        /flex-wrap:\s*wrap/,
      );
      expect(firstBlock, "First .tasks-row-actions must have justify-content: flex-end").toMatch(
        /justify-content:\s*flex-end/,
      );
      // No block (base or in media queries) should have flex-wrap: nowrap.
      for (const match of matches) {
        const block = match[1];
        expect(
          block,
          "No .tasks-row-actions block should have flex-wrap: nowrap",
        ).not.toMatch(/flex-wrap:\s*nowrap/);
      }
    });

    // Regression test: when no backlog row exists, buildTaskPageColumns must
    // return the IDENTICAL reference to TASK_PAGE_COLUMNS, not a shallow copy
    // or remapped array. This pins the no-backlog path as untouched by
    // construction (the width rebalance only applies in the present case).
    it("returns the exact TASK_PAGE_COLUMNS reference when no backlog row is present", () => {
      const rows = [task({ id: "o-1", title: "Open task", status: "open" })];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), busyTaskId: null },
        rows,
      );
      expect(cols).toBe(TASK_PAGE_COLUMNS);
    });

    // Regression test for the empty "BACKLOG ACTIONS:" label in card mode
    // (<=900px, operator report 2026-08-21): a mixed /tasks page renders the
    // backlogActions column (appended once any row is backlog) for EVERY
    // row, but its render() returns null for a non-backlog row (see above).
    // The stacked-mode CSS (globals.css) prints a `data-label` prefix via
    // `::before` on every non-first .table-td, so a non-backlog row showed
    // an empty "BACKLOG ACTIONS: " line. The fix suppresses the prefix with
    // a `:not(:first-child):empty::before { content: none; }` rule, which
    // only fires when the <td> truly has no child nodes. This first
    // assertion pins the DOM precondition the CSS relies on: the cell must
    // render with zero children (not e.g. an empty string or whitespace
    // node) for a non-backlog row, same as `col.render(t)` returning null
    // does today.
    it("renders an empty <td> (zero child nodes) for the backlogActions cell of a non-backlog row", () => {
      // The :empty CSS suppression depends on a DOM fact about Table.tsx:
      // the <td> must end up with literally no child nodes when render()
      // returns null. Mount the real Table so a cell-wrapper refactor
      // (e.g. wrapping every cell in a span) fails here instead of
      // silently reintroducing the empty "BACKLOG ACTIONS: " label.
      const rows = [
        task({ id: "o-1", title: "Open task", status: "open" }),
        task({ id: "b-1", title: "Draft task", status: "backlog" }),
      ];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), busyTaskId: null },
        rows,
      );
      const { container } = render(
        <Table columns={cols} rows={rows} rowKey={(r) => r.id} />,
      );
      const tds = container.querySelectorAll('td[data-col="backlogActions"]');
      expect(tds).toHaveLength(2);
      expect(tds[0]!.childNodes.length).toBe(0);
      expect(tds[1]!.childNodes.length).toBeGreaterThan(0);
    });

    // Pins the CSS suppression rule itself so a future edit that drops or
    // weakens it (e.g. removing the `:empty` qualifier, or the rule
    // entirely) fails loudly here instead of only showing up as a visual
    // regression at <=900px. Only the default 900px stacked mode is pinned:
    // late-stack tables now DO enter stacked mode below 720px (see
    // LateStackTableCss.test.ts, task 125ad0f9), but neither workflow
    // late-stack table (StatesTable, TransitionsTable) has a column whose
    // render() can return null, so no empty <td> ever occurs there and the
    // (unscoped, source-order-losing) label rule in the late-stack 720px
    // block staying un-suppressed for :empty cells is currently inert in
    // practice. This test only covers /tasks (the default stacked mode).
    it("pins the empty-cell label suppression (:empty::before { content: none }) via CSS", () => {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const css = readFileSync(join(__dirname, "../../src/app/globals.css"), "utf8");

      const defaultRule =
        /^\s*\.table-td:not\(:first-child\):empty::before\s*\{\s*content:\s*none\s*;?\s*\}/m;
      expect(css, "default 900px stacked mode must suppress the label on empty cells").toMatch(
        defaultRule,
      );
    });
  });
});
