/**
 * Cross-repo PR guard.
 *
 * ADR-0010 §5b: any `prUrl` payload on a task-side verb must point at the
 * same `owner/repo` as `project.githubRepo`. Without this an agent with
 * a valid token for project A could submit a PR URL from project B and
 * drive a merge on the wrong repo. The check was previously inlined in
 * two sites in `routes/tasks.ts` (task_finish + submit_pr) with the same
 * logic duplicated; extracting it both kills the drift surface and makes
 * the guard discoverable via the effective-gates introspection.
 *
 * ADR-0010 §5c: a task can override its "home" repo with `deliverableRepo`
 * — for tasks whose legitimate deliverable is a PR in a different GitHub
 * repo (benchmark/measurement/docs tasks). `effectiveDeliverableRepo`
 * resolves the repo the guard actually compares against; every write path
 * that stores a `prUrl` must route through it (see docs/workflow-preconditions.md).
 *
 * The prUrl write paths (task_finish, submit_pr, PATCH) are active only when
 * the effective repo is set: projects (and tasks) without a linked repo
 * don't have a "home" to compare against and accept any URL there. The
 * server-side PR create and PR comment routes act with a delegated token on a
 * body-supplied owner/repo and instead fail closed through
 * `requireEffectiveRepo`.
 */
import { parseOwnerRepo } from "../transition-rules.js";
import type { Gate } from "./types.js";
import { GateCode } from "./types.js";

export interface PrRepoMatchesProjectProject {
  githubRepo: string | null;
}

export interface PrRepoMatchesProjectTask {
  deliverableRepo?: string | null;
}

export type PrRepoMatchesProjectResult =
  | { ok: true }
  | {
      ok: false;
      reason: "cross_repo";
      prOwner: string;
      prRepo: string;
      projectRepo: string;
    };

/**
 * The repo a task's PR lifecycle is actually bound to: the task-level
 * override when set, otherwise the project's linked repo. An override equal
 * to `project.githubRepo` is a harmless no-op — deliberately not special-
 * cased here; foreign-vs-home decisions go through `isForeignDeliverable`.
 */
export function effectiveDeliverableRepo(
  task: PrRepoMatchesProjectTask,
  project: PrRepoMatchesProjectProject,
): string | null {
  return task.deliverableRepo ?? project.githubRepo;
}

/**
 * Whether the task's PR lifecycle lives OUTSIDE the project's linked repo.
 * The single decision point for merge refusal, the ciGreen/prMerged skip,
 * and foreign-link auditing — every consumer must use this instead of
 * comparing repo strings inline, because GitHub owner/repo names are
 * case-insensitive: an override differing from `project.githubRepo` only
 * by case is the SAME repo (the documented no-op), and a raw `!==` would
 * both fail-open the CI gates ("foreign" → skipped on a home-repo task)
 * and falsely refuse merges. Mirrors the lowercased comparison the
 * cross-repo guard itself uses.
 */
export function isForeignDeliverable(
  task: PrRepoMatchesProjectTask,
  project: PrRepoMatchesProjectProject,
): boolean {
  const effective = effectiveDeliverableRepo(task, project);
  if (effective === project.githubRepo) return false; // both null, or identical strings
  if (effective === null || project.githubRepo === null) return true;
  const a = parseOwnerRepo(effective);
  const b = parseOwnerRepo(project.githubRepo);
  // Malformed on either side: fall back to a whole-string case-insensitive
  // compare rather than guessing owner/repo boundaries.
  if (!a || !b) return effective.toLowerCase() !== project.githubRepo.toLowerCase();
  return (
    a.owner.toLowerCase() !== b.owner.toLowerCase() ||
    a.repo.toLowerCase() !== b.repo.toLowerCase()
  );
}

/**
 * Parses `owner/repo` from `https://github.com/{owner}/{repo}/pull/{n}`
 * and compares against the task's effective deliverable repo (format
 * `owner/repo`). Both sides are lowercased so trivial capitalization
 * differences don't reject.
 *
 * Returns `ok: true` when:
 *   - the effective repo is null (no binding to check against)
 *   - the `prUrl` does not match the github-URL shape (defensive: we
 *     only assert cross-repo here, not URL well-formedness — the caller
 *     validates URL syntax upstream)
 *   - the parsed effective repo is malformed (likewise defensive)
 *   - both parse and match
 */
export function checkPrRepoMatchesProject(
  prUrl: string,
  task: PrRepoMatchesProjectTask,
  project: PrRepoMatchesProjectProject,
): PrRepoMatchesProjectResult {
  const effectiveRepo = effectiveDeliverableRepo(task, project);
  if (!effectiveRepo) return { ok: true };

  const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
  if (!prMatch) return { ok: true };

  return compareOwnerRepoAgainst(prMatch[1], prMatch[2], effectiveRepo);
}

/**
 * Same comparison as `checkPrRepoMatchesProject`, but against a raw
 * `owner`/`repo` pair instead of a parsed PR URL. Used by
 * `POST /api/github/pull-requests`, which creates the PR from a body-
 * supplied owner/repo *before* any `prUrl` exists to parse.
 */
export function checkOwnerRepoMatchesProject(
  owner: string,
  repo: string,
  task: PrRepoMatchesProjectTask,
  project: PrRepoMatchesProjectProject,
): PrRepoMatchesProjectResult {
  const effectiveRepo = effectiveDeliverableRepo(task, project);
  if (!effectiveRepo) return { ok: true };
  return compareOwnerRepoAgainst(owner, repo, effectiveRepo);
}

/**
 * Result of `requireEffectiveRepo`: whether a task has a usable `owner/repo`
 * to compare a body-supplied target against.
 */
export type EffectiveRepoRequirementResult =
  | { ok: true; /** The effective repo as stored: `deliverableRepo ?? githubRepo`, non-blank and parseable as `owner/repo`. */ effectiveRepo: string }
  | {
      ok: false;
      /** `missing`: neither the task nor the project names a repo (unset, empty or blank). `malformed`: the effective repo is set but is not `owner/repo`. */
      reason: "missing" | "malformed";
      /** The effective repo string as stored, or null when none is set. */
      effectiveRepo: string | null;
      /** `missing` only: the task's `deliverableRepo` is an empty string that overrides a project `githubRepo` which is set. */
      emptyOverride?: true;
    };

/** Error code the PR create and PR comment routes answer when `requireEffectiveRepo` fails. */
export const NO_EFFECTIVE_REPO_ERROR = "no_effective_repo";

/**
 * Fail-closed counterpart of the "no binding, accept anything" branches in
 * `checkOwnerRepoMatchesProject`. The server-side PR create and PR comment
 * routes act with a team member's delegated GitHub token on a body-supplied
 * `owner/repo`; with no effective repo (or one that does not parse) there is
 * nothing to compare that target against, so the routes refuse instead of
 * accepting any repository the delegated token can reach.
 *
 * Deliberately separate from `checkPrRepoMatchesProject` and
 * `checkOwnerRepoMatchesProject`, whose "no binding means ok" semantics the
 * prUrl write paths (task_finish, submit_pr, PATCH) keep.
 */
export function requireEffectiveRepo(
  task: PrRepoMatchesProjectTask,
  project: PrRepoMatchesProjectProject,
): EffectiveRepoRequirementResult {
  const effectiveRepo = effectiveDeliverableRepo(task, project);
  if (effectiveRepo === null || effectiveRepo === undefined || effectiveRepo.trim() === "") {
    const projectHasRepo = (project.githubRepo ?? "").trim() !== "";
    return {
      ok: false,
      reason: "missing",
      effectiveRepo: null,
      // A blank effective repo with a set project repo can only come from a blank override.
      ...(projectHasRepo ? { emptyOverride: true as const } : {}),
    };
  }
  if (!parseOwnerRepo(effectiveRepo)) {
    return { ok: false, reason: "malformed", effectiveRepo };
  }
  return { ok: true, effectiveRepo };
}

export function noEffectiveRepoMessage(
  result: Extract<EffectiveRepoRequirementResult, { ok: false }>,
): string {
  if (result.reason === "malformed") {
    return `This task's effective deliverable repo "${result.effectiveRepo}" is not in owner/repo form. Set the task's deliverableRepo or the project's githubRepo to an owner/repo value.`;
  }
  if (result.emptyOverride) {
    return "This task's deliverableRepo is empty and overrides the project's githubRepo. Set deliverableRepo to an owner/repo value or clear it.";
  }
  return "This task has no effective deliverable repo: neither the project's githubRepo nor the task's deliverableRepo is set. Set one of them (owner/repo) before creating or commenting on pull requests through agent-tasks.";
}

function compareOwnerRepoAgainst(
  owner: string,
  repo: string,
  effectiveRepo: string,
): PrRepoMatchesProjectResult {
  const parsed = parseOwnerRepo(effectiveRepo);
  if (!parsed) return { ok: true };

  if (
    owner.toLowerCase() !== parsed.owner.toLowerCase() ||
    repo.toLowerCase() !== parsed.repo.toLowerCase()
  ) {
    return {
      ok: false,
      reason: "cross_repo",
      prOwner: owner,
      prRepo: repo,
      projectRepo: effectiveRepo,
    };
  }
  return { ok: true };
}

export function prRepoMatchesProjectRejectionMessage(
  prOwner: string,
  prRepo: string,
  projectRepo: string,
): string {
  return `PR belongs to ${prOwner}/${prRepo} but this task's effective deliverable repo is ${projectRepo}`;
}

export const prRepoMatchesProjectGate: Gate = {
  code: GateCode.PrRepoMatchesProject,
  name: "PR URL repo matches project binding",
  appliesTo: ["task_finish", "submit_pr", "tasks_update", "pull_requests_create"],
  describe(project) {
    if (project.githubRepo) {
      return {
        active: true,
        because: `Project is bound to ${project.githubRepo}; PR URLs pointing elsewhere are rejected (ADR-0010 §5b).`,
      };
    }
    return {
      active: false,
      because:
        "Project has no linked GitHub repo; task_finish, submit_pr and tasks_update accept any PR URL, while pull_requests_create and PR comments are refused with no_effective_repo unless the task sets a deliverableRepo.",
    };
  },
};
