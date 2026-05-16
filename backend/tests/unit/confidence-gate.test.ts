/**
 * Unit tests for `backend/src/services/confidence-gate.ts`.
 *
 * Covers the pure `deriveNextActions` helper. The `evaluateConfidenceGate`
 * function is exercised via the route tests at `tasks-v2-routes.test.ts`
 * once those land follow-on coverage; this file only owns the pure piece.
 */
import { describe, it, expect } from "vitest";
import { deriveNextActions } from "../../src/services/confidence-gate.js";
import type { QualityFinding } from "../../src/lib/confidence.js";

function f(overrides: Partial<QualityFinding>): QualityFinding {
  return {
    code: "x",
    severity: "warning",
    dimension: "completeness",
    message: "m",
    suggestion: "s",
    ...overrides,
  };
}

describe("deriveNextActions", () => {
  it("returns empty array for empty findings", () => {
    expect(deriveNextActions([])).toEqual([]);
  });

  it("skips findings without a suggestion", () => {
    expect(
      deriveNextActions([
        f({ suggestion: undefined }),
        f({ suggestion: "Do A" }),
      ]),
    ).toEqual(["Do A"]);
  });

  it("orders blocking before warning before info", () => {
    const actions = deriveNextActions([
      f({ severity: "info", suggestion: "info-suggestion" }),
      f({ severity: "warning", suggestion: "warning-suggestion" }),
      f({ severity: "blocking", suggestion: "blocking-suggestion" }),
    ]);
    expect(actions).toEqual(["blocking-suggestion", "warning-suggestion", "info-suggestion"]);
  });

  it("deduplicates identical suggestions across findings", () => {
    expect(
      deriveNextActions([
        f({ code: "a", suggestion: "same suggestion" }),
        f({ code: "b", suggestion: "same suggestion" }),
        f({ code: "c", suggestion: "other suggestion" }),
      ]),
    ).toEqual(["same suggestion", "other suggestion"]);
  });

  it("caps the list at 5 entries", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      f({ code: `c${i}`, suggestion: `s${i}` }),
    );
    expect(deriveNextActions(many)).toHaveLength(5);
  });

  it("preserves stable order within the same severity bucket", () => {
    const actions = deriveNextActions([
      f({ severity: "blocking", code: "first", suggestion: "first-msg" }),
      f({ severity: "blocking", code: "second", suggestion: "second-msg" }),
      f({ severity: "blocking", code: "third", suggestion: "third-msg" }),
    ]);
    expect(actions).toEqual(["first-msg", "second-msg", "third-msg"]);
  });
});
