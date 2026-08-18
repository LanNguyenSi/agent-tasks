import type { Context } from "hono";
import {
  calculateConfidence,
  resolveEffectiveThreshold,
  resolveTriggeredRiskModifiers,
  combineEffectiveThreshold,
  type TemplateData,
  type TemplateFields,
} from "../lib/confidence.js";
import { resolveEnforcementMode, EnforcementMode } from "../lib/enforcement-mode.js";
import { lowConfidence } from "../middleware/error.js";
import { logAuditEvent } from "./audit.js";
import type { Actor } from "../types/auth.js";
import { claimPolicyEvaluator } from "./claim-policy-evaluator.js";

// deriveNextActions moved to claim-policy-evaluator.ts (it feeds the evaluator's
// block decision). Re-exported here so existing importers — routes/tasks.ts and
// the confidence-gate unit test — keep their import site unchanged.
export { deriveNextActions } from "./claim-policy-evaluator.js";

type GateTask = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  templateData: unknown;
  // M3 (task 8e88cfc0): the risk-modifier text detectors read the task's OWN
  // labels (touchesAuth/touchesDatabase/touchesPersonalData match on
  // `description`; productionImpact also checks `labels`). Required, same
  // rationale as `taskTypeThresholds` below: a caller that forgets to select
  // `labels` gets a compile error, not a silently-empty detector input.
  labels: string[];
  project: {
    confidenceThreshold: number;
    taskTemplate: unknown;
    enforcementMode?: EnforcementMode | string | null;
    // M2 (task b8629b99): per-task-type threshold override, unvalidated Json
    // read (see resolveEffectiveThreshold's own-property-safe guard).
    // Required (not optional): every current caller already selects it, and
    // making it required turns a dropped `taskTypeThresholds: true` in a
    // future /start or /claim select into a compile-time TS2345, not a
    // silent runtime fallback to the project layer.
    taskTypeThresholds: unknown;
    // M3 (task 8e88cfc0): opt-in risk-modifier point config, unvalidated Json
    // read (see resolveTriggeredRiskModifiers). Required for the same reason
    // taskTypeThresholds is: a dropped `riskModifiers: true` select becomes a
    // compile error here rather than a silent "no modifiers ever trigger".
    riskModifiers: unknown;
  };
};

type GateResult =
  | { ok: true }
  | { ok: false; response: Response };

/**
 * Pre-claim confidence check. Gates only agent claims (humans get a UI warning
 * instead). Used by /tasks/:id/start and the legacy /claim path so the two
 * stay in lockstep.
 *
 * This is the HTTP adapter around {@link ClaimPolicyEvaluator}: it resolves the
 * enforcement mode, decides whether the policy even applies (human actors and
 * `OFF` projects short-circuit before any compute), gathers the inputs
 * (confidence report + force query params), delegates the verdict to the
 * evaluator, then translates the returned `ClaimDecision` into audit writes and
 * an HTTP response. The decision logic itself lives in the evaluator.
 *
 * Per-project enforcementMode (scorer-v2 T5) decides what a low-readiness claim
 * does:
 *   - `OFF`   — advisory: never block, never audit. Skipped here before compute.
 *   - `WARN`  — compute; if it WOULD block, emit a `task.claim_would_block_shadow`
 *               audit (the shadow signal) but allow the claim. The rollout
 *               default; `null` resolves to WARN.
 *   - `BLOCK` — block (422) below threshold OR on a violated keystone
 *               (`ConfidenceResult.blocking`, threshold-independent).
 *
 * Force semantics (BLOCK mode only — force is moot when nothing blocks):
 *   - `?force=true` WITHOUT the `confidence:override` scope → 403 forbidden.
 *   - `?force=true` (with scope) without `forceReason` → 400 bad_request.
 *   - `?force=true` (with scope) + reason on a would-block → success +
 *     `task.claim_override_used` (audit records the operator identity).
 *   - no force on a would-block → 422 + `task.claim_blocked_low_readiness`;
 *     response carries findings[] + nextActions[].
 *
 * Grandfathering: the gate fires only on the open→in_progress claim edge, so a
 * task already in_progress is never re-evaluated when a project flips to BLOCK.
 */
export async function evaluateConfidenceGate(
  c: Context,
  task: GateTask,
  actor: Actor,
  route: "start" | "claim",
): Promise<GateResult> {
  if (actor.type !== "agent") return { ok: true };

  const mode = resolveEnforcementMode(task.project);

  // OFF: fully advisory — skip the gate entirely (no compute, no audit).
  if (mode === EnforcementMode.OFF) return { ok: true };

  const tpl = task.project.taskTemplate as { fields?: TemplateFields } | null;
  const report = calculateConfidence({
    title: task.title,
    description: task.description,
    templateData: task.templateData as TemplateData | null,
    templateFields: tpl?.fields ?? null,
  });

  // M2 (task b8629b99): layered threshold hierarchy — a per-task-type
  // override (keyed on the EXPLICIT taskType the scorer already echoes as
  // `report.inferredTaskType`) beats the flat project threshold, which beats
  // the global default. This is the BASE the evaluator adds M3 risk-modifier
  // points on top of below — it is not itself the final gating number once
  // risk modifiers are in play (see `decision.effectiveThreshold`).
  const { effectiveThreshold: baseThreshold, thresholdSource } = resolveEffectiveThreshold(
    report.inferredTaskType,
    task.project.taskTypeThresholds,
    task.project.confidenceThreshold,
  );

  // force is meaningful only in BLOCK; the evaluator ignores it under WARN.
  const force = c.req.query("force") === "true";
  const forceReason = c.req.query("forceReason")?.trim() ?? "";

  const decision = claimPolicyEvaluator.evaluate({
    task: { id: task.id, projectId: task.projectId, description: task.description, labels: task.labels },
    report,
    projectPolicy: { mode, threshold: baseThreshold, thresholdSource, riskModifiers: task.project.riskModifiers },
    actor,
    force,
    forceReason,
    route,
  });

  switch (decision.kind) {
    case "allow":
      if (decision.audit) {
        void logAuditEvent(decision.audit);
      } else {
        // M5 (task 698eeb01): the evaluator's clean-allow branches (nothing
        // would block, or force was a no-op) never return an `audit` — record
        // a lighter-weight snapshot anyway so calibration telemetry has a
        // claim-time score for the common "claim went cleanly" case too (see
        // the `task.claim_confidence_recorded` doc comment in services/
        // audit.ts). Recomputes the SAME risk-modifier resolution the
        // evaluator just ran a moment ago rather than reading it off
        // `decision` (whose `allow` variant does not carry it) — duplicated
        // here instead of widening ClaimDecision's public shape for this one
        // downstream consumer. `threshold` is deliberately local to this
        // else-branch, not `baseThreshold`: the pre-modifier number would
        // understate the true gating threshold for a task that triggered a
        // modifier but still passed.
        const { triggeredRiskModifiers, riskModifierPoints } = resolveTriggeredRiskModifiers(
          { description: task.description, labels: task.labels },
          task.project.riskModifiers,
        );
        void logAuditEvent({
          action: "task.claim_confidence_recorded",
          actorId: actor.tokenId,
          projectId: task.projectId,
          taskId: task.id,
          payload: {
            score: report.score,
            threshold: combineEffectiveThreshold(baseThreshold, riskModifierPoints),
            thresholdSource,
            triggeredRiskModifiers,
            route,
            actorType: actor.type,
          },
        });
      }
      return { ok: true };
    case "block_low_readiness":
      void logAuditEvent(decision.audit);
      return {
        ok: false,
        response: lowConfidence(c, {
          ...report,
          threshold: decision.effectiveThreshold,
          // M2 (task b8629b99): `threshold` is kept (== effectiveThreshold) for
          // BC with existing consumers; these two additive fields let a caller
          // tell which layer of the hierarchy actually produced the number.
          // M3 (task 8e88cfc0): both now reflect the FINAL, post-risk-modifier
          // number (`decision.effectiveThreshold`, not the pre-modifier
          // `baseThreshold` local above) — `triggeredRiskModifiers` names which
          // modifiers, if any, raised it above the M2 base.
          effectiveThreshold: decision.effectiveThreshold,
          thresholdSource,
          triggeredRiskModifiers: decision.triggeredRiskModifiers,
          nextActions: decision.nextActions,
        }),
      };
    case "force_forbidden":
      return {
        ok: false,
        response: c.json({ error: "forbidden", message: decision.message }, 403),
      };
    case "force_reason_too_short":
      return {
        ok: false,
        response: c.json({ error: "bad_request", message: decision.message }, 400),
      };
    default:
      // Exhaustiveness guard: a future `ClaimDecision.kind` added to the
      // evaluator without a matching case here is a COMPILE error (the
      // argument is not assignable to `never`), not a runtime `undefined`.
      return assertNever(decision);
  }
}

/** Minimal local exhaustiveness helper: no shared `assertNever` exists in this
 *  codebase, so it is defined locally. Never called at runtime; its only job is
 *  to make an unhandled `ClaimDecision.kind` a compile error. */
function assertNever(value: never): never {
  throw new Error(`Unhandled ClaimDecision.kind: ${JSON.stringify(value)}`);
}
