import type { Context } from "hono";
import { calculateConfidence, type TemplateData, type TemplateFields, type QualityFinding } from "../lib/confidence.js";
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
 * Force semantics (ADR-0011):
 *   - `?force=true` without `forceReason` → 400 bad_request
 *   - `?force=true` with `forceReason` and would-be-blocked score → success +
 *     `task.claim_override_used` audit
 *   - `?force=true` when score >= threshold → success, no audit (not an
 *     override; force is a no-op when the gate would have passed)
 *   - 422 (no force) → success-of-gate=false, `task.claim_blocked_low_readiness`
 *     audit; response carries findings[] + nextActions[]
 */
export async function evaluateConfidenceGate(
  c: Context,
  task: GateTask,
  actor: Actor,
  route: "start" | "claim",
): Promise<GateResult> {
  if (actor.type !== "agent") return { ok: true };

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

  const threshold = task.project.confidenceThreshold;
  const tpl = task.project.taskTemplate as { fields?: TemplateFields } | null;
  const confidence = calculateConfidence({
    title: task.title,
    description: task.description,
    templateData: task.templateData as TemplateData | null,
    templateFields: tpl?.fields ?? null,
  });

  const wouldBlock = confidence.score < threshold;

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
        route,
        actorType: actor.type,
      },
    });
  }

  return { ok: true };
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
