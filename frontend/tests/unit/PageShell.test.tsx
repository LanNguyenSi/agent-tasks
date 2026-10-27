/** @vitest-environment jsdom */
/**
 * PageShell (components/ui/PageShell.tsx): one <main>, a header slot rendered
 * straight into it, and a content slot whose class carries the width variant.
 * The variant -> class mapping is what globals.css keys the page column
 * (--page-column on <main>) and the slot max width on (default 1200, wide
 * none), so each variant is pinned on both elements here.
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
    ["default", "pshell-content--default", "pshell--default", "pshell-content--wide", "pshell--wide"],
    ["wide", "pshell-content--wide", "pshell--wide", "pshell-content--default", "pshell--default"],
  ] as const)(
    "maps the %s variant to its own slot class and <main> column class only",
    (variant, cls, mainCls, otherCls, otherMainCls) => {
      render(<PageShell variant={variant}>body</PageShell>);
      expect(slot()).toHaveClass(cls);
      expect(slot()).not.toHaveClass(otherCls);
      expect(screen.getByRole("main")).toHaveClass("pshell", mainCls);
      expect(screen.getByRole("main")).not.toHaveClass(otherMainCls);
    },
  );

  it("defaults to the default variant (centred 1200px column) with a gutter", () => {
    render(<PageShell>body</PageShell>);
    expect(slot()).toHaveClass("pshell-content--default");
    expect(screen.getByRole("main")).toHaveClass("pshell--default");
    expect(slot()).not.toHaveClass("pshell-content--flush");
  });

  it("has no narrow variant and no centered modifier any more", () => {
    // @ts-expect-error narrow was removed with the centred column
    render(<PageShell variant="narrow">body</PageShell>);
    expect(slot()).not.toHaveClass("pshell-content--default", "pshell-content--wide");
    cleanup();
    // @ts-expect-error centered was removed: every column is centred
    render(<PageShell centered>body</PageShell>);
    expect(slot()).not.toHaveClass("pshell-content--centered");
  });

  it("adds the flush modifier and the extra class only when asked", () => {
    render(
      <PageShell flush contentClassName="extra">
        body
      </PageShell>,
    );
    expect(slot()).toHaveClass("pshell-content--flush", "extra");
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
