import type { Context } from "hono";
import { calculateConfidence, type TemplateData, type TemplateFields, type QualityFinding } from "../lib/confidence.js";
import { resolveEnforcementMode, EnforcementMode } from "../lib/enforcement-mode.js";
import { lowConfidence } from "../middleware/error.js";
import { logAuditEvent } from "./audit.js";
import type { Actor } from "../types/auth.js";

const MIN_FORCE_REASON_LENGTH = 10;

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
 * Per-project enforcementMode (scorer-v2 T5) decides what a low-readiness claim
 * does:
 *   - `OFF`   — advisory: never block, never audit. Surfacing happens elsewhere.
 *   - `WARN`  — compute; if it WOULD block, emit a `task.claim_would_block_shadow`
 *               audit (the shadow signal) but allow the claim. The rollout
 *               default; `null` resolves to WARN.
 *   - `BLOCK` — block (422) below threshold OR on a violated keystone
 *               (`ConfidenceResult.blocking`, threshold-independent).
 *
 * "Low-readiness" = score < threshold OR a hard keystone is violated. The
 * keystone clause is what stops a project from silently disabling the eval
 * keystone by lowering its threshold.
 *
 * Force semantics (BLOCK mode only — force is moot when nothing blocks):
 *   - `?force=true` without `forceReason` → 400 bad_request
 *   - `?force=true` + reason on a would-block → success + `task.claim_override_used`
 *   - `?force=true` when nothing would block → success, no audit (no-op)
 *   - no force on a would-block → 422 + `task.claim_blocked_low_readiness`;
 *     response carries findings[] + nextActions[]
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
  const confidence = calculateConfidence({
    title: task.title,
    description: task.description,
    templateData: task.templateData as TemplateData | null,
    templateFields: tpl?.fields ?? null,
  });

  const belowThreshold = confidence.score < threshold;
  // Keystone is threshold-INDEPENDENT: lowering the threshold cannot disable it.
  const wouldBlock = belowThreshold || confidence.blocking;

  // WARN: shadow-log a would-block for blast-radius measurement, but allow it.
  // `force` is irrelevant here (nothing blocks), so it is neither parsed nor
  // validated — a would-block claim succeeds regardless.
  if (mode === EnforcementMode.WARN) {
    if (wouldBlock) {
      void logAuditEvent({
        action: "task.claim_would_block_shadow",
        actorId: actor.tokenId,
        projectId: task.projectId,
        taskId: task.id,
        payload: {
          score: confidence.score,
          threshold,
          belowThreshold,
          keystoneBlocked: confidence.blocking,
          caps: triggeredCapCodes(confidence.findings),
          missing: confidence.missing,
          route,
          actorType: actor.type,
        },
      });
    }
    return { ok: true };
  }

  // BLOCK — force is meaningful only here (BLOCK is the only mode that blocks).
  const force = c.req.query("force") === "true";
  const forceReason = c.req.query("forceReason")?.trim() ?? "";
  if (force && forceReason.length < MIN_FORCE_REASON_LENGTH) {
    return {
      ok: false,
      response: c.json(
        {
          error: "bad_request",
          message: `force=true requires forceReason of at least ${MIN_FORCE_REASON_LENGTH} characters`,
        },
        400,
      ),
    };
  }

  if (!force && wouldBlock) {
    const nextActions = deriveNextActions(confidence.findings);
    void logAuditEvent({
      action: "task.claim_blocked_low_readiness",
      actorId: actor.tokenId,
      projectId: task.projectId,
      taskId: task.id,
      payload: {
        score: confidence.score,
        threshold,
        keystoneBlocked: confidence.blocking,
        missing: confidence.missing,
        findings: confidence.findings,
        route,
        actorType: actor.type,
      },
    });
    return {
      ok: false,
      response: lowConfidence(c, { ...confidence, threshold, nextActions }),
    };
  }

  if (force && wouldBlock) {
    void logAuditEvent({
      action: "task.claim_override_used",
      actorId: actor.tokenId,
      projectId: task.projectId,
      taskId: task.id,
      payload: {
        score: confidence.score,
        threshold,
        forceReason,
        keystoneBlocked: confidence.blocking,
        missing: confidence.missing,
        route,
        actorType: actor.type,
      },
    });
  }

  return { ok: true };
}

/** Cap/finding codes that actually fired (severity above info), for the shadow
 *  audit's "which cap" breakdown. */
function triggeredCapCodes(findings: QualityFinding[]): string[] {
  return findings.filter((f) => f.severity !== "info").map((f) => f.code);
}

/**
 * Turn QualityFindings into a short, prioritised list of human-readable next
 * actions. Blocking findings come first, then warnings. Deduplicated by
 * suggestion text; capped at 5 so the response stays scannable.
 */
export function deriveNextActions(findings: QualityFinding[]): string[] {
  const SEVERITY_RANK: Record<QualityFinding["severity"], number> = {
    blocking: 0,
    warning: 1,
    info: 2,
  };
  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
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
