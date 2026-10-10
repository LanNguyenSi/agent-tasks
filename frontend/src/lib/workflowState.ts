import type { WorkflowDefinition } from "./api";

/**
 * Whether `stateName` is a review-like state of `def`. Mirrors the backend's
 * `isReviewState` (backend/src/services/default-workflow.ts), which the
 * `/tasks/:id/release` route uses to answer 409 bad_state: a state is
 * review-like when it is not the initial state, not terminal, has a
 * transition into a terminal state, and is not a direct target of the
 * initial state. Keep the two in sync.
 */
export function isReviewState(def: WorkflowDefinition, stateName: string): boolean {
  const isTerminal = (name: string) => def.states.find((s) => s.name === name)?.terminal === true;
  if (def.initialState === stateName || isTerminal(stateName)) return false;
  const hasTransitionToTerminal = def.transitions.some(
    (t) => t.from === stateName && isTerminal(t.to),
  );
  if (!hasTransitionToTerminal) return false;
  return !def.transitions.some((t) => t.from === def.initialState && t.to === stateName);
}
