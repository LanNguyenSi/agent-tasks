import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateConfidence as backendCalculateConfidence,
  resolveEffectiveThreshold as backendResolveEffectiveThreshold,
} from "../../../backend/src/lib/confidence";
import {
  calculateConfidence as frontendCalculateConfidence,
  resolveEffectiveThreshold as frontendResolveEffectiveThreshold,
  type TaskType,
} from "./confidence";
import { CONFIDENCE_PARITY_FIXTURES } from "./__fixtures__/confidence-fixtures";

/**
 * Real cross-package parity guard (task 79621590).
 *
 * frontend/src/lib/confidence.ts is a hand-maintained mirror of the
 * authoritative backend/src/lib/confidence.ts. Before this test, parity was
 * only checked by regenerating frontend fixtures from the backend ONCE (PR
 * #384) and hand-copying "expected" ground truth into
 * confidence.test.ts — a future backend re-tune can pass its own suite while
 * the frontend badge silently desyncs, because nothing re-runs the backend
 * scorer to compare.
 *
 * This test closes that gap: it imports the REAL backend scorer as
 * TypeScript source (not backend/dist) and runs it side by side with the
 * real frontend scorer over the shared corpus in
 * frontend/src/lib/__fixtures__/confidence-fixtures.ts, asserting the full
 * result (score, missing[], blocking, subscores, findings,
 * inferredTaskType) matches via toStrictEqual for every fixture.
 * toStrictEqual (unlike toEqual) also fails when one side has a
 * present-but-undefined key the other side lacks entirely, so a one-sided
 * edit (e.g. a FIELD_WEIGHTS tune applied to only one copy, or a stray
 * optional field one scorer starts/stops setting) fails HERE instead of
 * drifting silently.
 *
 * backend/src/lib/confidence.ts must stay dependency-light (zod only): this
 * test imports it directly into the frontend workspace's vitest run, so a
 * new backend-only dependency (a DB client, a Node-only API) breaks the
 * FRONTEND CI job with a backend-pointing error the frontend job otherwise
 * never surfaces.
 *
 * Mechanism choice: vitest transforms arbitrary TypeScript via esbuild, so
 * this test can import backend/src/lib/confidence.ts directly — no
 * `tsc`/`npm run build --workspace=backend` step is required before this
 * test runs (confirmed locally: `npm run typecheck --workspace=frontend`
 * and `vitest run` both resolve the cross-package relative import cleanly).
 * That also means no CI job-ordering change is needed: the frontend CI job
 * already does a full-repo `actions/checkout` + root `npm ci` before running
 * `npm run test:coverage --workspace=frontend`, so backend/src and the
 * hoisted `zod` dependency backend/src/lib/confidence.ts needs are already
 * on disk when this test runs. This is strictly test-only: no application
 * code imports this file or backend/src, so `next build` never bundles the
 * backend source it pulls in.
 */
describe("calculateConfidence — cross-package parity (backend vs frontend, task 79621590)", () => {
  // The backend scorer logs an info line via console.info when a score cap
  // fires (ops visibility, backend/src/lib/confidence.ts). Several fixtures
  // below trip a cap; silence it the same way backend's own suite does so
  // this parity suite's output stays clean.
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => infoSpy.mockRestore());

  it("the corpus covers exactly the 15 known parity fixtures, by name (not just by count)", () => {
    // toEqual on the exact sorted name set (not >= N) so renaming, dropping,
    // or silently swapping a fixture for an easier one fails HERE naming the
    // miss, instead of a loose count-only guard staying green.
    const names = CONFIDENCE_PARITY_FIXTURES.map((f) => f.name).sort();
    expect(names).toEqual([
      "empty",
      "full-strong-with-ac",
      "rich-prose-no-verification",
      "rich-prose-with-verification",
      "rich-templatedata-no-desc-c71de504",
      "sectioned-desc",
      "template-fields-completeness",
      "title-only-no-desc",
      "typed-bugfix-missing-repro",
      "typed-docs-missing-review-owner",
      "typed-feature-with-ac",
      "typed-migration-missing-deployment-impact",
      "typed-refactoring-missing-non-goals",
      "typed-security-missing-affected-asset",
      "vague-no-anchors",
    ]);
  });

  it("the comparison itself is falsifiable: a perturbed copy of a real result is NOT strict-equal to it (negative control)", () => {
    // Guards against the loop below going permanently, vacuously green: if
    // the two scorers were ever collapsed into a single shared import,
    // every fixture would trivially match forever. This proves the
    // toStrictEqual comparison the loop relies on actually rejects a
    // divergent result instead of always passing.
    const [{ input }] = CONFIDENCE_PARITY_FIXTURES;
    const backendResult = backendCalculateConfidence(input);
    const perturbed = { ...backendResult, score: backendResult.score + 1 };
    expect(perturbed).not.toStrictEqual(backendResult);
  });

  for (const { name, input } of CONFIDENCE_PARITY_FIXTURES) {
    it(`backend and frontend produce an identical result: ${name}`, () => {
      const backendResult = backendCalculateConfidence(input);
      const frontendResult = frontendCalculateConfidence(input);
      // Whole-object strict equality: covers score, missing[], blocking,
      // subscores, findings, and inferredTaskType in a single assertion, so
      // a divergence in ANY of them (including a present-with-undefined
      // key one side lacks entirely) fails this test.
      expect(frontendResult).toStrictEqual(backendResult);
    });
  }

  // ── Finding 5 (review round 2): measured required-signal coverage ─────────
  // The 5 "typed-X-missing-Y" fixtures each claim (by name) to miss exactly
  // one M2 required signal for their taskType. Nothing previously asserted
  // that claim — two of the five were provably defused (see the corpus doc
  // comment in confidence-fixtures.ts): wording that accidentally satisfied
  // the very signal it claimed to miss, or accidentally satisfied a
  // DIFFERENT signal than the one named. These values are MEASURED against
  // the built backend scorer (npm run build --workspace=backend, then this
  // exact fixture input through calculateConfidence), not hand-derived from
  // reading the regexes — the repo convention this test enforces on every
  // future edit to these fixtures.
  describe("typed-X-missing-Y fixtures: measured required-signal coverage (finding 5)", () => {
    const EXPECTED_MISSING_CODE: Record<string, string> = {
      "typed-bugfix-missing-repro": "missing_reproduction_steps",
      "typed-refactoring-missing-non-goals": "missing_out_of_scope",
      "typed-security-missing-affected-asset": "missing_affected_asset",
      "typed-migration-missing-deployment-impact": "missing_deployment_impact",
      "typed-docs-missing-review-owner": "missing_review_owner",
    };

    for (const [name, expectedCode] of Object.entries(EXPECTED_MISSING_CODE)) {
      it(`${name} fires exactly ${expectedCode} at blocking severity, nothing keystone, report not blocking`, () => {
        const { input } = CONFIDENCE_PARITY_FIXTURES.find((f) => f.name === name)!;
        const result = backendCalculateConfidence(input);
        const finding = result.findings.find((f) => f.code === expectedCode);
        expect(finding?.severity).toBe("blocking");
        // Escalated-alias or genuinely-new required-signal findings never
        // carry `keystone` (task 6b88ec87 review round 2, finding 3) — a
        // typed task's missing signal alone must never threshold-independently
        // block a claim.
        expect(finding?.keystone).toBeUndefined();
        expect(result.blocking).toBe(false);
      });
    }
  });
});

/**
 * resolveEffectiveThreshold — cross-package parity (task f186b88b).
 *
 * The frontend gained its own mirror of the backend's threshold-hierarchy
 * resolver (global -> project -> taskType) specifically so the TaskDetail
 * badge can show the SAME below/above-threshold verdict the /start claim
 * gate will enforce for a typed task with a per-type confidenceThreshold
 * override. Same cross-package-import mechanism as the calculateConfidence
 * parity suite above: import the real backend source directly and run it
 * side by side with the frontend copy over a shared case matrix.
 */
describe("resolveEffectiveThreshold — cross-package parity (backend vs frontend, task f186b88b)", () => {
  const CASES: Array<{
    name: string;
    taskType: string | undefined;
    taskTypeThresholds: unknown;
    projectThreshold: number | null | undefined;
  }> = [
    { name: "no taskType -> project layer", taskType: undefined, taskTypeThresholds: { security: 90 }, projectThreshold: 60 },
    { name: "taskType with a matching override -> taskType layer", taskType: "security", taskTypeThresholds: { security: 90 }, projectThreshold: 60 },
    { name: "taskType with NO override for that type -> project layer", taskType: "docs", taskTypeThresholds: { security: 90 }, projectThreshold: 60 },
    { name: "no project threshold, no override -> global default", taskType: "security", taskTypeThresholds: null, projectThreshold: undefined },
    { name: "null taskTypeThresholds -> project layer", taskType: "security", taskTypeThresholds: null, projectThreshold: 75 },
    { name: "corrupted override value (out of range) -> falls through to project layer", taskType: "security", taskTypeThresholds: { security: 999 }, projectThreshold: 60 },
    { name: "prototype-chain key ('constructor') never resolves as an override", taskType: "constructor", taskTypeThresholds: { security: 90 }, projectThreshold: 60 },
    { name: "project threshold missing entirely (undefined) with no override -> global default", taskType: "bugfix", taskTypeThresholds: undefined, projectThreshold: undefined },
  ];

  for (const { name, taskType, taskTypeThresholds, projectThreshold } of CASES) {
    it(`backend and frontend produce an identical result: ${name}`, () => {
      // A couple of CASES deliberately pass a non-TaskType string (e.g.
      // "constructor") to pin the own-property-safe guard on both sides —
      // the cast reflects that intent, it is not a type-safety escape hatch.
      const castTaskType = taskType as TaskType | undefined;
      const backendResult = backendResolveEffectiveThreshold(
        castTaskType,
        taskTypeThresholds,
        projectThreshold,
      );
      const frontendResult = frontendResolveEffectiveThreshold(
        castTaskType,
        taskTypeThresholds,
        projectThreshold,
      );
      expect(frontendResult).toStrictEqual(backendResult);
    });
  }
});
