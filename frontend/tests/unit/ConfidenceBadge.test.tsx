/** @vitest-environment jsdom */
/**
 * ConfidenceBadge:
 * - visible short name "Spec 96" (no "/100"), tier words complete/partial/thin,
 *   never the priority words low/medium/high;
 * - threshold-relative tiers: complete = score >= threshold, partial above
 *   half the threshold, thin below it (boundaries: threshold-1, threshold, 0,
 *   100; fallback to GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD when unknown);
 * - tooltip (title + accessible description): explains the score, and names
 *   "Project threshold: N." only when the threshold is known.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ConfidenceBadge, {
  getConfidenceTier,
  getConfidenceTooltip,
} from "../../src/components/ConfidenceBadge";

afterEach(cleanup);

describe("ConfidenceBadge; visible name", () => {
  it('shows the short name "Spec 96" with a tier word and no "/100"', () => {
    render(<ConfidenceBadge score={96} threshold={60} />);
    const badge = screen.getByText(/^Spec 96/);
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe("Spec 96, complete");
    expect(badge.textContent).not.toContain("/100");
  });

  it("never shows the priority words low/medium/high at any score", () => {
    for (const score of [0, 20, 39, 40, 59, 60, 61, 99, 100]) {
      const { unmount } = render(<ConfidenceBadge score={score} threshold={60} />);
      expect(screen.getByText(/^Spec /).textContent).not.toMatch(/\b(low|medium|high)\b/);
      unmount();
    }
  });

  it("exposes the tier word in the accessible name (not color-only)", () => {
    render(<ConfidenceBadge score={10} threshold={60} />);
    expect(screen.getByText(/^Spec 10/).getAttribute("aria-label")).toContain("Spec 10, thin");
  });
});

/**
 * The badge is a role="img" (an aria-label on a role-less span is an
 * aria-prohibited-attr violation), and its accessible name carries the whole
 * explanation the title tooltip shows, so a touch screen reader reads it
 * without hover. The visible text stays "Spec N, tier".
 */
describe("ConfidenceBadge; role=img with the explanation in the name", () => {
  it("renders as role=img named by the badge text", () => {
    render(<ConfidenceBadge score={96} threshold={60} />);
    expect(screen.getByRole("img", { name: /^Spec 96, complete/ })).toBeInTheDocument();
  });

  it("known threshold: the name carries score, tier and the full explanation", () => {
    render(<ConfidenceBadge score={96} threshold={60} />);
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "Spec 96, complete. How complete the task spec is (0-100). Project threshold: 60.",
    );
  });

  it("unknown threshold: the name carries the explanation without the threshold clause", () => {
    render(<ConfidenceBadge score={42} />);
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "Spec 42, partial. How complete the task spec is (0-100).",
    );
  });

  it("visible text is unchanged (not the explanation)", () => {
    render(<ConfidenceBadge score={96} threshold={60} />);
    expect(screen.getByRole("img").textContent).toBe("Spec 96, complete");
  });
});

describe("ConfidenceBadge; tier boundaries (threshold 60)", () => {
  it("threshold-1 is partial, threshold is complete (>=, not >)", () => {
    expect(getConfidenceTier(59, 60)).toBe("partial");
    expect(getConfidenceTier(60, 60)).toBe("complete");
  });

  it("0 is thin, half-threshold is partial, just below it is thin", () => {
    expect(getConfidenceTier(0, 60)).toBe("thin");
    expect(getConfidenceTier(29, 60)).toBe("thin");
    expect(getConfidenceTier(30, 60)).toBe("partial");
  });

  it("100 is complete; a higher threshold moves the boundary (74/75 at 75)", () => {
    expect(getConfidenceTier(100, 60)).toBe("complete");
    expect(getConfidenceTier(74, 75)).toBe("partial");
    expect(getConfidenceTier(75, 75)).toBe("complete");
  });

  it("threshold 0: every score is complete (>= 0)", () => {
    expect(getConfidenceTier(0, 0)).toBe("complete");
  });

  it("unknown threshold falls back to the global default (60), not to partial-everything", () => {
    expect(getConfidenceTier(60)).toBe("complete");
    expect(getConfidenceTier(59)).toBe("partial");
    expect(getConfidenceTier(29, null)).toBe("thin");
    expect(getConfidenceTier(30, null)).toBe("partial");
  });
});

describe("ConfidenceBadge; tooltip (title + accessible description)", () => {
  it('with a known threshold: names it as "Project threshold: N."', () => {
    render(<ConfidenceBadge score={96} threshold={60} />);
    const badge = screen.getByText(/^Spec 96/);
    expect(badge).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 60.",
    );
    expect(badge).toHaveAccessibleDescription(
      "How complete the task spec is (0-100). Project threshold: 60.",
    );
  });

  it("without a threshold: the same sentence, no threshold clause", () => {
    render(<ConfidenceBadge score={96} />);
    const badge = screen.getByText(/^Spec 96/);
    expect(badge).toHaveAttribute("title", "How complete the task spec is (0-100).");
    expect(badge.getAttribute("title")).not.toContain("Project threshold");
    expect(badge).toHaveAccessibleDescription("How complete the task spec is (0-100).");
  });

  it("threshold 0 is a known threshold, not an absent one", () => {
    render(<ConfidenceBadge score={0} threshold={0} />);
    expect(screen.getByText(/^Spec 0/)).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 0.",
    );
  });
});

describe("getConfidenceTooltip", () => {
  it("omits the threshold clause for null/undefined, keeps 0", () => {
    expect(getConfidenceTooltip(undefined)).toBe("How complete the task spec is (0-100).");
    expect(getConfidenceTooltip(null)).toBe("How complete the task spec is (0-100).");
    expect(getConfidenceTooltip(70)).toBe(
      "How complete the task spec is (0-100). Project threshold: 70.",
    );
  });
});
