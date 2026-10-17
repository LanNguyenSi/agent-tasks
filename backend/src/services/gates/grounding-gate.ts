// Grounding finish-gate. Phase 3 of the grounding-hint integration.
//
// When a debug-flavored task is finished AND its project is opted into the
// gate (`requireGroundingForDebug === true`), the task must:
//   1. Have an active grounding session attached (from Phase 2 auto-start).
//   2. Have at least one evidence-ledger entry tagged with the session id.
//   3. Have advanced the session to or past `claim-evaluation`, so the
//      agent has had a chance to weigh facts before declaring a fix. This
//      third check is optional (`requireClaimEvaluationPhase`, default on).
//      The task finish route turns it off because nothing advances the
//      persisted session phase; the legacy-cohort completion paths keep it.
//
// The gate is opt-in (default false) because the evidence-ledger db lives
// on the local filesystem of whichever process writes/reads it. In the
// common multi-host deployment (backend on a VPS, agents on user laptops)
// the backend cannot see the agent's writes, so the gate would always fail.
// See docs/adr/0013-grounding-finish-gate.md.

import type { TaskMetadata } from "../../lib/debug-flavor.js";

export const CLAIM_EVALUATION_PHASE = "claim-evaluation";

// The pinned legacy wrapper has a fixed phase sequence. Its terminal
// `complete` state follows claim evaluation, while unfamiliar values must not
// inherit compatibility merely because another wrapper version used them.
export const PHASES_AT_OR_PAST_CLAIM_EVAL: readonly string[] = [
  "claim-evaluation",
  "complete",
];

export type GroundingGateMissing =
  | "sessionStarted"
  | "ledgerEntries"
  | "claimEvaluationPhase";

export interface GroundingGateInput {
  metadata: TaskMetadata;
  project: { requireGroundingForDebug: boolean };
  ledgerSummary: { entryCount: number };
  // Only read when `requireClaimEvaluationPhase` is on; may be omitted
  // otherwise.
  currentPhase?: string | null;
  // Default `true`. With `false` the `claimEvaluationPhase` check is skipped.
  requireClaimEvaluationPhase?: boolean;
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
  const currentPhase = input.currentPhase ?? null;
  if (
    (input.requireClaimEvaluationPhase ?? true) &&
    (!currentPhase || !PHASES_AT_OR_PAST_CLAIM_EVAL.includes(currentPhase))
  ) {
    missing.push("claimEvaluationPhase");
  }

  return {
    allowed: missing.length === 0,
    missing,
    sessionId,
    currentPhase,
    entryCount: input.ledgerSummary.entryCount,
  };
}
