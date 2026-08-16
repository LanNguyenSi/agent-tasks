import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateConfidence as backendCalculateConfidence } from "../../../backend/src/lib/confidence";
import { calculateConfidence as frontendCalculateConfidence } from "./confidence";
import { CONFIDENCE_PARITY_FIXTURES } from "../../../shared/confidence-fixtures";

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
 * shared/confidence-fixtures.ts, asserting the full result — score,
 * missing[], blocking, subscores, findings, inferredTaskType — is
 * byte-for-byte identical for every fixture. A one-sided edit (e.g. a
 * FIELD_WEIGHTS tune applied to only one copy) fails HERE instead of
 * drifting silently.
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

  it("the corpus covers at least the 8 existing parity fixtures plus the fully sectioned SECTIONED_DESC case", () => {
    expect(CONFIDENCE_PARITY_FIXTURES.length).toBeGreaterThanOrEqual(9);
    expect(CONFIDENCE_PARITY_FIXTURES.some((f) => f.name === "sectioned-desc")).toBe(true);
  });

  for (const { name, input } of CONFIDENCE_PARITY_FIXTURES) {
    it(`backend and frontend produce an identical result: ${name}`, () => {
      const backendResult = backendCalculateConfidence(input);
      const frontendResult = frontendCalculateConfidence(input);
      // Whole-object deep equality: covers score, missing[], blocking,
      // subscores, findings, and inferredTaskType in a single assertion, so
      // a divergence in ANY of them fails this test.
      expect(frontendResult).toEqual(backendResult);
    });
  }
});
