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
 * Active only when the effective repo is set — projects (and tasks) without
 * a linked repo don't have a "home" to compare against and accept any URL.
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
 * cased, callers compare the resolved string either way.
 */
export function effectiveDeliverableRepo(
  task: PrRepoMatchesProjectTask,
  project: PrRepoMatchesProjectProject,
): string | null {
  return task.deliverableRepo ?? project.githubRepo;
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
      because: "Project has no linked GitHub repo; any PR URL is accepted.",
    };
  },
};
