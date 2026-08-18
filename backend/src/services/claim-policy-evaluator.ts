import {
  calculateConfidence,
  resolveTriggeredRiskModifiers,
  combineEffectiveThreshold,
  type QualityFinding,
  type ThresholdSource,
  type RiskModifierName,
  REQUIRED_SIGNAL_ONLY_CODES,
} from "../lib/confidence.js";
import { EnforcementMode } from "../lib/enforcement-mode.js";
import { SCOPES } from "./scopes.js";
import type { AgentActor } from "../types/auth.js";

/** Minimum length for the operator override reason (`?forceReason=`). */
export const MIN_FORCE_REASON_LENGTH = 10;

/** The confidence report the evaluator scores against (output of the scorer). */
export type ConfidenceReport = ReturnType<typeof calculateConfidence>;

/**
 * A ledger/audit event the evaluator wants recorded for a decision. Data only:
 * the caller performs the side effect (`logAuditEvent`) so the evaluator stays
 * pure and unit-testable without a DB.
 */
export type ClaimAuditEvent = {
  action:
    | "task.claim_would_block_shadow"
    | "task.claim_blocked_low_readiness"
    | "task.claim_override_used";
  actorId: string;
  projectId: string;
  taskId: string;
  payload: Record<string, unknown>;
};

/**
 * The evaluator's verdict for a single claim attempt. The caller translates
 * this to HTTP + audit; the evaluator never touches `Context` or the DB.
 *
 *   - `allow`                 — the claim proceeds. `audit`, when present, is a
 *                               shadow (WARN would-block) or override record to
 *                               log before proceeding.
 *   - `block_low_readiness`   — 422: below threshold or a violated keystone,
 *                               without a valid force. Log `audit`, then deny.
 *   - `force_forbidden`       — 403: force requested without the override scope.
 *   - `force_reason_too_short`— 400: force requested with too short a reason.
 */
export type ClaimDecision =
  | { kind: "allow"; audit?: ClaimAuditEvent }
  | {
      kind: "block_low_readiness";
      audit: ClaimAuditEvent;
      nextActions: string[];
      /**
       * M3 (task 8e88cfc0): the FINAL threshold that actually gated this
       * decision — the M2 base (`projectPolicy.threshold`) plus the summed
       * points of `triggeredRiskModifiers`. Carried on the decision itself
       * (not just inside `audit.payload`) so the HTTP adapter
       * (confidence-gate.ts) can surface it in the 422 response without
       * recomputing it from a stale pre-evaluator local.
       */
      effectiveThreshold: number;
      /** Risk-modifier names that both fired their trigger AND had a valid
       *  point entry in the project's opt-in riskModifiers config. */
      triggeredRiskModifiers: RiskModifierName[];
    }
  | { kind: "force_forbidden"; message: string }
  | { kind: "force_reason_too_short"; message: string };

/** Everything the evaluator needs to reach a verdict, gathered by the caller. */
export type ClaimPolicyInput = {
  /**
   * `description` and `labels` are read-only inputs to the M3 risk-modifier
   * detectors (`resolveTriggeredRiskModifiers`) — the task's OWN fields,
   * never templateData or the goal+context description-equivalent
   * `calculateConfidence` uses for scoring.
   */
  task: { id: string; projectId: string; description: string | null; labels: string[] };
  report: ConfidenceReport;
  /**
   * The resolved project policy. `mode` is already narrowed to the two modes
   * that evaluate a report: OFF short-circuits before compute in the caller.
   * `thresholdSource` (M2, task f186b88b) names which layer of the
   * global -> project -> taskType hierarchy produced `threshold` — carried
   * into every audit payload below so an auditor reading `threshold: 90`
   * can tell it came from a taskType override rather than the project
   * default. Required, not optional: the sole production caller
   * (confidence-gate.ts) already resolves it via `resolveEffectiveThreshold`
   * alongside `threshold`, so a caller that forgets it is a compile error,
   * not a silently-missing audit field.
   *
   * `riskModifiers` (M3, task 8e88cfc0) is the project's opt-in risk-modifier
   * config (`Project.riskModifiers`, raw unvalidated Json — see
   * `resolveTriggeredRiskModifiers`). `threshold` here is still the M2 BASE
   * (pre-modifiers); the evaluator adds the triggered modifiers' points on
   * top of it below.
   */
  projectPolicy: {
    mode: EnforcementMode.WARN | EnforcementMode.BLOCK;
    threshold: number;
    thresholdSource: ThresholdSource;
    riskModifiers: unknown;
  };
  actor: AgentActor;
  force: boolean;
  forceReason: string;
  route: "start" | "claim";
};

/**
 * ClaimPolicyEvaluator (ADR-0011): the named component that turns a confidence
 * report + project policy + actor into a claim verdict. Extracted from
 * `evaluateConfidenceGate` so the M3 risk-modifier / actor-rule layers and the
 * expanded decision states can extend it without re-threading HTTP concerns.
 *
 * Pure: no `Context`, no DB, no side effects. The gate adapter owns request
 * parsing, audit writes, and response construction.
 */
export class ClaimPolicyEvaluator {
  evaluate(input: ClaimPolicyInput): ClaimDecision {
    const { task, report, projectPolicy, actor, force, forceReason, route } = input;
    const { mode, threshold: baseThreshold, thresholdSource, riskModifiers } = projectPolicy;

    // M3 (task 8e88cfc0): risk modifiers stack additively on top of the
    // M2-resolved base threshold. `threshold` below (used in every audit
    // payload and returned to the caller for the 422 response) is always
    // this FINAL, post-modifier number — the M2 base is an internal-only
    // intermediate here, never itself surfaced.
    const { triggeredRiskModifiers, riskModifierPoints } = resolveTriggeredRiskModifiers(
      { description: task.description, labels: task.labels },
      riskModifiers,
    );
    // Clamped to 100 through the ONE shared helper (batch 18 review, MED-2) —
    // an aggressive riskModifiers config on top of a high taskType base can
    // no longer push the gating number past what a score can ever reach.
    const threshold = combineEffectiveThreshold(baseThreshold, riskModifierPoints);

    const belowThreshold = report.score < threshold;
    // Keystone is threshold-INDEPENDENT: lowering the threshold cannot disable it.
    const wouldBlock = belowThreshold || report.blocking;

    // WARN: shadow-log a would-block for blast-radius measurement, but allow it.
    // `force` is irrelevant here (nothing blocks), so it is neither parsed nor
    // validated — a would-block claim succeeds regardless.
    if (mode === EnforcementMode.WARN) {
      if (wouldBlock) {
        return {
          kind: "allow",
          audit: {
            action: "task.claim_would_block_shadow",
            actorId: actor.tokenId,
            projectId: task.projectId,
            taskId: task.id,
            payload: {
              score: report.score,
              threshold,
              thresholdSource,
              triggeredRiskModifiers,
              belowThreshold,
              keystoneBlocked: report.blocking,
              caps: triggeredCapCodes(report.findings),
              missing: report.missing,
              route,
              actorType: actor.type,
            },
          },
        };
      }
      return { kind: "allow" };
    }

    // BLOCK — force is meaningful only here (BLOCK is the only mode that blocks).

    // scorer-v2 (T6): force is a privileged OPERATOR override, not a self-service
    // agent bypass. Require the `confidence:override` scope, which an ordinary
    // task-executing token does not carry — and cannot grant itself, since token
    // creation is team-admin-only. Without this, the gated actor could wave itself
    // through with any 10-char reason, making the gate advisory for the exact actor
    // it targets. Checked before the reason-length validation: lacking the
    // capability is more fundamental than a malformed reason.
    if (force && !actor.scopes.includes(SCOPES.ConfidenceOverride)) {
      return {
        kind: "force_forbidden",
        message: `force=true requires the '${SCOPES.ConfidenceOverride}' scope (an operator must mint a token with it). Improve the task to meet the confidence threshold, or have an operator claim it.`,
      };
    }

    if (force && forceReason.length < MIN_FORCE_REASON_LENGTH) {
      return {
        kind: "force_reason_too_short",
        message: `force=true requires forceReason of at least ${MIN_FORCE_REASON_LENGTH} characters`,
      };
    }

    if (!force && wouldBlock) {
      return {
        kind: "block_low_readiness",
        nextActions: deriveNextActions(report.findings),
        effectiveThreshold: threshold,
        triggeredRiskModifiers,
        audit: {
          action: "task.claim_blocked_low_readiness",
          actorId: actor.tokenId,
          projectId: task.projectId,
          taskId: task.id,
          payload: {
            score: report.score,
            threshold,
            thresholdSource,
            triggeredRiskModifiers,
            keystoneBlocked: report.blocking,
            missing: report.missing,
            findings: report.findings,
            route,
            actorType: actor.type,
          },
        },
      };
    }

    if (force && wouldBlock) {
      return {
        kind: "allow",
        audit: {
          action: "task.claim_override_used",
          actorId: actor.tokenId,
          projectId: task.projectId,
          taskId: task.id,
          payload: {
            score: report.score,
            threshold,
            thresholdSource,
            triggeredRiskModifiers,
            forceReason,
            keystoneBlocked: report.blocking,
            missing: report.missing,
            // Operator identity behind the override: the token (actorId) plus the
            // user the token authenticates as. Lets an audit pin who waved it through.
            operatorUserId: actor.userId,
            route,
            actorType: actor.type,
          },
        },
      };
    }

    return { kind: "allow" };
  }
}

/** Shared stateless instance for callers that do not need their own. */
export const claimPolicyEvaluator = new ClaimPolicyEvaluator();

/** Cap/finding codes that actually fired (severity above info), for the shadow
 *  audit's "which cap" breakdown. */
function triggeredCapCodes(findings: QualityFinding[]): string[] {
  return findings.filter((f) => f.severity !== "info").map((f) => f.code);
}

/**
 * Turn QualityFindings into a short, prioritised list of human-readable next
 * actions. Blocking findings come first, then warnings. Deduplicated by
 * suggestion text; capped at 5 so the response stays scannable.
 *
 * Within a severity tier, a UNIVERSAL finding (title/description/goal/AC/
 * scope/outOfScope/dependencies/risk/agentPrompt — including a per-taskType
 * required-signal finding that ALIASES one of those, see confidence.ts's
 * REQUIRED_SIGNALS_BY_TYPE header comment) sorts ahead of a genuinely
 * type-specific prose finding (`REQUIRED_SIGNAL_ONLY_CODES`, M2). Without
 * this, a typed task with many missing required signals can crowd the
 * universal scope/agentPrompt/AC guidance entirely out of the 5-item cap
 * below, even though fixing the universal gaps is the more foundational
 * advice.
 */
export function deriveNextActions(findings: QualityFinding[]): string[] {
  const SEVERITY_RANK: Record<QualityFinding["severity"], number> = {
    blocking: 0,
    warning: 1,
    info: 2,
  };
  const typeSpecificRank = (f: QualityFinding) => (REQUIRED_SIGNAL_ONLY_CODES.has(f.code) ? 1 : 0);
  const sorted = [...findings].sort((a, b) => {
    const severityDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return typeSpecificRank(a) - typeSpecificRank(b);
  });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of sorted) {
    if (!f.suggestion) continue;
    if (seen.has(f.suggestion)) continue;
    seen.add(f.suggestion);
    out.push(f.suggestion);
    if (out.length >= 5) break;
  }
  return out;
}
