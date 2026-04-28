// Grounding finish-gate. Phase 3 of the grounding-hint integration.
//
// When a debug-flavored task is finished AND its project is opted into the
// gate (`requireGroundingForDebug === true`), the task must:
//   1. Have an active grounding session attached (from Phase 2 auto-start).
//   2. Have at least one evidence-ledger entry tagged with the session id.
//   3. Have advanced the session to or past `claim-evaluation`, so the
//      agent has had a chance to weigh facts before declaring a fix.
//
// The gate is opt-in (default false) because the evidence-ledger db lives
// on the local filesystem of whichever process writes/reads it. In the
// common multi-host deployment (backend on a VPS, agents on user laptops)
// the backend cannot see the agent's writes, so the gate would always fail.
// See docs/adr/0002-grounding-finish-gate.md.

import type { TaskMetadata } from "../../lib/debug-flavor.js";

export const CLAIM_EVALUATION_PHASE = "claim-evaluation";

// Phases that count as "at or past claim-evaluation" given the wrapper's
// mandatorySequence ordering. Source of truth: the wrapper's GroundingPhase
// union. As of @lannguyensi/grounding-wrapper@0.1.0:
//   "scope-resolution" | "doc-resolution" | "evidence-collection" |
//   "claim-evaluation" | "hypothesis-tracking" | "playbook-execution" |
//   "post-incident-review"
export const PHASES_AT_OR_PAST_CLAIM_EVAL: readonly string[] = [
  "claim-evaluation",
  "hypothesis-tracking",
  "playbook-execution",
  "post-incident-review",
];

export type GroundingGateMissing =
  | "sessionStarted"
  | "ledgerEntries"
  | "claimEvaluationPhase";

export interface GroundingGateInput {
  metadata: TaskMetadata;
  project: { requireGroundingForDebug: boolean };
  ledgerSummary: { entryCount: number };
  currentPhase: string | null;
}

export interface GroundingGateResult {
  allowed: boolean;
  missing: GroundingGateMissing[];
  sessionId: string | null;
  currentPhase: string | null;
  entryCount: number;
}

export function evaluateGroundingGate(input: GroundingGateInput): GroundingGateResult {
  // Bypass paths.
  // 1. Project opted out (default). Empty result; the caller should still
  //    audit when this branch fires for a debug task so operators can spot
  //    "the gate would have blocked" without grepping logs.
  if (!input.project.requireGroundingForDebug) {
    return {
      allowed: true,
      missing: [],
      sessionId: null,
      currentPhase: null,
      entryCount: 0,
    };
  }
  // 2. Non-debug task. The gate is debug-flavor-scoped by design; ordinary
  //    feature work should never need a grounding session.
  if (input.metadata.debugFlavor !== true) {
    return {
      allowed: true,
      missing: [],
      sessionId: null,
      currentPhase: null,
      entryCount: 0,
    };
  }

  const sessionId = input.metadata.groundingSessionId ?? null;
  const missing: GroundingGateMissing[] = [];
  if (!sessionId) missing.push("sessionStarted");
  if (input.ledgerSummary.entryCount < 1) missing.push("ledgerEntries");
  if (
    !input.currentPhase ||
    !PHASES_AT_OR_PAST_CLAIM_EVAL.includes(input.currentPhase)
  ) {
    missing.push("claimEvaluationPhase");
  }

  return {
    allowed: missing.length === 0,
    missing,
    sessionId,
    currentPhase: input.currentPhase,
    entryCount: input.ledgerSummary.entryCount,
  };
}
