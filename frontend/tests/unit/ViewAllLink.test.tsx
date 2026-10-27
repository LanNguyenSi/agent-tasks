/** @vitest-environment jsdom */
/**
 * ViewAllLink (components/ui/ViewAllLink.tsx): the quiet header link.
 *
 * Pins the contract the Home widget headers rely on: the given href, the
 * required aria-label as the whole accessible name (so no two links with
 * different hrefs share a name), "View all" as the default visible label,
 * and no text arrow glyph (the arrow is an aria-hidden Icon).
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ViewAllLink } from "../../src/components/ui/ViewAllLink";

afterEach(cleanup);

describe("ViewAllLink", () => {
  it("renders a link with the given href and the aria-label as its name", () => {
    render(
      <ViewAllLink href="/tasks?teamId=t1&status=backlog" aria-label="View all Backlog" />,
    );
    const link = screen.getByRole("link", { name: "View all Backlog" });
    expect(link.getAttribute("href")).toBe("/tasks?teamId=t1&status=backlog");
  });

  it("shows the default label and takes a custom one", () => {
    render(<ViewAllLink href="/x" aria-label="View all projects">All projects</ViewAllLink>);
    const link = screen.getByRole("link", { name: "View all projects" });
    expect(link.textContent).toBe("All projects");
  });

  it("has no arrow glyph in its text and an aria-hidden icon", () => {
    render(<ViewAllLink href="/x" aria-label="View all Done" />);
    const link = screen.getByRole("link", { name: "View all Done" });
    expect(link.textContent).toBe("View all");
    expect(link.textContent).not.toMatch(/→|➜|&rarr;/);
    const svg = link.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });
});
