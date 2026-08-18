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
 *
 * No live/visual smoke was run for this component (fix-round 1, LOW-6):
 * everything below is jsdom-only, exercised through synthetic/derived
 * `TaskConfidenceDetail` props, and the implementation environment had no
 * running backend to hit /tasks/:id/instructions against. The real M3
 * response shape (triggeredRiskModifiers: string[]) was cross-checked by
 * reading batch18/m3-risk-modifiers commit 49b4afc's backend source, not by
 * a live request.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ImprovementPanel from "../../src/components/task-detail/ImprovementPanel";
import type { TaskConfidenceDetail } from "../../src/lib/api";
import {
  calculateConfidence as backendCalculateConfidence,
  resolveEffectiveThreshold as backendResolveEffectiveThreshold,
} from "../../../backend/src/lib/confidence";

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

  describe("triggeredRiskModifiers (M3, real shape verified against batch18/m3-risk-modifiers commit 49b4afc)", () => {
    // HIGH-1 fix (fix-round 1): `triggeredRiskModifiers` is `RiskModifierName[]`
    // -- bare modifier-name strings like "touchesAuth" -- NOT `{code, message}`
    // objects. The old {code, message} fixture below is the empirical repro of
    // the bug this locks: against a real string[] payload, `m.code` and
    // `m.message` both read `undefined` off a string, so the list rendered an
    // empty `<li>` (no visible text) for every entry, plus a React
    // "each child in a list should have a unique key" warning (every `m.code`
    // resolved to the same `undefined` key). This block replaces that
    // now-provably-wrong fixture with the real M3 shape and asserts the raw
    // modifier NAMES are visible in the DOM -- the previously invisible
    // content.
    it("renders string[] modifier names tolerantly, each visible with a human label where known", () => {
      const confidence = makeConfidence({
        score: 40,
        threshold: 60,
        findings: [],
        triggeredRiskModifiers: ["touchesAuth", "productionImpact"],
      });
      render(<ImprovementPanel confidence={confidence} />);
      expect(screen.getByText("Triggered risk modifiers")).toBeInTheDocument();
      // The raw names themselves must be visible -- not just a derived label.
      expect(screen.getByText("touchesAuth")).toBeInTheDocument();
      expect(screen.getByText("productionImpact")).toBeInTheDocument();
      // A known name also gets a human-readable label alongside the raw name.
      expect(screen.getByText("Touches auth")).toBeInTheDocument();
      expect(screen.getByText("Production impact")).toBeInTheDocument();
    });

    it("renders an unrecognized modifier name's raw string with no invented label (nothing fabricated)", () => {
      const confidence = makeConfidence({
        score: 40,
        threshold: 60,
        findings: [],
        triggeredRiskModifiers: ["someFutureModifier"],
      });
      render(<ImprovementPanel confidence={confidence} />);
      expect(screen.getByText("someFutureModifier")).toBeInTheDocument();
    });

    it("gives each triggered-risk-modifier <li> a stable, non-duplicate key (no two entries collide on the same key)", () => {
      // A duplicate/undefined key across siblings triggers React's
      // "each child in a list should have a unique key" console.error --
      // the exact regression the {code, message} shape produced (every
      // entry's `m.code` was `undefined`). Two distinct real names must
      // render as two distinct list items without that warning.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const confidence = makeConfidence({
        score: 40,
        threshold: 60,
        findings: [],
        triggeredRiskModifiers: ["touchesAuth", "touchesDatabase"],
      });
      const { container } = render(<ImprovementPanel confidence={confidence} />);
      expect(container.querySelectorAll(".ip-risk-item")).toHaveLength(2);
      const keyWarning = errorSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes("unique \"key\" prop")),
      );
      expect(keyWarning).toBe(false);
      errorSpy.mockRestore();
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

  describe("collapse-state resync on a passes-crossing prop change (fix-round 1, MED-4)", () => {
    it("resyncs `open` to the new default when a prop update flips passing -> failing", () => {
      const passing = makeConfidence({ score: 85, threshold: 60, blocking: false, findings: [] });
      const { rerender } = render(<ImprovementPanel confidence={passing} />);
      const toggle = screen.getByRole("button", { name: /Improvement panel/ });
      // Passing starts collapsed (default); this assertion pins the starting
      // point the resync is measured against.
      expect(toggle).toHaveAttribute("aria-expanded", "false");

      const failing = makeConfidence({
        score: 20,
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
        ],
      });
      rerender(<ImprovementPanel confidence={failing} />);
      // Before the fix, `open` was seeded once via `useState(!passes)` on
      // mount and never resynced, so this assertion would still read
      // "false" here.
      expect(screen.getByRole("button", { name: /Improvement panel/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    it("resyncs `open` to the new default when a prop update flips failing -> passing", () => {
      const failing = makeConfidence({ score: 20, threshold: 60, blocking: false, findings: [] });
      const { rerender } = render(<ImprovementPanel confidence={failing} />);
      expect(screen.getByRole("button", { name: /Improvement panel/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      );

      const passing = makeConfidence({ score: 85, threshold: 60, blocking: false, findings: [] });
      rerender(<ImprovementPanel confidence={passing} />);
      expect(screen.getByRole("button", { name: /Improvement panel/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("does NOT clobber a user's manual toggle when a prop update leaves the pass/fail verdict unchanged", async () => {
      const failingV1 = makeConfidence({
        score: 20,
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
        ],
      });
      const { rerender } = render(<ImprovementPanel confidence={failingV1} />);
      const toggle = screen.getByRole("button", { name: /Improvement panel/ });
      // Failing starts expanded by default; the user manually collapses it.
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");

      // A second edit changes the findings text but the task is still
      // failing at the same threshold -- `passes` (false) is unchanged.
      const failingV2 = makeConfidence({
        score: 25,
        threshold: 60,
        blocking: false,
        findings: [
          {
            code: "missing_scope",
            severity: "warning",
            dimension: "scopeClarity",
            message: "Scope (what may change) is missing.",
            suggestion: "List the files, modules, or surfaces the change may touch.",
          },
        ],
      });
      rerender(<ImprovementPanel confidence={failingV2} />);
      // The user's manual collapse must survive: passes did not change, so
      // there is no reason to force the panel back open.
      expect(screen.getByRole("button", { name: /Improvement panel/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
  });

  describe("severity heading order (fix-round 1, MED-2: mixed corpus)", () => {
    // The previous suite only ever exercised ONE severity tier per fixture
    // (or, for the empty state, none at all), so a mutant that permutes
    // SEVERITY_ORDER (e.g. ["info", "warning", "blocking"]) still passed
    // every existing test -- each fixture's `.toEqual([single item])`
    // assertion is order-blind for a one-element array. This fixture mixes
    // all three severities in ONE result and asserts the full heading
    // SEQUENCE, which a permuted SEVERITY_ORDER breaks.
    const confidence = makeConfidence({
      score: 30,
      threshold: 60,
      blocking: true,
      findings: [
        {
          code: "info_code",
          severity: "info",
          dimension: "completeness",
          message: "An info finding.",
          suggestion: "info suggestion",
        },
        {
          code: "blocking_code",
          severity: "blocking",
          dimension: "testability",
          message: "A blocking finding.",
          suggestion: "blocking suggestion",
          keystone: true,
        },
        {
          code: "warning_code",
          severity: "warning",
          dimension: "scopeClarity",
          message: "A warning finding.",
          suggestion: "warning suggestion",
        },
      ],
    });

    it("renders the heading sequence Blocking -> Warning -> Info regardless of the findings array's own order", () => {
      const { container } = render(<ImprovementPanel confidence={confidence} />);
      const headings = Array.from(container.querySelectorAll(".ip-findings-heading")).map(
        (el) => el.textContent,
      );
      expect(headings).toEqual(["Blocking (1)", "Warning (1)", "Info (1)"]);
    });
  });

  describe("real-producer fixture (fix-round 1, LOW-7)", () => {
    // Built from the actual backend scorer (backendCalculateConfidence +
    // backendResolveEffectiveThreshold), the same real-producer pattern
    // confidence.parity.test.ts uses -- not a hand-typed TaskConfidenceDetail
    // literal. A future backend response-shape drift (a renamed/removed
    // field on ConfidenceResult or EffectiveThreshold) breaks the TYPE of
    // this fixture at compile time, and a scoring-logic drift changes what
    // actually renders here, either way turning this test red instead of
    // leaving the panel's real-world contract silently unverified.
    it("renders a TaskConfidenceDetail built from the real backend scorer output", () => {
      const backendResult = backendCalculateConfidence({
        title: "",
        description: "",
        templateData: null,
        templateFields: null,
      });
      const { effectiveThreshold, thresholdSource } = backendResolveEffectiveThreshold(
        backendResult.inferredTaskType,
        null,
        60,
      );
      const confidence: TaskConfidenceDetail = {
        score: backendResult.score,
        missing: backendResult.missing,
        threshold: effectiveThreshold,
        effectiveThreshold,
        thresholdSource,
        blocking: backendResult.blocking,
        subscores: backendResult.subscores,
        findings: backendResult.findings,
        inferredTaskType: backendResult.inferredTaskType,
      };
      render(<ImprovementPanel confidence={confidence} />);
      // Anchored at the start: unanchored, a score of 0 also substring-matches
      // the unrelated "current ceiling 30/100" / "40/100" / etc. cap-finding
      // text elsewhere in the panel (they all end in "0/100" too).
      expect(screen.getByText(new RegExp(`^${backendResult.score}/100`))).toBeInTheDocument();
      // A wholly empty task fails multiple keystones (title, evals, ...) ->
      // blocking tone, expanded by default, with a real backend-produced
      // finding visible.
      expect(screen.getByRole("button", { name: /Improvement panel/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(screen.getByText("missing_title")).toBeInTheDocument();
    });
  });
});
