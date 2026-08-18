/** @vitest-environment jsdom */
/**
 * ImprovementPanel (task 67526c1c, M4) renders the scorer-v2
 * `confidence.findings[]` and the derived `nextActions` from
 * GET /tasks/:id/instructions — data the API has carried since M1 (PR #245)
 * but the web frontend never surfaced. Covers the three confidence states
 * named in the task's acceptance criteria: passing (collapsed by default),
 * borderline / below-threshold-with-warnings (expanded, warning tone), and
 * blocking (expanded, danger tone, even when the raw score alone clears the
 * threshold — the keystone-blocking override).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ImprovementPanel from "../../src/components/task/ImprovementPanel";
import type { TaskConfidenceDetail } from "../../src/lib/api";

afterEach(cleanup);

const emptySubscores = {
  completeness: 100,
  concreteness: 100,
  testability: 100,
  scopeClarity: 100,
  contextQuality: 100,
  structure: 100,
  ambiguityRisk: 100,
};

function makeConfidence(over: Partial<TaskConfidenceDetail> = {}): TaskConfidenceDetail {
  return {
    score: 85,
    missing: [],
    threshold: 60,
    effectiveThreshold: 60,
    thresholdSource: "global",
    blocking: false,
    subscores: emptySubscores,
    findings: [],
    ...over,
  };
}

describe("ImprovementPanel", () => {
  describe("passing state (score >= threshold, not blocking)", () => {
    const confidence = makeConfidence({ score: 85, threshold: 60, blocking: false, findings: [] });

    it("collapses by default and shows the score + at-or-above verdict in the header", () => {
      render(<ImprovementPanel confidence={confidence} />);
      expect(screen.getByText(/85\/100/)).toBeInTheDocument();
      expect(screen.getByText(/At or above the 60 threshold/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Improvement panel/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      // Collapsed: body content is not in the DOM at all.
      expect(screen.queryByText("No open findings.")).not.toBeInTheDocument();
    });

    it("expands on click to reveal the (empty) body", async () => {
      render(<ImprovementPanel confidence={confidence} />);
      const toggle = screen.getByRole("button", { name: /Improvement panel/ });
      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("No open findings.")).toBeInTheDocument();
      // Collapses again on a second click.
      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("No open findings.")).not.toBeInTheDocument();
    });
  });

  describe("borderline state (score < threshold, warning-only findings)", () => {
    const confidence = makeConfidence({
      score: 45,
      threshold: 60,
      blocking: false,
      findings: [
        {
          code: "missing_goal",
          severity: "warning",
          dimension: "completeness",
          message: "Goal is missing.",
          suggestion: "Add a one-line Goal stating the intended outcome.",
        },
        {
          code: "missing_out_of_scope",
          severity: "info",
          dimension: "scopeClarity",
          message: "Out-of-scope boundary is missing.",
          suggestion: "Name what must NOT change so a weak agent does not wander.",
        },
      ],
    });

    it("expands by default and shows the below-threshold verdict", () => {
      render(<ImprovementPanel confidence={confidence} />);
      expect(
        screen.getByRole("button", { name: /Improvement panel/ }),
      ).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText(/Below the 60 threshold/)).toBeInTheDocument();
      expect(screen.queryByText(/At or above/)).not.toBeInTheDocument();
    });

    it("uses the warning tone (no blocking finding present)", () => {
      const { container } = render(<ImprovementPanel confidence={confidence} />);
      expect(container.querySelector(".ip-root--warning")).toBeInTheDocument();
      expect(container.querySelector(".ip-root--danger")).not.toBeInTheDocument();
    });

    it("groups findings by severity, warning before info, each with code/message/suggestion", () => {
      const { container } = render(<ImprovementPanel confidence={confidence} />);
      const headings = Array.from(container.querySelectorAll(".ip-findings-heading")).map(
        (el) => el.textContent,
      );
      expect(headings).toEqual(["Warning (1)", "Info (1)"]);

      expect(screen.getByText("missing_goal")).toBeInTheDocument();
      expect(screen.getByText("Goal is missing.")).toBeInTheDocument();
      // The same suggestion text also appears in the nextActions checklist
      // below, so scope this assertion to the findings list itself.
      const findingsList = container.querySelector(".ip-findings-list");
      expect(
        within(findingsList as HTMLElement).getByText(
          "Add a one-line Goal stating the intended outcome.",
        ),
      ).toBeInTheDocument();
    });

    it("derives nextActions from findings' suggestions as a numbered checklist", () => {
      render(<ImprovementPanel confidence={confidence} />);
      const list = screen.getByText("Next actions").closest(".ip-section");
      expect(list).not.toBeNull();
      const items = within(list as HTMLElement).getAllByRole("listitem");
      expect(items.map((li) => li.textContent)).toEqual([
        "Add a one-line Goal stating the intended outcome.",
        "Name what must NOT change so a weak agent does not wander.",
      ]);
    });
  });

  describe("blocking state (keystone-blocking overrides a passing raw score)", () => {
    const confidence = makeConfidence({
      score: 85,
      threshold: 60,
      blocking: true,
      findings: [
        {
          code: "missing_acceptance_criteria",
          severity: "blocking",
          dimension: "testability",
          message: "No acceptance criteria and no verification path in the description.",
          suggestion: "Add 2-5 bullets describing observable completion conditions (the task's evals).",
          keystone: true,
        },
      ],
    });

    it("reads as below-threshold and expands by default even though the raw score clears it", () => {
      render(<ImprovementPanel confidence={confidence} />);
      expect(screen.getByText(/85\/100/)).toBeInTheDocument();
      expect(screen.getByText(/Below the 60 threshold/)).toBeInTheDocument();
      expect(screen.queryByText(/At or above/)).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Improvement panel/ }),
      ).toHaveAttribute("aria-expanded", "true");
    });

    it("uses the danger tone", () => {
      const { container } = render(<ImprovementPanel confidence={confidence} />);
      expect(container.querySelector(".ip-root--danger")).toBeInTheDocument();
      expect(container.querySelector(".ip-root--warning")).not.toBeInTheDocument();
    });

    it("shows the Blocking severity group", () => {
      const { container } = render(<ImprovementPanel confidence={confidence} />);
      const headings = Array.from(container.querySelectorAll(".ip-findings-heading")).map(
        (el) => el.textContent,
      );
      expect(headings).toEqual(["Blocking (1)"]);
    });
  });

  describe("triggeredRiskModifiers (M3, optional field)", () => {
    it("renders modifiers tolerantly when present", () => {
      const confidence = makeConfidence({
        score: 40,
        threshold: 60,
        findings: [],
        triggeredRiskModifiers: [{ code: "high_blast_radius", message: "Touches a critical-path file." }],
      });
      render(<ImprovementPanel confidence={confidence} />);
      expect(screen.getByText("Triggered risk modifiers")).toBeInTheDocument();
      expect(screen.getByText("Touches a critical-path file.")).toBeInTheDocument();
    });

    it("omits the section cleanly when absent", () => {
      const confidence = makeConfidence({ score: 40, threshold: 60, findings: [] });
      render(<ImprovementPanel confidence={confidence} />);
      expect(screen.queryByText("Triggered risk modifiers")).not.toBeInTheDocument();
    });

    it("omits the section cleanly when the array is empty", () => {
      const confidence = makeConfidence({ score: 40, threshold: 60, findings: [], triggeredRiskModifiers: [] });
      render(<ImprovementPanel confidence={confidence} />);
      expect(screen.queryByText("Triggered risk modifiers")).not.toBeInTheDocument();
    });
  });
});
