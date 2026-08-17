/**
 * Unit tests for `backend/src/services/confidence-gate.ts`.
 *
 * Covers the pure `deriveNextActions` helper. The `evaluateConfidenceGate`
 * function is exercised via the route tests at `tasks-v2-routes.test.ts`
 * once those land follow-on coverage; this file only owns the pure piece.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deriveNextActions } from "../../src/services/confidence-gate.js";
import { calculateConfidence, type QualityFinding } from "../../src/lib/confidence.js";

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

  // ── M2 crowd-out fix (task 6b88ec87 review round 1, finding 5) ────────────
  // A per-taskType required-signal finding (confidence.ts's
  // REQUIRED_SIGNALS_BY_TYPE) is ALWAYS severity "blocking". Within a
  // severity tier, a universal finding must still rank ahead of a
  // type-specific one — confidence.ts's REQUIRED_SIGNAL_ONLY_CODES set is
  // the tiebreak membership test.
  it("ranks a universal finding ahead of a type-specific required-signal finding within the SAME severity, even when the type-specific one appears first in the input", () => {
    const actions = deriveNextActions([
      // A genuinely new (non-aliased) required-signal code — see
      // REQUIRED_SIGNAL_ONLY_CODES in confidence.ts — deliberately listed
      // FIRST so a naive severity-only sort (stable) would keep it first.
      f({ code: "missing_reproduction_steps", severity: "blocking", suggestion: "Add numbered steps to reproduce the bug." }),
      f({ code: "missing_scope", severity: "blocking", suggestion: "List the files, modules, or surfaces the change may touch." }),
    ]);
    expect(actions).toEqual([
      "List the files, modules, or surfaces the change may touch.",
      "Add numbered steps to reproduce the bug.",
    ]);
  });

  it("an ALIASED required-signal code (e.g. missing_scope, missing_acceptance_criteria) is treated as universal, not type-specific, for the tiebreak", () => {
    // missing_scope and missing_acceptance_criteria are both codes a
    // required-signal predicate can emit (refactoring/docs/feature), but
    // both ALIAS an existing universal MISS_FINDINGS code (see the header
    // comment above REQUIRED_SIGNALS_BY_TYPE) — REQUIRED_SIGNAL_ONLY_CODES
    // deliberately excludes them, so they must not be pushed behind a
    // genuinely type-specific finding.
    const actions = deriveNextActions([
      f({ code: "missing_current_state", severity: "blocking", suggestion: "Describe the current state before the migration." }),
      f({ code: "missing_acceptance_criteria", severity: "blocking", suggestion: "Add 2-5 bullets describing observable completion conditions (the task's evals)." }),
    ]);
    expect(actions).toEqual([
      "Add 2-5 bullets describing observable completion conditions (the task's evals).",
      "Describe the current state before the migration.",
    ]);
  });

  describe("end-to-end: migration-typed task via calculateConfidence", () => {
    beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
    afterEach(() => vi.restoreAllMocks());

    it("a low-score migration-typed task's top next actions surface the universal fixes (scope/agentPrompt/goal) ahead of remaining type-signal prose", () => {
      // States most of migration's required signals in prose but leaves
      // scope/agentPrompt/goal (universal) AND current_state (migration-only)
      // unstated, so both severity tiers are populated without either one
      // alone saturating the 5-slot cap (measured: backend/dist build,
      // task 6b88ec87 review round 1 finding 5 — see the PR description for
      // the exact `node` invocation used to produce this fixture).
      const description = [
        "Target state: the users table lives on the new Postgres cluster.",
        "Compatibility: the read API stays backward compatible during the cutover.",
        "Rollback: revert to the legacy cluster if replication lag spikes.",
        "Deployment impact: requires a brief maintenance window.",
        "Operational risk: on-call must watch replication lag; blast radius is the users service only.",
      ].join(" ");
      const result = calculateConfidence({
        title: "Migrate users table storage backend",
        description,
        templateData: {
          acceptanceCriteria: "- users table reads/writes succeed against the new backend",
          taskType: "migration",
        },
        templateFields: null,
      });
      expect(result.score).toBeLessThan(60);

      const actions = deriveNextActions(result.findings);
      // The single remaining migration-only blocking gap (current_state)
      // still leads (it is the only blocking-severity finding), but the
      // universal warning-severity fixes are NOT crowded out below it —
      // goal/scope/agentPrompt all make the capped top-5.
      expect(actions[0]).toBe("Describe the current state before the migration.");
      expect(actions).toContain("Add a one-line Goal stating the intended outcome.");
      expect(actions).toContain("List the files, modules, or surfaces the change may touch.");
      expect(actions).toContain("Add a step-by-step instruction block a weak agent can execute verbatim.");
    });
  });
});
