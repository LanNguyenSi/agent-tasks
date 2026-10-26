/** @vitest-environment jsdom */
/**
 * PageShell (components/ui/PageShell.tsx): one <main>, a header slot rendered
 * straight into it, and a content slot whose class carries the width variant.
 * The variant -> class mapping is what globals.css keys the max widths on
 * (default 1200, narrow 760, wide none), so each variant is pinned here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PageShell } from "../../src/components/ui/PageShell";

afterEach(cleanup);

function slot(): HTMLElement {
  return screen.getByText("body").closest(".pshell-content") as HTMLElement;
}

describe("PageShell", () => {
  it("renders exactly one <main> with the page body inside it", () => {
    render(<PageShell>body</PageShell>);
    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]).toHaveClass("pshell");
    expect(mains[0]).toContainElement(slot());
  });

  it.each([
    ["default", "pshell-content--default", ["pshell-content--narrow", "pshell-content--wide"]],
    ["narrow", "pshell-content--narrow", ["pshell-content--default", "pshell-content--wide"]],
    ["wide", "pshell-content--wide", ["pshell-content--default", "pshell-content--narrow"]],
  ] as const)("maps the %s variant to its own class only", (variant, cls, others) => {
    render(<PageShell variant={variant}>body</PageShell>);
    expect(slot()).toHaveClass(cls);
    for (const other of others) expect(slot()).not.toHaveClass(other);
  });

  it("defaults to the default variant, left-aligned, with a gutter", () => {
    render(<PageShell>body</PageShell>);
    expect(slot()).toHaveClass("pshell-content--default");
    expect(slot()).not.toHaveClass("pshell-content--centered", "pshell-content--flush");
  });

  it("adds the centered and flush modifiers only when asked", () => {
    render(
      <PageShell centered flush contentClassName="extra">
        body
      </PageShell>,
    );
    expect(slot()).toHaveClass("pshell-content--centered", "pshell-content--flush", "extra");
  });

  it("renders the header slot inside <main>, before the content, without a wrapper", () => {
    render(
      <PageShell header={<h1>Title</h1>}>
        body
      </PageShell>,
    );
    const main = screen.getByRole("main");
    const h1 = screen.getByRole("heading", { level: 1, name: "Title" });
    expect(h1.parentElement).toBe(main);
    expect(h1.compareDocumentPosition(slot()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks <main> busy only when busy is set", () => {
    const { rerender } = render(<PageShell>body</PageShell>);
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy");
    rerender(<PageShell busy>body</PageShell>);
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
  });
});
