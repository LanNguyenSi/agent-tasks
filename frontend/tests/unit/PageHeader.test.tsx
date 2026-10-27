/** @vitest-environment jsdom */
/**
 * PageHeader summary truncation is an opt-in: only a band whose summary
 * carries a user-chosen name gets the modifier class that lets the summary
 * shrink; the full text stays in the DOM either way.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { PageHeader } from "../../src/components/ui/PageHeader";

afterEach(cleanup);

describe("PageHeader truncateSummary", () => {
  it("is off by default: no modifier class", () => {
    const { container } = render(<PageHeader title="Tasks" summary="12 open" />);
    expect(container.querySelector(".page-header")).not.toHaveClass("page-header--summary-truncates");
  });

  it("adds the modifier class and keeps the whole summary text in the DOM", () => {
    const long = "x".repeat(100);
    const { container } = render(<PageHeader title="Projects" summary={long} truncateSummary />);
    expect(container.querySelector(".page-header")).toHaveClass("page-header", "page-header--summary-truncates");
    expect(container.querySelector(".page-header-summary")?.textContent).toBe(long);
  });

  it("keeps a caller className next to the modifier", () => {
    const { container } = render(<PageHeader title="P" summary="s" truncateSummary className="extra" />);
    expect(container.querySelector(".page-header")).toHaveClass("page-header--summary-truncates", "extra");
  });
});
