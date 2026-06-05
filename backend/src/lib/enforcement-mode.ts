/**
 * Confidence-gate enforcement-mode helpers (scorer-v2, T5).
 *
 * `enforcementMode` is a per-project knob controlling what the confidence gate
 * does with a low-readiness agent claim:
 *
 *   - `OFF`   — advisory only. The score is computed and surfaced, but an agent
 *               is never blocked.
 *   - `WARN`  — compute + surface + shadow-log would-blocks, but never block.
 *               The safe-rollout default.
 *   - `BLOCK` — block agent claims below the project threshold AND on a violated
 *               keystone (`ConfidenceResult.blocking`) regardless of threshold.
 *
 * Existing rows have `enforcementMode: null` until they're next written.
 * `resolveEnforcementMode` returns the column when set and otherwise defaults to
 * `WARN`, so the scorer-v2 rollout lands every project in warn-mode without a
 * backfill (mirrors `governance-mode.ts`). Call-sites should use this helper
 * rather than reading the column directly.
 */
export enum EnforcementMode {
  OFF = "OFF",
  WARN = "WARN",
  BLOCK = "BLOCK",
}

/** The rollout default for a project that has never set the column. */
export const DEFAULT_ENFORCEMENT_MODE = EnforcementMode.WARN;

export interface EnforcementModeLike {
  enforcementMode?: EnforcementMode | string | null;
}

/**
 * Resolve the effective enforcement mode, preferring the explicit column and
 * falling back to the rollout default (`WARN`) when null/unknown. Accepts a
 * broad shape so any route/service can pass whatever slice of `Project` it has.
 */
export function resolveEnforcementMode(project: EnforcementModeLike): EnforcementMode {
  const value = project.enforcementMode;
  if (value && value in EnforcementMode) {
    return EnforcementMode[value as keyof typeof EnforcementMode];
  }
  // Null, undefined, or an unrecognised DB value: stay safe in WARN rather than
  // throw, keeping the runtime self-healing.
  return DEFAULT_ENFORCEMENT_MODE;
}

/** True when the mode hard-blocks low-readiness claims (only `BLOCK`). */
export function enforcementBlocks(mode: EnforcementMode): boolean {
  return mode === EnforcementMode.BLOCK;
}
