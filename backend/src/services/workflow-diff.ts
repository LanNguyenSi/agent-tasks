/**
 * Pure helpers for computing a small, human-readable diff between two
 * workflow definitions. Used by the audit log so a `workflow.updated`
 * event captures enough to reconstruct what changed without storing
 * the full before/after JSON.
 *
 * Intentionally narrow — we record counts + renamed state names, not
 * a full structural diff. Storing the full definition is wasteful and
 * the audit log isn't the right place for version history (that's a
 * separate feature if it's ever needed).
 */

import type { WorkflowDefinitionShape } from "./default-workflow.js";

export interface WorkflowDiffSummary {
  stateCountBefore: number;
  stateCountAfter: number;
  transitionCountBefore: number;
  transitionCountAfter: number;
  /** State names that existed in `before` but not in `after`. */
  removedStateNames: string[];
  /** State names that exist in `after` but not in `before`. */
  addedStateNames: string[];
  initialStateChanged: boolean;
}

/**
 * Summarize a diff between two workflow definitions for the audit log.
 *
 * Uses set-based symmetric difference for state add/remove — not positional
 * matching — so mid-array insert, mid-array remove, and reorder all produce
 * correct output. A rename shows up as `{removedStateNames: [old],
 * addedStateNames: [new]}`, which is still reconstructible by a human reader
 * and semantically honest (the backend can't distinguish a rename from a
 * remove+add without richer client-side metadata, so we don't pretend to).
 */
export function summarizeWorkflowDiff(
  before: WorkflowDefinitionShape,
  after: WorkflowDefinitionShape,
): WorkflowDiffSummary {
  const beforeNames = new Set(before.states.map((s) => s.name));
  const afterNames = new Set(after.states.map((s) => s.name));
  const removedStateNames: string[] = [];
  const addedStateNames: string[] = [];
  for (const name of beforeNames) {
    if (!afterNames.has(name)) removedStateNames.push(name);
  }
  for (const name of afterNames) {
    if (!beforeNames.has(name)) addedStateNames.push(name);
  }

  return {
    stateCountBefore: before.states.length,
    stateCountAfter: after.states.length,
    transitionCountBefore: before.transitions.length,
    transitionCountAfter: after.transitions.length,
    removedStateNames,
    addedStateNames,
    initialStateChanged: before.initialState !== after.initialState,
  };
}
