/**
 * Built-in default workflow applied to tasks that have no explicit Workflow
 * row. This is the system-wide baseline: every project that hasn't defined
 * its own workflow inherits these transitions and their `requires` gates.
 *
 * Teams that want different rules (e.g. a docs-only project that legitimately
 * has no branches) can create a custom Workflow and override per-transition.
 * That escape hatch is why the defaults live in code, not in a migration.
 *
 * Shape matches workflow.definition.transitions so a single evaluator in
 * tasks.ts can handle both the custom-workflow and no-workflow paths.
 */

export interface DefaultTransition {
  to: string;
  label: string;
  requires?: string[];
}

export const DEFAULT_TRANSITIONS: Record<string, DefaultTransition[]> = {
  open: [
    // Claiming the task and starting work implies you have somewhere to put
    // the code. Require a branch name before the task leaves "open".
    { to: "in_progress", label: "Start", requires: ["branchPresent"] },
  ],
  in_progress: [
    // "Submit for review" without an actual PR produces an empty review
    // request. Require both branch and PR.
    { to: "review", label: "Submit for review", requires: ["branchPresent", "prPresent"] },
    // Mark done directly (skip review). Still requires branch + PR so the
    // audit trail has something to reference.
    { to: "done", label: "Mark done", requires: ["branchPresent", "prPresent"] },
    // Release the task back to open — always allowed, no artifact needed.
    { to: "open", label: "Release" },
  ],
  review: [
    // Approve: no extra gate (reviewer already saw the PR).
    { to: "done", label: "Approve" },
    // Request changes: always allowed.
    { to: "in_progress", label: "Request changes" },
  ],
  done: [],
};

/**
 * Look up the default transition definition for a given (from, to) pair.
 * Returns `undefined` if the transition is not part of the default workflow.
 */
export function findDefaultTransition(
  from: string,
  to: string,
): DefaultTransition | undefined {
  return DEFAULT_TRANSITIONS[from]?.find((t) => t.to === to);
}
