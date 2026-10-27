/** @vitest-environment jsdom */
/**
 * FullPageLoader variants: "centered" is a bare spinner for bootstraps with no
 * frame yet; "shell" is the real page frame (PageShell, default column, a
 * skeleton band in the header slot) so the loaded page does not jump.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FullPageLoader } from "../../src/components/ui/FullPageLoader";

afterEach(cleanup);

describe("FullPageLoader", () => {
  it("shell: a busy PageShell on the default column with a band and skeleton rows", () => {
    render(<FullPageLoader variant="shell" label="Loading your tasks" rows={3} />);
    const main = screen.getByRole("main");
    expect(main).toHaveClass("pshell", "pshell--default");
    expect(main).not.toHaveClass("page-shell");
    expect(main).toHaveAttribute("aria-busy", "true");
    expect(main.querySelectorAll(":scope > .page-header")).toHaveLength(1);
    const slot = main.querySelector(":scope > .pshell-content");
    expect(slot).toHaveClass("pshell-content--default");
    const status = screen.getByRole("status");
    expect(slot).toContainElement(status);
    expect(status).toHaveTextContent("Loading your tasks");
    expect(status.querySelectorAll(".skeleton")).toHaveLength(3);
  });

  it("centered: the bare spinner region, no page frame", () => {
    const { container } = render(<FullPageLoader label="Loading settings…" />);
    // role="status" replaces the implicit main role, so look the element up by tag.
    const main = container.querySelector("main") as HTMLElement;
    expect(main).toHaveClass("full-page-loader");
    expect(main).not.toHaveClass("pshell");
    expect(main).toHaveAttribute("role", "status");
    expect(main).toHaveTextContent("Loading settings…");
  });

  it("shell: no action skeletons by default, headerActions adds that many to the band's actions slot", () => {
    const { rerender } = render(<FullPageLoader variant="shell" />);
    const band = () => screen.getByRole("main").querySelector(":scope > .page-header") as HTMLElement;
    expect(band().querySelector(".page-header-actions")).toBeNull();
    rerender(<FullPageLoader variant="shell" headerActions={2} />);
    const actions = band().querySelector(".page-header-actions") as HTMLElement;
    expect(actions.querySelectorAll(".skeleton")).toHaveLength(2);
    // The band is decorative: nothing in it is exposed to assistive tech.
    expect(band()).toHaveAttribute("aria-hidden", "true");
  });
});
