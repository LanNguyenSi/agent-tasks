/**
 * Declarative transition preconditions.
 *
 * Each built-in rule is a pure predicate over the task's current state.
 * Workflows reference rules by name via `transitions[].requires`, the
 * transition handler evaluates them before allowing the state change, and
 * admins can bypass with `{force: true}` (audited).
 *
 * Adding a new rule:
 *  1. Add the name to `TransitionRule`
 *  2. Add a predicate to `RULE_EVALUATORS`
 *  3. Add a human-readable message to `RULE_MESSAGES`
 *  4. Document it in docs/workflow-preconditions.md
 *
 * Keep predicates side-effect-free — they must be safe to run in any order
 * and must not depend on anything beyond what `RuleContext` exposes. If a
 * future rule needs to hit GitHub, wrap it as async and update the caller.
 */

export type TransitionRule = "branchPresent" | "prPresent";

export interface RuleContext {
  branchName: string | null;
  prUrl: string | null;
  prNumber: number | null;
}

export const RULE_EVALUATORS: Record<TransitionRule, (ctx: RuleContext) => boolean> = {
  branchPresent: (ctx) => Boolean(ctx.branchName && ctx.branchName.trim().length > 0),
  prPresent: (ctx) => Boolean(ctx.prUrl && ctx.prNumber),
};

export const RULE_MESSAGES: Record<TransitionRule, string> = {
  branchPresent:
    "No branch recorded on this task. PATCH /api/tasks/:id with branchName first.",
  prPresent:
    "No pull request recorded on this task. Create the PR (via /api/github/pull-requests or PATCH prUrl/prNumber) first.",
};

export function isKnownRule(r: string): r is TransitionRule {
  return r in RULE_EVALUATORS;
}

export interface RuleEvaluationResult {
  failed: TransitionRule[];
  unknown: string[];
}

/**
 * Evaluate a list of rule names against the given context.
 *
 * Unknown rule names are reported separately but do NOT block the
 * transition — this keeps older backends forward-compatible with workflows
 * that reference rules shipped in a newer version (or misspelled names).
 * The caller is responsible for logging unknowns.
 */
export function evaluateTransitionRules(
  rules: string[] | undefined,
  ctx: RuleContext,
): RuleEvaluationResult {
  if (!rules || rules.length === 0) return { failed: [], unknown: [] };
  const failed: TransitionRule[] = [];
  const unknown: string[] = [];
  for (const r of rules) {
    if (!isKnownRule(r)) {
      unknown.push(r);
      continue;
    }
    if (!RULE_EVALUATORS[r](ctx)) failed.push(r);
  }
  return { failed, unknown };
}
