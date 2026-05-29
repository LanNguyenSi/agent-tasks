/** @vitest-environment jsdom */
/**
 * Skeleton primitives — the single bar is decorative (aria-hidden); the
 * list wraps an aria-busy status region with a screen-reader label so
 * assistive tech announces "loading" once.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { Skeleton, SkeletonList } from "../../src/components/ui/Skeleton";

afterEach(cleanup);

describe("Skeleton", () => {
  it("renders a decorative bar hidden from assistive tech", () => {
    const { container } = render(<Skeleton width={120} height={8} />);
    const bar = container.querySelector(".skeleton") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar.style.width).toBe("120px");
    expect(bar.style.height).toBe("8px");
  });
});

describe("SkeletonList", () => {
  it("renders the requested number of rows inside an aria-busy status region", () => {
    const { container } = render(<SkeletonList rows={4} label="Loading tasks" />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll(".skeleton")).toHaveLength(4);
  });

  it("exposes the loading label to screen readers only", () => {
    render(<SkeletonList rows={1} label="Loading your tasks" />);
    expect(screen.getByText("Loading your tasks")).toHaveClass("sr-only");
  });

  it("defaults to three rows", () => {
    const { container } = render(<SkeletonList />);
    expect(container.querySelectorAll(".skeleton")).toHaveLength(3);
  });
});
