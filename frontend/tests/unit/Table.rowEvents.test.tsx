/** @vitest-environment jsdom */
/**
 * ui/Table row handlers and portaled cell content.
 *
 * A cell may render a portal (a DropdownMenu panel, a popover) into
 * document.body. React bubbles events from the portal along the component
 * tree, so they reach the row's onClick/onKeyDown although their target is
 * not inside the row. The row ignores them:
 *   - rowHref: a click or Enter from portaled content does not navigate the
 *     row, and Enter is not default-prevented (so a portaled link or button
 *     still activates natively);
 *   - onRowClick: a click, Enter or Space from portaled content does not call
 *     onRowClick and is not default-prevented.
 * Events that start inside the row keep working (the control cases).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPortal } from "react-dom";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Table, type ColumnDef } from "../../src/components/ui/Table";

// rowHref renders a next/link in the title cell; the fake router of
// tests/setup/fakeNavigation turns a link click into router.push, which is
// how these tests see a navigation.
vi.mock("next/navigation", async () => {
  const m = await import("../setup/fakeNavigation");
  return { usePathname: m.usePathname, useRouter: m.useRouter, useSearchParams: m.useSearchParams };
});
vi.mock("next/link", async () => ({
  default: (await import("../setup/fakeNavigation")).FakeLink,
}));
import { nav, router, FakeLink } from "../setup/fakeNavigation";

interface Row {
  id: string;
  title: string;
}

const ROWS: Row[] = [{ id: "r1", title: "First row" }];
const ROW_HREF = "/items/r1";

/** A cell with in-row text plus a portaled button and a portaled link. */
function PortalCell() {
  return (
    <>
      <span>In-row text</span>
      {createPortal(
        <div data-testid="portal-panel">
          <button type="button">Portaled button</button>
          <FakeLink href="/elsewhere">Portaled link</FakeLink>
        </div>,
        document.body,
      )}
    </>
  );
}

const COLUMNS: ColumnDef<Row>[] = [
  { key: "title", header: "Title" },
  { key: "extra", header: "Extra", render: () => <PortalCell /> },
];

function row(): HTMLElement {
  return document.querySelector("tbody tr") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.reset("/items");
});

afterEach(cleanup);

describe("Table rowHref: portaled cell content does not navigate the row", () => {
  function renderLinkTable() {
    render(<Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} rowHref={() => ROW_HREF} />);
  }

  it("a click on a portaled button does not navigate the row", () => {
    renderLinkTable();
    fireEvent.click(screen.getByRole("button", { name: "Portaled button" }));
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a click on the portaled panel background does not navigate the row", () => {
    renderLinkTable();
    fireEvent.click(screen.getByTestId("portal-panel"));
    expect(router.push).not.toHaveBeenCalled();
  });

  it("Enter on a portaled button neither navigates nor cancels the button's own activation", () => {
    renderLinkTable();
    const notCanceled = fireEvent.keyDown(screen.getByRole("button", { name: "Portaled button" }), {
      key: "Enter",
    });
    expect(notCanceled).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("Enter on a portaled link follows that link, not the row", async () => {
    renderLinkTable();
    screen.getByRole("link", { name: "Portaled link" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith("/elsewhere");
  });

  it("control: a click inside the row (not on a link) navigates the row", () => {
    renderLinkTable();
    fireEvent.click(screen.getByText("In-row text"));
    expect(router.push).toHaveBeenCalledWith(ROW_HREF);
  });

  it("control: Enter on the focused row navigates it and is default-prevented", () => {
    renderLinkTable();
    const notCanceled = fireEvent.keyDown(row(), { key: "Enter" });
    expect(notCanceled).toBe(false);
    expect(router.push).toHaveBeenCalledWith(ROW_HREF);
  });

  it("control: Enter on in-row content that does not stop it still navigates the row", () => {
    renderLinkTable();
    fireEvent.keyDown(screen.getByText("In-row text"), { key: "Enter" });
    expect(router.push).toHaveBeenCalledWith(ROW_HREF);
  });
});

describe("Table onRowClick: portaled cell content does not trigger the row", () => {
  function renderClickTable() {
    const onRowClick = vi.fn();
    render(<Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowClick={onRowClick} />);
    return onRowClick;
  }

  it("a click on a portaled button does not call onRowClick", () => {
    const onRowClick = renderClickTable();
    fireEvent.click(screen.getByRole("button", { name: "Portaled button" }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])("%j on a portaled button does not call onRowClick and is not canceled", (key) => {
    const onRowClick = renderClickTable();
    const notCanceled = fireEvent.keyDown(screen.getByRole("button", { name: "Portaled button" }), { key });
    expect(notCanceled).toBe(true);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("control: a click inside the row calls onRowClick with the row", () => {
    const onRowClick = renderClickTable();
    fireEvent.click(screen.getByText("In-row text"));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it.each(["Enter", " "])("control: %j on the focused row calls onRowClick and is canceled", (key) => {
    const onRowClick = renderClickTable();
    const notCanceled = fireEvent.keyDown(row(), { key });
    expect(notCanceled).toBe(false);
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });
});
