/**
 * Pure helpers for the workflow editor page.
 *
 * These must live outside the Next.js page file because App Router only
 * allows a specific set of named exports from `page.tsx` (default export
 * + a small allowlist like `metadata`). Additional exports — even of
 * pure helpers — cause a build error at `next build`:
 *
 *     Type error: Page "..." does not match the required types of a
 *     Next.js Page. "reachableStates" is not a valid Page export field.
 *
 * Keeping the graph helpers here also makes them independently testable
 * without pulling in React or the whole page module.
 */

import type { WorkflowDefinition } from "./api";

export const STATE_NAME_RE = /^[a-z0-9_]+$/;

export const ROLE_OPTIONS = ["any", "ADMIN", "HUMAN_MEMBER", "REVIEWER"] as const;

export function cloneDefinition(def: WorkflowDefinition): WorkflowDefinition {
  return {
    initialState: def.initialState,
    states: def.states.map((s) => ({ ...s })),
    transitions: def.transitions.map((t) => ({
      ...t,
      ...(t.requires ? { requires: [...t.requires] } : {}),
    })),
  };
}

export function sameRequires(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const bs = new Set(bb);
  return aa.every((x) => bs.has(x));
}

export function definitionsEqual(a: WorkflowDefinition, b: WorkflowDefinition): boolean {
  if (a.initialState !== b.initialState) return false;
  if (a.states.length !== b.states.length) return false;
  for (let i = 0; i < a.states.length; i++) {
    const sa = a.states[i]!;
    const sb = b.states[i]!;
    if (
      sa.name !== sb.name ||
      sa.label !== sb.label ||
      sa.terminal !== sb.terminal ||
      (sa.agentInstructions ?? "") !== (sb.agentInstructions ?? "")
    ) {
      return false;
    }
  }
  if (a.transitions.length !== b.transitions.length) return false;
  for (let i = 0; i < a.transitions.length; i++) {
    const ta = a.transitions[i]!;
    const tb = b.transitions[i]!;
    if (
      ta.from !== tb.from ||
      ta.to !== tb.to ||
      (ta.label ?? "") !== (tb.label ?? "") ||
      (ta.requiredRole ?? "any") !== (tb.requiredRole ?? "any") ||
      !sameRequires(ta.requires, tb.requires)
    ) {
      return false;
    }
  }
  return true;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * BFS reachability from the initial state over the transition graph.
 * Returns the set of states that CAN be reached.
 */
export function reachableStates(def: WorkflowDefinition): Set<string> {
  const reachable = new Set<string>();
  if (!def.states.some((s) => s.name === def.initialState)) return reachable;
  const queue: string[] = [def.initialState];
  reachable.add(def.initialState);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const t of def.transitions) {
      if (t.from === current && !reachable.has(t.to)) {
        reachable.add(t.to);
        queue.push(t.to);
      }
    }
  }
  return reachable;
}

export interface ReachabilityReport {
  unreachable: string[];
  deadEnds: string[];
  orphans: string[];
}

/**
 * Categorize states by reachability problems:
 *  - unreachable: cannot be reached from the initial state
 *  - deadEnds: non-terminal with no outgoing transition (task gets stuck)
 *  - orphans: no incoming transition and not the initial state
 * All three are informational — they're warnings, not errors.
 */
export function computeReachability(def: WorkflowDefinition): ReachabilityReport {
  const reachable = reachableStates(def);
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const s of def.states) {
    outgoing.set(s.name, 0);
    incoming.set(s.name, 0);
  }
  for (const t of def.transitions) {
    outgoing.set(t.from, (outgoing.get(t.from) ?? 0) + 1);
    incoming.set(t.to, (incoming.get(t.to) ?? 0) + 1);
  }

  const unreachable: string[] = [];
  const deadEnds: string[] = [];
  const orphans: string[] = [];
  for (const s of def.states) {
    if (!reachable.has(s.name)) unreachable.push(s.name);
    if (!s.terminal && (outgoing.get(s.name) ?? 0) === 0) deadEnds.push(s.name);
    if ((incoming.get(s.name) ?? 0) === 0 && s.name !== def.initialState) {
      orphans.push(s.name);
    }
  }
  return { unreachable, deadEnds, orphans };
}

export function validateDefinition(def: WorkflowDefinition): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Name uniqueness + format
  const seen = new Set<string>();
  for (const s of def.states) {
    if (!s.name) {
      errors.push("State name cannot be empty.");
      continue;
    }
    if (!STATE_NAME_RE.test(s.name)) {
      errors.push(`State name "${s.name}" must match [a-z0-9_]+ (lowercase, digits, underscore).`);
    }
    if (seen.has(s.name)) {
      errors.push(`Duplicate state name: "${s.name}".`);
    }
    seen.add(s.name);
    if (!s.label.trim()) {
      errors.push(`State "${s.name}" has no label.`);
    }
  }

  // initialState must reference an existing state
  if (!seen.has(def.initialState)) {
    errors.push(`Initial state "${def.initialState}" is not in the states list.`);
  }

  // Transitions must reference existing states; catch duplicate pairs.
  const seenPairs = new Set<string>();
  for (const t of def.transitions) {
    if (!seen.has(t.from)) {
      errors.push(`Transition references missing "from" state: "${t.from}" → "${t.to}".`);
    }
    if (!seen.has(t.to)) {
      errors.push(`Transition references missing "to" state: "${t.from}" → "${t.to}".`);
    }
    const key = `${t.from}→${t.to}`;
    if (seenPairs.has(key)) {
      errors.push(`Duplicate transition: ${key}.`);
    }
    seenPairs.add(key);
  }

  // At least one terminal state — warning only
  if (!def.states.some((s) => s.terminal)) {
    warnings.push("No terminal state is marked. Tasks will never reach a 'done' state.");
  }

  // Reachability warnings — only meaningful when the graph is structurally
  // valid. Running reachability on a broken graph produces noise.
  if (errors.length === 0) {
    const { unreachable, deadEnds, orphans } = computeReachability(def);
    for (const name of unreachable) {
      warnings.push(`State "${name}" is unreachable from the initial state.`);
    }
    for (const name of deadEnds) {
      warnings.push(`State "${name}" is a non-terminal dead end (no outgoing transitions).`);
    }
    for (const name of orphans) {
      warnings.push(`State "${name}" has no incoming transition.`);
    }
  }

  return { errors, warnings };
}
