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
import {
  GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD,
  resolveEffectiveThreshold,
  taskTypeSchema,
  type EffectiveThreshold,
  type TaskType,
  type TemplateFields,
} from "./confidence.js";
import {
  resolveEnforcementMode,
  type EnforcementMode,
  type EnforcementModeLike,
} from "./enforcement-mode.js";

/** Rollout default when a project has never set `confidenceThreshold`. Same
 *  value as `GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD` (lib/confidence.ts, M2 task
 *  b8629b99's threshold hierarchy) — re-exported under this name so existing
 *  importers are unaffected, rather than a second hard-coded `60`. */
export const DEFAULT_CONFIDENCE_THRESHOLD = GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD;

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
  /**
   * M2 (task f186b88b): the resolved threshold hierarchy for EVERY task
   * type, keyed by TaskType — the same `resolveEffectiveThreshold` the
   * claim gate uses (backend/src/lib/confidence.ts), not a re-derivation.
   * Lets an agent see the per-type override BEFORE it creates a typed task,
   * instead of only discovering it after a claim gets rejected. When the
   * project has no `taskTypeThresholds` override for a given type, that
   * type's entry falls through to the project/global layer exactly like a
   * live claim would.
   *
   * PROJECT-LEVEL ONLY (batch 18 review, MED-5): this is the M2 base for each
   * type, never the M3-adjusted number. M3 risk modifiers (Project.
   * riskModifiers) are evaluated PER TASK, against that task's own
   * description/labels — there is no task here to evaluate them against, so
   * they are intentionally not folded in. A specific task's actual effective
   * claim threshold (see Confidence.triggeredRiskModifiers on create/respec/
   * the 422/instructions) can therefore be higher than what this field shows
   * for its type. Deliberate scope split (project-level discovery vs.
   * per-task gating), not a bug — but it makes this map a lower bound, not a
   * promise.
   */
  taskTypeThresholds: Record<TaskType, EffectiveThreshold>;
}

export interface TaskCreationProjectLike extends EnforcementModeLike {
  taskTemplate?: unknown;
  confidenceThreshold?: number | null;
  /** M2 (task b8629b99): per-task-type threshold override, unvalidated Json
   *  read — see resolveEffectiveThreshold's own-property-safe guard. Optional
   *  (unlike confidence-gate.ts's GateTask) so a partial `select` that omits
   *  it still resolves — every entry just falls through to the project/global
   *  layer, matching the pre-M2 behavior instead of throwing. */
  taskTypeThresholds?: unknown;
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
  const taskTypeThresholds = Object.fromEntries(
    taskTypeSchema.options.map((taskType) => [
      taskType,
      resolveEffectiveThreshold(
        taskType,
        project.taskTypeThresholds,
        project.confidenceThreshold,
      ),
    ]),
  ) as Record<TaskType, EffectiveThreshold>;
  return {
    enforcementMode: resolveEnforcementMode(project),
    confidenceThreshold:
      project.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    templateModeEnabled: requiredFields.length > 0,
    requiredFields,
    taskTypeThresholds,
  };
}
