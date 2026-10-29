// Port of the backend's reading of a stored workflow definition
// (backend/src/services/default-workflow.ts: sanitizeStoredDefinition,
// isTerminalState, isReviewState, terminalStates, reviewStates, and
// services/workflow-status-filter.ts: safeStates). The backend judges which
// names are terminal or review-like only AFTER the stored definition has been
// sanitized (initialState backlog reads as open, the backlog state and every
// edge into backlog are dropped, an edge out of backlog is remapped to leave
// from open only for a legacy start edge) and falls back to the built-in names
// of a kind when the definition cannot be read. The /tasks presets and the Home
// widgets filter on the same names, so they must read a definition the same
// way. The shared fixtures in __fixtures__/workflow-vocabulary-fixtures.ts pin
// both copies to the backend's answers.
//
// The functions are written like the backend's, on purpose: a definition that
// makes the backend throw (a transitions list that is not a list, an entry
// that is not an object) throws here too and lands in the same built-in
// fallback, instead of being guarded differently.

import type { Workflow } from "./api";

/** Review-like state of the built-in workflow (backend defaultWorkflowDefinition). */
export const BUILT_IN_REVIEW_STATES: readonly string[] = ["review"];

/** Terminal state of the built-in workflow (backend defaultWorkflowDefinition). */
export const BUILT_IN_TERMINAL_STATES: readonly string[] = ["done"];

const BACKLOG_STATE = "backlog";
const SANITIZED_INITIAL_STATE = "open";

interface State {
  name: string;
  label?: string;
  terminal?: boolean;
}
interface Edge {
  from: string;
  to: string;
}
interface Definition {
  states: State[];
  transitions: Edge[];
  initialState: string;
}

function isInitialState(def: Definition, name: string): boolean {
  return def.initialState === name;
}

function isTerminalState(def: Definition, name: string): boolean {
  return def.states.find((s) => s.name === name)?.terminal === true;
}

function isReviewState(def: Definition, name: string): boolean {
  if (isInitialState(def, name) || isTerminalState(def, name)) return false;
  const hasTransitionToTerminal = def.transitions.some((t) => t.from === name && isTerminalState(def, t.to));
  if (!hasTransitionToTerminal) return false;
  return !def.transitions.some((t) => t.from === def.initialState && t.to === name);
}

function mentionsBacklog(def: Definition): boolean {
  return (
    def.initialState === BACKLOG_STATE ||
    (Array.isArray(def.states) && def.states.some((s) => s.name === BACKLOG_STATE)) ||
    (Array.isArray(def.transitions) && def.transitions.some((t) => t.from === BACKLOG_STATE || t.to === BACKLOG_STATE))
  );
}

function sanitizeBacklogEdges(transitions: Edge[], remapOutOfBacklog: boolean, states: unknown): Edge[] {
  // Terminal and review-like are judged on the sanitized definition before any
  // remap: initial state open, no backlog state, only the edges that touch
  // backlog at neither end. When the states are not a list nothing can be
  // judged and nothing is remapped. Of the remap rules only the review skip
  // can change which names qualify (a remapped edge into a review-like state
  // would make it a direct target of the entry state); the others (terminal
  // target, duplicate, self loop, the edge filters) only shape the edge list.
  // They are kept so the port reads like the backend.
  const judge: Definition | null = Array.isArray(states)
    ? {
        initialState: SANITIZED_INITIAL_STATE,
        states: states as State[],
        transitions: transitions.filter((t) => t.from !== BACKLOG_STATE && t.to !== BACKLOG_STATE),
      }
    : null;
  const taken = new Set(
    transitions.filter((t) => t.from === SANITIZED_INITIAL_STATE && t.to !== BACKLOG_STATE).map((t) => t.to),
  );
  const out: Edge[] = [];
  for (const t of transitions) {
    if (t.to === BACKLOG_STATE) continue;
    if (t.from !== BACKLOG_STATE) {
      out.push(t);
      continue;
    }
    if (!remapOutOfBacklog) continue;
    if (judge === null) continue;
    if (isTerminalState(judge, t.to)) continue;
    if (isReviewState(judge, t.to)) continue;
    if (t.to === SANITIZED_INITIAL_STATE || taken.has(t.to)) continue;
    taken.add(t.to);
    out.push({ ...t, from: SANITIZED_INITIAL_STATE });
  }
  return out;
}

/** The stored definition the way the backend reads it (see sanitizeStoredDefinition there). */
export function sanitizeStoredDefinition(stored: unknown): Definition {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return stored as Definition;
  }
  const def = stored as Definition;
  if (!mentionsBacklog(def)) return def;
  const legacyInitial = def.initialState === BACKLOG_STATE;
  const states = Array.isArray(def.states) ? def.states.filter((s) => s.name !== BACKLOG_STATE) : def.states;
  const initialState = legacyInitial ? SANITIZED_INITIAL_STATE : def.initialState;
  const transitions = Array.isArray(def.transitions)
    ? sanitizeBacklogEdges(def.transitions, legacyInitial, states)
    : def.transitions;
  return {
    ...def,
    initialState,
    states:
      Array.isArray(states) && legacyInitial && !states.some((s) => s.name === SANITIZED_INITIAL_STATE)
        ? [...states, { name: SANITIZED_INITIAL_STATE, label: "Open", terminal: false }]
        : states,
    transitions,
  };
}

/**
 * The names the backend's safeStates answers for one stored workflow, as a
 * sorted list without repeats: the terminal states, or the review-like ones, of
 * the sanitized definition. A definition that cannot be read (anything that
 * makes the backend throw) reads as the built-in workflow's names of that kind.
 */
function safeStates(definition: unknown, kind: "terminal" | "review"): string[] {
  try {
    const def = sanitizeStoredDefinition(definition);
    const names =
      kind === "terminal"
        ? def.states.filter((s) => s.terminal).map((s) => s.name)
        : def.states.filter((s) => isReviewState(def, s.name)).map((s) => s.name);
    return [...new Set(names)].sort();
  } catch {
    return [...(kind === "terminal" ? BUILT_IN_TERMINAL_STATES : BUILT_IN_REVIEW_STATES)];
  }
}

/** The terminal states of one stored workflow, as the backend judges them. */
export function storedTerminalStates(workflow: Pick<Workflow, "definition">): string[] {
  return safeStates(workflow.definition, "terminal");
}

/** The review-like states of one stored workflow, as the backend judges them. */
export function storedReviewStates(workflow: Pick<Workflow, "definition">): string[] {
  return safeStates(workflow.definition, "review");
}

/**
 * The non-terminal state names of one stored workflow that can hold work: the
 * non-terminal states of the sanitized definition. A definition that cannot be
 * read has none beyond the built-in names, which the callers always include.
 */
export function storedWorkStates(workflow: Pick<Workflow, "definition">): string[] {
  try {
    const def = sanitizeStoredDefinition(workflow.definition);
    const terminal = new Set(def.states.filter((s) => s.terminal).map((s) => s.name));
    return [...new Set(def.states.map((s) => s.name).filter((name) => !terminal.has(name)))];
  } catch {
    return [];
  }
}
