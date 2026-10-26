/** @vitest-environment jsdom */
/**
 * Governance modes carry one label in the settings option cards and in the
 * project header chip (both read lib/governance); the settings options lead
 * with plain language and keep API routes and signal names behind "Details".
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import GovernanceModeField from "../../src/components/projects/GovernanceModeField";
import { GOVERNANCE_LABELS } from "../../src/lib/governance";

afterEach(cleanup);

describe("governance labels", () => {
  it("maps every mode to its shared label", () => {
    expect(GOVERNANCE_LABELS).toEqual({
      REQUIRES_DISTINCT_REVIEWER: "Second reviewer",
      AWAITS_CONFIRMATION: "Human confirmation",
      AUTONOMOUS: "Autonomous",
    });
  });

  it("the settings options use the shared labels", () => {
    render(<GovernanceModeField value="AUTONOMOUS" onChange={() => {}} />);
    const labels = screen.getAllByRole("radio").map((r) => r.closest("label")!);
    expect(labels.map((l) => l.querySelector(".gov-option-label")!.textContent)).toEqual(
      Object.values(GOVERNANCE_LABELS),
    );
  });

  it("API routes and signal names sit inside a Details disclosure, not in the lead text", () => {
    const { container } = render(
      <GovernanceModeField value="AUTONOMOUS" onChange={() => {}} />,
    );
    const details = container.querySelectorAll("details.gov-option-details");
    expect(details).toHaveLength(3);
    for (const d of details) {
      expect(within(d as HTMLElement).getByText("Details")).toBeInTheDocument();
    }
    for (const desc of container.querySelectorAll(".gov-option-desc")) {
      expect(desc.textContent).not.toMatch(/POST \/|self_merge_notice|require_pull_request_reviews/);
    }
    expect(container.textContent).toContain("POST /tasks/:id/review/claim");
    expect(container.textContent).toContain("self_merge_notice");
  });
});
