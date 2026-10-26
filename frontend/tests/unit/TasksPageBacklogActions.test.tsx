/** @vitest-environment jsdom */
/**
 * /tasks table -- row actions behind one "..." menu per row
 * (buildTaskPageColumns, src/app/tasks/_components/columns.tsx).
 *
 * Contract:
 *   - A row has exactly one trigger ("Actions for <title>"); the actions
 *     (Promote, Discard) render ONLY inside its menu, ONLY for a backlog
 *     row; a non-backlog row (e.g. open) must not offer either.
 *   - "Move to backlog" (demote) is offered ONLY for an open row; while the
 *     row holds a work or review claim the menu shows the reason as disabled
 *     text instead of an actionable item.
 *   - Activating an item calls the matching handler with the row's task.
 *   - All items are disabled while busyTaskId matches the row.
 *   - The menu is keyboard operable: Enter opens it from the trigger, the
 *     first item receives focus, ArrowDown moves, Escape closes; after an
 *     item runs, focus is back on the trigger.
 *   - Menu semantics: the trigger has aria-haspopup="menu", the items
 *     (including the claim hint) are menuitems inside one role="menu"
 *     named "Actions for <title>".
 *   - No column declares a width, so the Table primitive keeps the /tasks
 *     table in auto layout (Project/Due/Updated shrink to content, the Task
 *     column takes the free width; pinned with the CSS below).
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

// The row-level tests below mount the Table with rowHref, so the title cell
// renders a next/link and a row click is a navigation. next/link and
// next/navigation become the fake router of tests/setup/fakeNavigation (a
// link click is a router.push), which is how those tests detect navigation.
vi.mock("next/navigation", async () => {
  const m = await import("../setup/fakeNavigation");
  return { usePathname: m.usePathname, useRouter: m.useRouter, useSearchParams: m.useSearchParams };
});
vi.mock("next/link", async () => ({
  default: (await import("../setup/fakeNavigation")).FakeLink,
}));
import { nav, router } from "../setup/fakeNavigation";

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

type Spy = Mock<(task: EnrichedTask) => void>;

interface RenderedRow {
  onPromote: Spy;
  onDiscard: Spy;
  onDemote: Spy;
}

function makeSpies(): RenderedRow {
  return { onPromote: vi.fn(), onDiscard: vi.fn(), onDemote: vi.fn() };
}

/** The columns with the rowActions column for `rows` and `spies` wired in. */
function columnsFor(spies: RenderedRow, rows: EnrichedTask[], busyTaskId: string | null) {
  return buildTaskPageColumns(
    {
      onPromote: spies.onPromote,
      onDiscard: spies.onDiscard,
      onDemote: spies.onDemote,
      busyTaskId,
    },
    rows,
  );
}

/** Render one row's actions cell (the trigger; the panel only while open). */
function renderActionsCell(
  t: EnrichedTask,
  opts: { busyTaskId?: string | null } = {},
  rows: EnrichedTask[] = [t],
): RenderedRow {
  const spies = makeSpies();
  const cols = columnsFor(spies, rows, opts.busyTaskId ?? null);
  const col = cols.find((c) => c.key === "rowActions");
  render(<>{col?.render ? col.render(t) : null}</>);
  return spies;
}

/** The row's single "..." trigger. */
function trigger(t: EnrichedTask): HTMLElement {
  return screen.getByRole("button", { name: `Actions for ${t.title}` });
}

/** The open panel: DropdownMenu portals .app-dropdown-menu to document.body. */
async function menuPanel(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(".app-dropdown-menu")).not.toBeNull());
  return document.querySelector(".app-dropdown-menu") as HTMLElement;
}

/** Render the row and open its menu (the panel starts with no selection). */
async function openMenu(
  t: EnrichedTask,
  opts: { busyTaskId?: string | null } = {},
  rows: EnrichedTask[] = [t],
): Promise<{ panel: HTMLElement } & RenderedRow> {
  const spies = renderActionsCell(t, opts, rows);
  await userEvent.click(trigger(t));
  const panel = await menuPanel();
  return { panel, ...spies };
}

describe("/tasks row actions menu", () => {
  it("renders exactly one trigger per actionable row and no bare action buttons", () => {
    const t = task({ id: "b-1", title: "Draft task", status: "backlog" });
    renderActionsCell(t);
    expect(trigger(t)).toBeInTheDocument();
    expect(screen.queryByText("Promote")).not.toBeInTheDocument();
    expect(screen.queryByText("Discard")).not.toBeInTheDocument();
  });

  it("offers Promote and Discard in the menu of a backlog row", async () => {
    const t = task({ id: "b-1", title: "Draft task", status: "backlog" });
    const { panel } = await openMenu(t);
    expect(within(panel).getByRole("menuitem", { name: "Promote" })).toBeInTheDocument();
    expect(within(panel).getByRole("menuitem", { name: "Discard" })).toBeInTheDocument();
  });

  it("does not offer Promote or Discard in the menu of a non-backlog (e.g. open) row", async () => {
    const t = task({ id: "o-1", title: "Open task", status: "open" });
    const { panel } = await openMenu(t);
    expect(within(panel).queryByRole("menuitem", { name: "Promote" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("menuitem", { name: "Discard" })).not.toBeInTheDocument();
  });

  it("clicking Promote calls onPromote with the row's task", async () => {
    const t = task({ id: "b-2", title: "Draft task 2", status: "backlog" });
    const { panel, onPromote } = await openMenu(t);
    await userEvent.click(within(panel).getByRole("menuitem", { name: "Promote" }));
    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(onPromote).toHaveBeenCalledWith(t);
  });

  it("clicking Discard calls onDiscard with the row's task", async () => {
    const t = task({ id: "b-3", title: "Draft task 3", status: "backlog" });
    const { panel, onDiscard } = await openMenu(t);
    await userEvent.click(within(panel).getByRole("menuitem", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledWith(t);
  });

  it("disables all items while the row's task is busy", async () => {
    const t = task({ id: "b-4", title: "Draft task 4", status: "backlog" });
    const { panel } = await openMenu(t, { busyTaskId: "b-4" });
    expect(within(panel).getByRole("menuitem", { name: "Promote" })).toBeDisabled();
    expect(within(panel).getByRole("menuitem", { name: "Discard" })).toBeDisabled();
  });

  describe("keyboard operation", () => {
    it("Enter on the trigger opens the menu and focuses the first item", async () => {
      const t = task({ id: "b-5", title: "Draft task 5", status: "backlog" });
      renderActionsCell(t);
      trigger(t).focus();
      await userEvent.keyboard("{Enter}");
      const panel = await menuPanel();
      expect(within(panel).getByRole("menuitem", { name: "Promote" })).toHaveFocus();
    });

    it("ArrowDown moves between items and Enter activates the focused one", async () => {
      const t = task({ id: "b-6", title: "Draft task 6", status: "backlog" });
      const { onPromote, onDiscard } = await openMenu(t);
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toHaveTextContent("Discard");
      await userEvent.keyboard("{Enter}");
      expect(onDiscard).toHaveBeenCalledTimes(1);
      expect(onDiscard).toHaveBeenCalledWith(t);
      expect(onPromote).not.toHaveBeenCalled();
    });

    it("Escape closes the menu and returns focus to the trigger", async () => {
      const t = task({ id: "b-7", title: "Draft task 7", status: "backlog" });
      await openMenu(t);
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(document.querySelector(".app-dropdown-menu")).toBeNull());
      expect(trigger(t)).toHaveFocus();
    });

    it("Enter on an item runs it, closes the menu and returns focus to the trigger", async () => {
      const t = task({ id: "b-8", title: "Draft task 8", status: "backlog" });
      const spies = renderActionsCell(t);
      trigger(t).focus();
      await userEvent.keyboard("{Enter}");
      const panel = await menuPanel();
      expect(within(panel).getByRole("menuitem", { name: "Promote" })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(spies.onPromote).toHaveBeenCalledWith(t);
      await waitFor(() => expect(document.querySelector(".app-dropdown-menu")).toBeNull());
      expect(trigger(t)).toHaveFocus();
    });

    it("a click on Move to backlog also returns focus to the trigger", async () => {
      const t = task({ id: "o-8", title: "Open task 8", status: "open" });
      const { panel, onDemote } = await openMenu(t);
      await userEvent.click(within(panel).getByRole("menuitem", { name: "Move to backlog" }));
      expect(onDemote).toHaveBeenCalledWith(t);
      await waitFor(() => expect(document.querySelector(".app-dropdown-menu")).toBeNull());
      expect(trigger(t)).toHaveFocus();
    });
  });

  describe("menu semantics", () => {
    it("the trigger announces a menu popup", () => {
      const t = task({ id: "b-9", title: "Draft task 9", status: "backlog" });
      renderActionsCell(t);
      expect(trigger(t)).toHaveAttribute("aria-haspopup", "menu");
    });

    it("Promote and Discard are menuitems of one menu named after the task", async () => {
      const t = task({ id: "b-10", title: "Draft task 10", status: "backlog" });
      const { panel } = await openMenu(t);
      const menu = within(panel).getByRole("menu", { name: "Actions for Draft task 10" });
      expect(within(menu).getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
        "Promote",
        "Discard",
      ]);
    });

    it("Move to backlog is a menuitem of the menu", async () => {
      const t = task({ id: "o-10", title: "Open task 10", status: "open" });
      const { panel } = await openMenu(t);
      const item = within(panel).getByRole("menuitem", { name: "Move to backlog" });
      expect(item.closest('[role="menu"]')).toHaveAttribute("aria-label", "Actions for Open task 10");
    });

    it("the claim hint sits inside the menu (a menuitem needs a menu parent)", async () => {
      const t = task({ id: "o-11", title: "Claimed task 11", status: "open", claimedByUserId: "u-1" });
      const { panel } = await openMenu(t);
      const hint = within(panel).getByRole("menuitem", { name: /Release the claim/ });
      expect(hint.closest('[role="menu"]')).not.toBeNull();
      expect(hint.closest('[role="menu"]')).toHaveAttribute("aria-label", "Actions for Claimed task 11");
    });
  });

  describe("Move to backlog (demote) on open rows", () => {
    const HINT = "Release the claim before moving this task back to backlog";

    it("offers Move to backlog, and neither Promote nor Discard, in the menu of an open unclaimed task", async () => {
      const t = task({ id: "o-1", title: "Open task", status: "open" });
      const { panel } = await openMenu(t);
      expect(within(panel).getByRole("menuitem", { name: "Move to backlog" })).toBeEnabled();
      expect(within(panel).queryByRole("menuitem", { name: "Promote" })).not.toBeInTheDocument();
      expect(within(panel).queryByRole("menuitem", { name: "Discard" })).not.toBeInTheDocument();
    });

    it.each(["in_progress", "review", "done", "abandoned"])(
      "renders no trigger at all for a %s task",
      (status) => {
        const t = task({ id: "x-1", title: "Other task", status });
        renderActionsCell(t);
        expect(screen.queryByRole("button", { name: `Actions for ${t.title}` })).not.toBeInTheDocument();
      },
    );

    it("clicking Move to backlog calls onDemote with the row's task", async () => {
      const t = task({ id: "o-2", title: "Open task 2", status: "open" });
      const { panel, onDemote, onPromote, onDiscard } = await openMenu(t);
      await userEvent.click(within(panel).getByRole("menuitem", { name: "Move to backlog" }));
      expect(onDemote).toHaveBeenCalledTimes(1);
      expect(onDemote).toHaveBeenCalledWith(t);
      expect(onPromote).not.toHaveBeenCalled();
      expect(onDiscard).not.toHaveBeenCalled();
    });

    it.each([
      ["work claim by a user", { claimedByUserId: "u-1" }],
      ["work claim by an agent", { claimedByAgentId: "a-1" }],
      ["review claim by a user", { reviewClaimedByUserId: "u-2" }],
      ["review claim by an agent", { reviewClaimedByAgentId: "a-2" }],
    ])("shows the reason as disabled text (no action) for an open task with a %s", async (_label, claim) => {
      const t = task({ id: "o-3", title: "Claimed open task", status: "open", ...claim } as Partial<Task> & {
        id: string;
        title: string;
        status: string;
      });
      const { panel, onDemote } = await openMenu(t);
      expect(within(panel).queryByRole("menuitem", { name: "Move to backlog" })).not.toBeInTheDocument();
      const note = within(panel).getByText(new RegExp(HINT));
      expect(note).toHaveAttribute("title", HINT);
      await userEvent.click(note);
      expect(onDemote).not.toHaveBeenCalled();
    });

    it("disables Move to backlog while the row's task is busy", async () => {
      const t = task({ id: "o-4", title: "Open task 4", status: "open" });
      const { panel } = await openMenu(t, { busyTaskId: "o-4" });
      expect(within(panel).getByRole("menuitem", { name: "Move to backlog" })).toBeDisabled();
    });
  });

  // The menu panel is portaled to document.body, but React events bubble
  // through the portal to the owning table row, which navigates on click and
  // on Enter (Table.tsx row link) unless it ignores events from outside its
  // own DOM. These tests mount the REAL Table with rowHref plus the
  // rowActions column (like page.tsx) and pin that nothing inside the open
  // menu navigates that row: the fake router must never be called, and the
  // row must never be treated as clicked.
  describe("inside a real table row (rowHref)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      nav.reset("/tasks?scope=all&status=backlog");
    });

    /** Render one task in the real Table with the page's rowHref. */
    function renderRow(t: EnrichedTask): RenderedRow {
      const spies = makeSpies();
      render(
        <Table
          columns={columnsFor(spies, [t], null)}
          rows={[t]}
          rowKey={(r) => r.id}
          rowHref={(r) => `/tasks/${r.id}?from=/tasks`}
        />,
      );
      return spies;
    }

    /** Open the row's menu with the keyboard (the trigger itself). */
    async function openByKeyboard(t: EnrichedTask): Promise<HTMLElement> {
      trigger(t).focus();
      await userEvent.keyboard("{Enter}");
      return menuPanel();
    }

    function expectNoNavigation(): void {
      expect(router.push).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
    }

    it("Enter opens the menu and Enter on Promote runs it without navigating the row", async () => {
      const t = task({ id: "r-1", title: "Row task", status: "backlog" });
      const spies = renderRow(t);
      const panel = await openByKeyboard(t);
      expect(within(panel).getByRole("menuitem", { name: "Promote" })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(spies.onPromote).toHaveBeenCalledTimes(1);
      expect(spies.onPromote).toHaveBeenCalledWith(t);
      expectNoNavigation();
    });

    it("Space on Promote runs it without navigating the row", async () => {
      const t = task({ id: "r-2", title: "Row task", status: "backlog" });
      const spies = renderRow(t);
      await openByKeyboard(t);
      await userEvent.keyboard(" ");
      expect(spies.onPromote).toHaveBeenCalledTimes(1);
      expect(spies.onPromote).toHaveBeenCalledWith(t);
      expectNoNavigation();
    });

    it("Enter on Move to backlog runs it without navigating the row", async () => {
      const t = task({ id: "r-3", title: "Open row task", status: "open" });
      const spies = renderRow(t);
      const panel = await openByKeyboard(t);
      expect(within(panel).getByRole("menuitem", { name: "Move to backlog" })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(spies.onDemote).toHaveBeenCalledTimes(1);
      expect(spies.onDemote).toHaveBeenCalledWith(t);
      expectNoNavigation();
    });

    it("Space on Move to backlog runs it without navigating the row", async () => {
      const t = task({ id: "r-4", title: "Open row task", status: "open" });
      const spies = renderRow(t);
      await openByKeyboard(t);
      await userEvent.keyboard(" ");
      expect(spies.onDemote).toHaveBeenCalledTimes(1);
      expect(spies.onDemote).toHaveBeenCalledWith(t);
      expectNoNavigation();
    });

    it("a mouse click on an item runs it without navigating the row", async () => {
      const t = task({ id: "r-5", title: "Row task", status: "backlog" });
      const spies = renderRow(t);
      await userEvent.click(trigger(t));
      const panel = await menuPanel();
      await userEvent.click(within(panel).getByRole("menuitem", { name: "Promote" }));
      expect(spies.onPromote).toHaveBeenCalledTimes(1);
      expectNoNavigation();
    });

    it("a click on the open panel's background neither runs an action nor navigates the row", async () => {
      const t = task({ id: "r-6", title: "Row task", status: "backlog" });
      const spies = renderRow(t);
      await userEvent.click(trigger(t));
      const panel = await menuPanel();
      await userEvent.click(panel);
      expect(spies.onPromote).not.toHaveBeenCalled();
      expect(spies.onDiscard).not.toHaveBeenCalled();
      expectNoNavigation();
    });

    it("a click on the disabled claim hint neither runs an action nor navigates the row", async () => {
      const t = task({ id: "r-7", title: "Claimed task", status: "open", claimedByAgentId: "a-1" });
      const spies = renderRow(t);
      await userEvent.click(trigger(t));
      const panel = await menuPanel();
      await userEvent.click(within(panel).getByText(/Release the claim/));
      expect(spies.onDemote).not.toHaveBeenCalled();
      expectNoNavigation();
    });

    it("keys reach document listeners while closed (global shortcuts) but not while open", async () => {
      const t = task({ id: "r-9", title: "Row task", status: "backlog" });
      renderRow(t);
      const seen: string[] = [];
      const listener = (e: globalThis.KeyboardEvent) => seen.push(e.key);
      document.addEventListener("keydown", listener);
      try {
        trigger(t).focus();
        await userEvent.keyboard("x");
        expect(seen).toContain("x");
        await userEvent.keyboard("{Enter}");
        await menuPanel();
        await userEvent.keyboard("y");
        expect(seen).not.toContain("y");
      } finally {
        document.removeEventListener("keydown", listener);
      }
    });

    it("with the menu closed, a click on the actions cell area still navigates the row", async () => {
      const t = task({ id: "r-10", title: "Row task", status: "backlog" });
      renderRow(t);
      await userEvent.click(document.querySelector(".tasks-row-actions") as HTMLElement);
      expect(router.push).toHaveBeenCalledWith("/tasks/r-10?from=/tasks");
    });

    it("the claim hint is a disabled menu item focus can land on, and Enter on it does nothing", async () => {
      const t = task({ id: "r-8", title: "Claimed task", status: "open", reviewClaimedByUserId: "u-2" });
      const spies = renderRow(t);
      trigger(t).focus();
      await userEvent.keyboard("{Enter}");
      const panel = await menuPanel();
      const hint = within(panel).getByRole("menuitem", { name: /Release the claim/ });
      expect(hint).toHaveAttribute("aria-disabled", "true");
      // The menu's only content, so opening lands on it, and the arrow keys
      // keep cycling onto it instead of leaving focus nowhere.
      await waitFor(() => expect(hint).toHaveFocus());
      await userEvent.keyboard("{ArrowDown}");
      expect(hint).toHaveFocus();
      await userEvent.keyboard("{ArrowUp}");
      expect(hint).toHaveFocus();
      // Enter does nothing: no action, the menu stays open, focus stays put.
      await userEvent.keyboard("{Enter}");
      expect(spies.onDemote).not.toHaveBeenCalled();
      expectNoNavigation();
      expect(document.querySelector(".app-dropdown-menu")).not.toBeNull();
      expect(hint).toHaveFocus();
    });
  });

  describe("buildTaskPageColumns -- conditional rowActions column", () => {
    it("omits the rowActions column when no rendered row is backlog or open", () => {
      const rows = [
        task({ id: "p-1", title: "Working task", status: "in_progress" }),
        task({ id: "d-1", title: "Done task", status: "done" }),
      ];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), onDemote: vi.fn(), busyTaskId: null },
        rows,
      );
      expect(cols.find((c) => c.key === "rowActions")).toBeUndefined();
      expect(cols).toHaveLength(TASK_PAGE_COLUMNS.length);
    });

    it("includes the rowActions column when the only actionable rows are open (Move to backlog)", () => {
      const rows = [
        task({ id: "o-1", title: "Open task", status: "open" }),
        task({ id: "p-1", title: "Working task", status: "in_progress" }),
      ];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), onDemote: vi.fn(), busyTaskId: null },
        rows,
      );
      expect(cols.find((c) => c.key === "rowActions")).toBeDefined();
    });

    it("includes the rowActions column, with a visually-hidden accessible header, when a rendered row is backlog", () => {
      const rows = [
        task({ id: "o-1", title: "Open task", status: "open" }),
        task({ id: "b-1", title: "Draft task", status: "backlog" }),
      ];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), onDemote: vi.fn(), busyTaskId: null },
        rows,
      );
      const col = cols.find((c) => c.key === "rowActions");
      expect(col).toBeDefined();
      expect(col?.header).toBe("Row actions");
      expect(col?.headerVisuallyHidden).toBe(true);
      expect(cols).toHaveLength(TASK_PAGE_COLUMNS.length + 1);
    });

    // AC: the Task column takes the free width and Project/Due/Updated
    // shrink to content. Mechanically: NO column declares a width, because
    // the Table primitive switches to table-layout: fixed as soon as one
    // does (globals.css .table--fixed), which turns percentages into binding
    // shares and takes the free width away from the title. Pin the
    // no-width contract for every column, with and without the rowActions
    // column, so a future width edit fails loudly here.
    it("declares no column width so the /tasks table stays in auto layout", () => {
      for (const col of TASK_PAGE_COLUMNS) {
        expect(col.width, `Column "${col.key}" must not declare a width`).toBeUndefined();
      }
      const rows = [task({ id: "b-1", title: "Draft task", status: "backlog" })];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), onDemote: vi.fn(), busyTaskId: null },
        rows,
      );
      for (const col of cols) {
        expect(col.width, `Column "${col.key}" must not declare a width`).toBeUndefined();
      }
      const { container } = render(<Table columns={cols} rows={rows} rowKey={(r) => r.id} />);
      expect(container.querySelector("table")).not.toHaveClass("table--fixed");
    });

    // Pins the CSS side of the same AC: the data cells never wrap at desktop
    // widths (so they shrink to content), the title wraps to two lines max,
    // and long project names truncate under a cap instead of stealing the
    // title's width.
    it("pins the task-list column CSS: nowrap data cells, two-line title clamp, capped project cell", () => {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const css = readFileSync(join(__dirname, "../../src/app/globals.css"), "utf8");

      const titleBlock = css.match(/\.tasks-table-region \.tasks-row-title\s*\{([^}]*)\}/);
      expect(titleBlock?.[1], "two-line clamp on the tasks title cell").toMatch(
        /-webkit-line-clamp:\s*2/,
      );
      expect(titleBlock?.[1], "the title must be able to wrap").toMatch(/white-space:\s*normal/);

      const desktop = css.match(/@media \(min-width: 901px\)[^{]*\{([\s\S]*?)\n\}/);
      expect(desktop?.[1], "desktop task-list block must exist").toBeDefined();
      expect(desktop?.[1], "data cells must not wrap").toMatch(
        /\.table-td:not\(\[data-col="title"\]\)\s*\{[^}]*white-space:\s*nowrap/,
      );
      expect(desktop?.[1], "the project cell must cap its width").toMatch(
        /\[data-col="project"\] \.table-cell-secondary\s*\{[^}]*max-width/,
      );
    });

    // Regression test: when no backlog row exists, buildTaskPageColumns must
    // return the IDENTICAL reference to TASK_PAGE_COLUMNS, not a shallow copy
    // or remapped array. This pins the no-action-row path as untouched by
    // construction.
    it("returns the exact TASK_PAGE_COLUMNS reference when no backlog or open row is present", () => {
      const rows = [task({ id: "p-1", title: "Working task", status: "in_progress" })];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), onDemote: vi.fn(), busyTaskId: null },
        rows,
      );
      expect(cols).toBe(TASK_PAGE_COLUMNS);
    });

    // Regression test for the empty "ROW ACTIONS:" label in card mode
    // (<=900px): a mixed /tasks page renders the rowActions column (appended
    // once any row is backlog or open) for EVERY row, but its render()
    // returns null for a non-actionable row. The stacked-mode CSS prints a
    // `data-label` prefix via `::before` on every non-first .table-td, so a
    // non-actionable row would show an empty label line. The fix suppresses
    // the prefix with a `:not(:first-child):empty::before { content: none; }`
    // rule, which only fires when the <td> truly has no child nodes. This
    // pins the DOM precondition the CSS relies on: the cell must render with
    // zero child nodes for a non-actionable row, same as `col.render(t)`
    // returning null does. Mount the real Table so a cell-wrapper refactor
    // fails here instead of silently reintroducing the empty label.
    it("renders an empty <td> (zero child nodes) for the rowActions cell of a non-actionable row", () => {
      const rows = [
        task({ id: "p-1", title: "Working task", status: "in_progress" }),
        task({ id: "b-1", title: "Draft task", status: "backlog" }),
      ];
      const cols = buildTaskPageColumns(
        { onPromote: vi.fn(), onDiscard: vi.fn(), onDemote: vi.fn(), busyTaskId: null },
        rows,
      );
      const { container } = render(
        <Table columns={cols} rows={rows} rowKey={(r) => r.id} />,
      );
      const tds = container.querySelectorAll('td[data-col="rowActions"]');
      expect(tds).toHaveLength(2);
      expect(tds[0]!.childNodes.length).toBe(0);
      expect(tds[1]!.childNodes.length).toBeGreaterThan(0);
    });

    // Pins the CSS suppression rule itself so a future edit that drops or
    // weakens it (e.g. removing the `:empty` qualifier, or the rule
    // entirely) fails loudly here instead of only showing up as a visual
    // regression at <=900px. Only the default 900px stacked mode is pinned
    // here; the late-stack 720px block now carries its own suppression rule
    // (see LateStackTableCss.test.ts, task 125ad0f9).
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

    // Regression test for the clipped-Discard-button bug family: the actions
    // wrapper keeps flex-wrap: wrap and right alignment so a future wider
    // trigger stacks instead of overflowing its cell, in every block.
    it("pins .tasks-row-actions flex-wrap behavior via CSS", () => {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const css = readFileSync(join(__dirname, "../../src/app/globals.css"), "utf8");
      const matches = [...css.matchAll(/\.tasks-row-actions\s*\{([^}]*)\}/g)];
      expect(matches.length, ".tasks-row-actions must be defined at least once").toBeGreaterThan(0);
      const firstBlock = matches[0]?.[1];
      expect(firstBlock).toBeDefined();
      expect(firstBlock, "First .tasks-row-actions must have flex-wrap: wrap").toMatch(
        /flex-wrap:\s*wrap/,
      );
      expect(firstBlock, "First .tasks-row-actions must have justify-content: flex-end").toMatch(
        /justify-content:\s*flex-end/,
      );
      for (const match of matches) {
        expect(
          match[1],
          "No .tasks-row-actions block should have flex-wrap: nowrap",
        ).not.toMatch(/flex-wrap:\s*nowrap/);
      }
    });
  });
});
