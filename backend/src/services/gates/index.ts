/**
 * Gate registry — single-import surface for all registered invariants.
 *
 * Two responsibilities:
 *
 *   1. `registry` — the canonical list of gates. Adding a new gate means
 *      registering it here; removal requires a deprecation cycle because
 *      `GateCode` values are wire-visible via `effectiveGates`.
 *
 *   2. `computeEffectiveGates(project)` — per-project projection. For
 *      each registered gate, ask it whether it would evaluate on this
 *      project and why. The result feeds `GET /api/projects/:id` (as a
 *      nested `effectiveGates` field) and the dedicated
 *      `GET /api/projects/:id/effective-gates` endpoint / MCP verb.
 *
 * NOT a runtime dispatcher. Route handlers still import and call the
 * individual check functions directly — centralized dispatch would be a
 * bigger refactor and is deferred. The point of this module is
 * introspection; enforcement consolidation can follow once clients are
 * using the discovery surface.
 */
import type { EffectiveGate, Gate, GateProjectContext } from "./types.js";
import { GateCode } from "./types.js";
import { distinctReviewerGate } from "./distinct-reviewer.js";
import { selfMergeGate } from "./self-merge.js";
import { taskStatusForMergeGate } from "./task-status-for-merge.js";
import { prRepoMatchesProjectGate } from "./pr-repo-matches-project.js";

export { GateCode } from "./types.js";
export type { EffectiveGate, Gate, GateProjectContext } from "./types.js";

export {
  checkDistinctReviewerGate,
  distinctReviewerGate,
  distinctReviewerRejectionMessage,
} from "./distinct-reviewer.js";
export {
  checkSelfMergeGate,
  selfMergeGate,
  selfMergeRejectionMessage,
} from "./self-merge.js";
export {
  checkTaskStatusForMerge,
  taskStatusForMergeGate,
  taskStatusForMergeRejectionMessage,
} from "./task-status-for-merge.js";
export type { TaskStatusForMergeResult } from "./task-status-for-merge.js";
export {
  checkPrRepoMatchesProject,
  prRepoMatchesProjectGate,
  prRepoMatchesProjectRejectionMessage,
} from "./pr-repo-matches-project.js";
export type { PrRepoMatchesProjectResult } from "./pr-repo-matches-project.js";

export const registry: readonly Gate[] = [
  distinctReviewerGate,
  selfMergeGate,
  taskStatusForMergeGate,
  prRepoMatchesProjectGate,
];

/**
 * Projection of the registry for the given project. Returns a record
 * keyed by `GateCode` — deterministic order is NOT guaranteed (JSON
 * serialization preserves insertion, and `registry` is ordered, but
 * clients should key by code rather than relying on array position).
 */
export function computeEffectiveGates(
  project: GateProjectContext,
): Record<GateCode, EffectiveGate> {
  const result = {} as Record<GateCode, EffectiveGate>;
  for (const gate of registry) {
    const { active, because } = gate.describe(project);
    result[gate.code] = {
      code: gate.code,
      name: gate.name,
      active,
      because,
      appliesTo: gate.appliesTo,
    };
  }
  return result;
}
