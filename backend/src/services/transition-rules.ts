/**
 * Declarative transition preconditions.
 *
 * Each built-in rule is a predicate over the task's current state.
 * Workflows reference rules by name via `transitions[].requires`, the
 * transition handler evaluates them before allowing the state change, and
 * admins can bypass with `{force: true}` (audited).
 *
 * ## Sync vs async rules
 *
 * `branchPresent` and `prPresent` are pure synchronous predicates over
 * the loaded task. `ciGreen` talks to the GitHub Check Runs API and
 * needs a token — so the evaluator interface is async, and sync rules
 * are wrapped in `async () => …`. This keeps the call site uniform.
 *
 * ## Fail-closed
 *
 * Network errors from async rules throw; `evaluateTransitionRules`
 * catches and records them as a generic failure with a friendly
 * message. A broken GitHub API must NOT silently bypass the gate.
 *
 * ## Adding a new rule
 *
 *  1. Add the name to `TransitionRule`
 *  2. Add an entry to `RULE_EVALUATORS` (return `boolean` or `Promise<boolean>`)
 *  3. Add a human-readable `RULE_MESSAGES` entry
 *  4. Add a `RULE_CATALOG` entry (shown in the UI)
 *  5. If the rule needs external state beyond `RuleContext`, extend
 *     `RuleContext` and pass the new fields from `tasks.ts`
 *  6. Document it in `docs/workflow-preconditions.md`
 */

import {
  fetchCheckRunStatus,
  fetchPullRequestStatus,
  GithubChecksError,
} from "./github-checks.js";

export type TransitionRule = "branchPresent" | "prPresent" | "ciGreen" | "prMerged";

/**
 * Rules that need GitHub delegation credentials in their context. The
 * transition handler uses this set to decide whether to do the extra
 * work of resolving a delegation user before calling the evaluator —
 * rules not in the set get a fast path without a DB lookup.
 *
 * Adding a new GitHub-backed rule: add its name here AND add it to the
 * evaluator map below. The transition handler needs no changes.
 */
export const GITHUB_BACKED_RULES: ReadonlySet<TransitionRule> = new Set([
  "ciGreen",
  "prMerged",
]);

export interface RuleContext {
  // Synchronous fields — available for every evaluator
  branchName: string | null;
  prUrl: string | null;
  prNumber: number | null;
  // Async-only extras — `ciGreen` needs these. They may be null when the
  // project has no GitHub linkage or the caller couldn't find a
  // delegation user; async rules that need them should fail closed.
  projectGithubRepo?: string | null; // "owner/repo"
  githubToken?: string | null;
}

type SyncEvaluator = (ctx: RuleContext) => boolean;
type AsyncEvaluator = (ctx: RuleContext) => Promise<boolean>;
type Evaluator = SyncEvaluator | AsyncEvaluator;

/**
 * Parse `owner/repo` into its pieces. Returns null on any malformed input
 * — a missing slash, empty owner, or empty repo. The classifier pattern
 * matches `ciGreen` and `prMerged` so both rules share the same guard.
 */
export function parseOwnerRepo(
  projectGithubRepo: string | null | undefined,
): { owner: string; repo: string } | null {
  if (!projectGithubRepo) return null;
  const slash = projectGithubRepo.indexOf("/");
  if (slash < 0) return null;
  const owner = projectGithubRepo.slice(0, slash);
  const repo = projectGithubRepo.slice(slash + 1);
  if (!owner || !repo) return null;
  return { owner, repo };
}

export const RULE_EVALUATORS: Record<TransitionRule, Evaluator> = {
  branchPresent: (ctx) => Boolean(ctx.branchName && ctx.branchName.trim().length > 0),
  prPresent: (ctx) => Boolean(ctx.prUrl && ctx.prNumber),
  ciGreen: async (ctx) => {
    if (!ctx.prNumber || !ctx.githubToken) return false;
    const parsed = parseOwnerRepo(ctx.projectGithubRepo);
    if (!parsed) return false;
    const status = await fetchCheckRunStatus(
      parsed.owner,
      parsed.repo,
      ctx.prNumber,
      ctx.githubToken,
    );
    return status.state === "success";
  },
  prMerged: async (ctx) => {
    // Passes ONLY when the PR is in the closed-merged state. Open PRs,
    // closed-unmerged PRs (rejected), and any malformed/API-error
    // response all fail closed. Pair with `prPresent` on the same
    // transition to get clean error reporting when the task has no PR
    // at all.
    if (!ctx.prNumber || !ctx.githubToken) return false;
    const parsed = parseOwnerRepo(ctx.projectGithubRepo);
    if (!parsed) return false;
    const status = await fetchPullRequestStatus(
      parsed.owner,
      parsed.repo,
      ctx.prNumber,
      ctx.githubToken,
    );
    return status.state === "merged";
  },
};

export const RULE_MESSAGES: Record<TransitionRule, string> = {
  branchPresent:
    "No branch recorded on this task. PATCH /api/tasks/:id with branchName first.",
  prPresent:
    "No pull request recorded on this task. Create the PR (via /api/github/pull-requests or PATCH prUrl/prNumber) first.",
  ciGreen:
    "CI is not green on the PR. Every check run must end in success (or neutral/skipped). If GitHub is unreachable or no delegation user is available, this rule fails closed — retry or use admin force.",
  prMerged:
    "PR is not merged yet. The pull request on this task must be in the closed-merged state. Open PRs, rejected PRs, and API errors all block — merge the PR or use admin force.",
};

export interface RuleCatalogEntry {
  id: TransitionRule;
  label: string;
  description: string;
  failureMessage: string;
}

export const RULE_CATALOG: RuleCatalogEntry[] = [
  {
    id: "branchPresent",
    label: "Branch recorded",
    description:
      "Requires that the task has a non-empty `branchName`. The agent or human must record the branch on the task (PATCH /api/tasks/:id) before this transition is allowed.",
    failureMessage: RULE_MESSAGES.branchPresent,
  },
  {
    id: "prPresent",
    label: "Pull request recorded",
    description:
      "Requires that the task has both `prUrl` and `prNumber` set. Typically satisfied by creating the PR via /api/github/pull-requests, which patches both fields automatically.",
    failureMessage: RULE_MESSAGES.prPresent,
  },
  {
    id: "ciGreen",
    label: "CI is green",
    description:
      "Queries the GitHub Check Runs API for the task's PR head SHA. Passes only when every check run is completed successfully (or neutral/skipped). Fails closed on network errors, missing PR, or missing GitHub delegation — admin force is the escape.",
    failureMessage: RULE_MESSAGES.ciGreen,
  },
  {
    id: "prMerged",
    label: "PR is merged",
    description:
      "Queries the GitHub Pull Request API for the task's PR. Passes only when the PR is in the closed-merged state. Open PRs (including drafts — a draft is just `state=open`) and closed-unmerged (rejected) PRs all block. Fails closed on network errors or missing delegation — admin force is the escape. Pairs naturally with prPresent on the same transition.",
    failureMessage: RULE_MESSAGES.prMerged,
  },
];

export function isKnownRule(r: string): r is TransitionRule {
  return r in RULE_EVALUATORS;
}

export interface RuleEvaluationResult {
  failed: TransitionRule[];
  unknown: string[];
  /**
   * Per-rule failure detail, keyed by rule name. Populated for rules whose
   * evaluator threw (e.g. `ciGreen` on a GitHub API error). Sync rules that
   * simply return false have no entry here — their failure message comes
   * from `RULE_MESSAGES`.
   */
  errors: Partial<Record<TransitionRule, string>>;
}

export async function evaluateTransitionRules(
  rules: string[] | undefined,
  ctx: RuleContext,
): Promise<RuleEvaluationResult> {
  if (!rules || rules.length === 0) {
    return { failed: [], unknown: [], errors: {} };
  }
  const unknown: string[] = [];

  // Pre-allocate a per-slot result array so `failed` can be assembled in
  // iteration order after Promise.all. Without this, sync rules race to
  // push into `failed` and the order flaps between requests, changing
  // the user-facing 422 message string for no reason.
  interface Slot {
    rule: TransitionRule;
    ok: boolean;
    error?: string;
  }
  const slots: Array<Slot | null> = [];
  const promises: Array<Promise<void>> = [];

  for (const r of rules) {
    if (!isKnownRule(r)) {
      unknown.push(r);
      continue;
    }
    const slot: Slot = { rule: r, ok: true };
    const index = slots.length;
    slots.push(slot);
    promises.push(
      (async () => {
        try {
          const ok = await RULE_EVALUATORS[r](ctx);
          slots[index]!.ok = ok;
        } catch (err) {
          slots[index]!.ok = false;
          // Only `GithubChecksError` gets its status code surfaced —
          // every other throw collapses to a generic "rule evaluation
          // error" so we don't leak arbitrary error text (or internal
          // stack traces from unexpected thrown values) to the client.
          if (err instanceof GithubChecksError) {
            slots[index]!.error = `GitHub API error (${err.status ?? "unknown"})`;
          } else {
            slots[index]!.error = "Rule evaluation error";
          }
        }
      })(),
    );
  }
  await Promise.all(promises);

  const failed: TransitionRule[] = [];
  const errors: Partial<Record<TransitionRule, string>> = {};
  for (const slot of slots) {
    if (slot === null) continue;
    if (!slot.ok) {
      failed.push(slot.rule);
      if (slot.error) errors[slot.rule] = slot.error;
    }
  }

  return { failed, unknown, errors };
}
