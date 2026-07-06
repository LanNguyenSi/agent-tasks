import type { Context } from "hono";
import { calculateConfidence, type TemplateData, type TemplateFields } from "../lib/confidence.js";
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
  project: {
    confidenceThreshold: number;
    taskTemplate: unknown;
    enforcementMode?: EnforcementMode | string | null;
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

  const threshold = task.project.confidenceThreshold;
  const tpl = task.project.taskTemplate as { fields?: TemplateFields } | null;
  const report = calculateConfidence({
    title: task.title,
    description: task.description,
    templateData: task.templateData as TemplateData | null,
    templateFields: tpl?.fields ?? null,
  });

  // force is meaningful only in BLOCK; the evaluator ignores it under WARN.
  const force = c.req.query("force") === "true";
  const forceReason = c.req.query("forceReason")?.trim() ?? "";

  const decision = claimPolicyEvaluator.evaluate({
    task: { id: task.id, projectId: task.projectId },
    report,
    projectPolicy: { mode, threshold },
    actor,
    force,
    forceReason,
    route,
  });

  switch (decision.kind) {
    case "allow":
      if (decision.audit) void logAuditEvent(decision.audit);
      return { ok: true };
    case "block_low_readiness":
      void logAuditEvent(decision.audit);
      return {
        ok: false,
        response: lowConfidence(c, { ...report, threshold, nextActions: decision.nextActions }),
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
