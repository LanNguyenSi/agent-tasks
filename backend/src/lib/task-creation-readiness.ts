/**
 * Task-creation readiness — the per-project knobs an agent needs to know BEFORE
 * it composes a task, so it can supply the structured spec fields the confidence
 * scorer (and, in BLOCK mode, the pickup gate) expects.
 *
 * Surfaced as a `taskCreation` block on the discovery endpoints
 * (`GET /api/projects/:id` and `/effective-gates`, backing the `projects_get` /
 * `projects_get_effective_gates` MCP verbs), next to `effectiveGates`. This is
 * the non-deprecated way to answer "is task-template mode enabled, and which
 * structured fields does this project require?" — previously only readable off
 * the full (deprecated) project payload.
 *
 * Read-only summary; it never blocks. A low-readiness claim is still enforced by
 * the confidence gate at task_pickup/task_start (see services/confidence-gate.ts),
 * governed by `enforcementMode`. Create itself stays informational by design.
 */
import type { TemplateFields } from "./confidence.js";
import {
  resolveEnforcementMode,
  type EnforcementMode,
  type EnforcementModeLike,
} from "./enforcement-mode.js";

/** Rollout default when a project has never set `confidenceThreshold`. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 60;

export interface TaskCreationReadiness {
  /** Effective enforcement mode (OFF | WARN | BLOCK); WARN when unset. */
  enforcementMode: EnforcementMode;
  /** Minimum confidence score a claim needs once enforcementMode is BLOCK. */
  confidenceThreshold: number;
  /** True when the project marks at least one template field as required. */
  templateModeEnabled: boolean;
  /**
   * The template fields the project marks required, e.g.
   * ["goal", "acceptanceCriteria"]. Empty when template mode is off.
   */
  requiredFields: (keyof TemplateFields)[];
}

export interface TaskCreationProjectLike extends EnforcementModeLike {
  taskTemplate?: unknown;
  confidenceThreshold?: number | null;
}

/**
 * Summarize the task-creation knobs from whatever slice of a Project row the
 * caller has. Tolerant of missing/null columns so a partial `select` is fine.
 * Never throws.
 */
export function describeTaskCreation(
  project: TaskCreationProjectLike,
): TaskCreationReadiness {
  const tpl = project.taskTemplate as
    | { fields?: TemplateFields }
    | null
    | undefined;
  const fields = tpl?.fields;
  const requiredFields = fields
    ? (Object.keys(fields) as (keyof TemplateFields)[]).filter(
        (k) => fields[k] === true,
      )
    : [];
  return {
    enforcementMode: resolveEnforcementMode(project),
    confidenceThreshold:
      project.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    templateModeEnabled: requiredFields.length > 0,
    requiredFields,
  };
}
