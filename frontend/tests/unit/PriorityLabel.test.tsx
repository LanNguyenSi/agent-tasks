/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PriorityLabel } from "../../src/components/ui/PriorityLabel";

afterEach(cleanup);

describe("PriorityLabel accessibility", () => {
  it("exposes the colour-coded text as a named image (aria-label needs a role)", () => {
    render(<PriorityLabel priority="HIGH" />);
    const el = screen.getByRole("img", { name: "Priority: High" });
    expect(el).toHaveTextContent("High");
  });
});
