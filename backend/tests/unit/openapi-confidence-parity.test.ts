/**
 * Drift guard: the OpenAPI `Confidence` schema in backend/src/routes/docs.ts
 * is a hand-written object shared by four response surfaces — task_create
 * (201), task_respec (200), the low-confidence 422's `LowConfidenceError.
 * details`, and GET /tasks/:id/instructions — each of which ASSEMBLES its own
 * `confidence` object by hand from the same set of pure functions
 * (calculateConfidence, resolveEffectiveThreshold,
 * resolveTriggeredRiskModifiers, combineEffectiveThreshold,
 * deriveNextActions) in backend/src/routes/tasks.ts.
 *
 * Unlike GET /projects/:id/effective-gates (openapi-effective-gates-
 * parity.test.ts), there is no single `computeConfidenceResponse()` function
 * to import and diff the schema against — the pattern in that file does not
 * transfer directly because the object is assembled at four call sites, not
 * produced by one. This test instead assembles the SAME field set those pure
 * functions produce for a fixture task (mirroring what task_create's route
 * handler does line for line) and diffs it against the Confidence schema's
 * declared keys — the same "key parity" guarantee, adapted to the
 * multi-call-site shape. Added batch 18 review, MED-4 (task 8e88cfc0), after
 * `triggeredRiskModifiers` (M3) was added to the schema by hand with no test
 * pinning it against the real fields, exactly the kind of drift this guards.
 *
 * Scope: key parity, the required set, and the triggeredRiskModifiers enum
 * against RISK_MODIFIER_NAMES. Value-level drift beyond that (types,
 * min/max, examples) is intentionally NOT checked, matching the sibling
 * openapi-*-parity tests' stated scope.
 */
import { describe, it, expect } from "vitest";
import { openApiSpec } from "../../src/routes/docs.js";
import {
  calculateConfidence,
  resolveEffectiveThreshold,
  resolveTriggeredRiskModifiers,
  combineEffectiveThreshold,
  RISK_MODIFIER_NAMES,
  type TemplateData,
} from "../../src/lib/confidence.js";
import { deriveNextActions } from "../../src/services/claim-policy-evaluator.js";

// Same worked example the M3 route tests use (tasks-v2-routes.test.ts's
// AUTH_RISK_TASK / PRODUCTION_LABEL_RISK_TASK): a task whose "production"
// label fires the productionImpact modifier with no matching text keyword,
// so the fixture exercises the label channel too, not just the additive sum.
const FIXTURE_TASK = {
  title: "Ship the feature behind a flag",
  description: "Roll out the new dashboard widget behind a feature flag and verify with a smoke test.",
  templateData: null as TemplateData | null,
  labels: ["production"],
};

const FIXTURE_PROJECT = {
  confidenceThreshold: 60,
  taskTypeThresholds: null as unknown,
  riskModifiers: { productionImpact: 10 } as unknown,
};

describe("OpenAPI Confidence schema <-> real assembled response parity", () => {
  const conf = calculateConfidence({
    title: FIXTURE_TASK.title,
    description: FIXTURE_TASK.description,
    templateData: FIXTURE_TASK.templateData,
    templateFields: null,
  });
  const { effectiveThreshold: baseThreshold, thresholdSource } = resolveEffectiveThreshold(
    conf.inferredTaskType,
    FIXTURE_PROJECT.taskTypeThresholds,
    FIXTURE_PROJECT.confidenceThreshold,
  );
  const { triggeredRiskModifiers, riskModifierPoints } = resolveTriggeredRiskModifiers(
    { description: FIXTURE_TASK.description, labels: FIXTURE_TASK.labels },
    FIXTURE_PROJECT.riskModifiers,
  );
  const effectiveThreshold = combineEffectiveThreshold(baseThreshold, riskModifierPoints);

  // The exact field set every Confidence-emitting route assembles (matches
  // task_create's `confidence` object literal in routes/tasks.ts key for key).
  const assembled = {
    score: conf.score,
    missing: conf.missing,
    threshold: effectiveThreshold,
    effectiveThreshold,
    thresholdSource,
    triggeredRiskModifiers,
    blocking: conf.blocking,
    nextActions: deriveNextActions(conf.findings),
    findings: conf.findings,
  };

  const schema = openApiSpec.components.schemas.Confidence;

  it("documents exactly the keys every Confidence-emitting surface assembles", () => {
    // If this fails, a field was added to (or removed from) what
    // task_create/task_respec/the 422/instructions actually return without a
    // matching update to the Confidence schema in docs.ts, or vice versa.
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(assembled).sort());
  });

  it("required lists exactly the fields every surface always populates", () => {
    expect([...schema.required].sort()).toEqual(
      [
        "score",
        "missing",
        "threshold",
        "blocking",
        "effectiveThreshold",
        "thresholdSource",
        "triggeredRiskModifiers",
      ].sort(),
    );
  });

  it("triggeredRiskModifiers.items.enum documents exactly RISK_MODIFIER_NAMES", () => {
    // Mutation probe target: add a fifth modifier to RISK_MODIFIER_NAMES (or
    // rename one) without touching docs.ts and this assertion goes red.
    expect([...schema.properties.triggeredRiskModifiers.items.enum].sort()).toEqual(
      [...RISK_MODIFIER_NAMES].sort(),
    );
  });

  it("the fixture's assembled response matches what the schema documents: the label-only productionImpact modifier fires and clamps within bounds", () => {
    expect(assembled.triggeredRiskModifiers).toEqual(["productionImpact"]);
    expect(assembled.effectiveThreshold).toBe(70);
    expect(schema.properties.effectiveThreshold.maximum).toBe(100);
  });
});
