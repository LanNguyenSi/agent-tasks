/**
 * Client-side copy of the state rules the backend enforces on a workflow
 * definition (`workflowDefinitionSchema` in backend/src/routes/workflows.ts).
 * The frontend imports nothing from the backend, so the constants are restated
 * here and `StateRules.test.ts` pins them against the backend source and the
 * same accepted and refused examples. The server stays the source of truth:
 * these checks only spare the admin a round trip, and a server answer is
 * still shown as it came.
 *
 * Name format and duplicate-name / missing-state checks that
 * `validateDefinition` (lib/workflow-draft.ts) already runs are not repeated
 * in `validateStateRules`; `validateStateName` is the per-keystroke check the
 * name input uses and covers the format too, so an invalid name never reaches
 * the draft (and never half-rewrites the transitions that follow a rename).
 */

import type { WorkflowDefinition } from "../../../../../lib/api";
import { STATE_NAME_RE } from "../../../../../lib/workflow-draft";

/** Longest accepted state name (backend `STATE_NAME_MAX_LENGTH`). */
export const STATE_NAME_MAX_LENGTH = 64;

/** Names the backend refuses as a state or as an edge end (backlog and abandoned). */
export const RESERVED_STATE_NAMES = ["backlog", "abandoned"] as const;

/** The engine keys pickup, start and reopen on this status; the initial state must be it. */
export const WORKFLOW_INITIAL_STATE = "open";

function isReserved(name: string): boolean {
  return (RESERVED_STATE_NAMES as readonly string[]).includes(name);
}

function reservedMessage(name: string): string {
  return (
    `State name "${name}" is reserved. ` +
    `${RESERVED_STATE_NAMES.join(" and ")} are managed outside the workflow graph ` +
    `and cannot be declared as workflow states.`
  );
}

/**
 * Check one state name against the rules the backend applies, given the other
 * states of the definition. Returns the message to show, or null when the name
 * is acceptable. `index` is the row being edited (its own current name does
 * not count as a duplicate).
 */
export function validateStateName(
  name: string,
  def: WorkflowDefinition,
  index: number,
): string | null {
  if (name.length === 0) return "State name cannot be empty.";
  if (name.length > STATE_NAME_MAX_LENGTH) {
    return `State name must be at most ${STATE_NAME_MAX_LENGTH} characters.`;
  }
  if (!STATE_NAME_RE.test(name)) {
    return `State name "${name}" must match [a-z0-9_]+ (lowercase, digits, underscore).`;
  }
  if (def.states.some((s, i) => i !== index && s.name === name)) {
    return `Duplicate state name: "${name}".`;
  }
  if (isReserved(name)) return reservedMessage(name);
  return null;
}

/**
 * Definition-level errors the backend raises and `validateDefinition` does
 * not: reserved names (as a state or an edge end), the pinned initial state,
 * an initial state that is terminal, and a definition without a terminal
 * state. Merged with `validateDefinition`'s errors by the page.
 */
export function validateStateRules(def: WorkflowDefinition): string[] {
  const errors: string[] = [];

  for (const s of def.states) {
    if (s.name.length > STATE_NAME_MAX_LENGTH) {
      errors.push(`State name "${s.name}" must be at most ${STATE_NAME_MAX_LENGTH} characters.`);
    }
    if (isReserved(s.name)) errors.push(reservedMessage(s.name));
  }

  if (def.initialState !== WORKFLOW_INITIAL_STATE) {
    errors.push(`initialState must be "${WORKFLOW_INITIAL_STATE}", got "${def.initialState}".`);
  }
  if (def.states.some((s) => s.name === def.initialState && s.terminal)) {
    errors.push(`Initial state "${def.initialState}" must not be a terminal state.`);
  }
  if (!def.states.some((s) => s.terminal)) {
    errors.push("The workflow needs at least one terminal state.");
  }

  for (const t of def.transitions) {
    const reserved = isReserved(t.from) ? t.from : isReserved(t.to) ? t.to : null;
    if (reserved !== null) {
      errors.push(
        `Transition ${reserved === t.from ? "from" : "to"} reserved state "${reserved}" is not allowed: ` +
          `${RESERVED_STATE_NAMES.join(" and ")} are managed outside the workflow graph.`,
      );
    }
  }

  return errors;
}
