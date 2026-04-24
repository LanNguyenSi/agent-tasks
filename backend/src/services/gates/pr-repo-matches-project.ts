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
 * Active only when `project.githubRepo` is set — projects without a
 * linked repo don't have a "home" to compare against and accept any URL.
 */
import { parseOwnerRepo } from "../transition-rules.js";
import type { Gate } from "./types.js";
import { GateCode } from "./types.js";

export interface PrRepoMatchesProjectProject {
  githubRepo: string | null;
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
 * Parses `owner/repo` from `https://github.com/{owner}/{repo}/pull/{n}`
 * and compares against `project.githubRepo` (format `owner/repo`). Both
 * sides are lowercased so trivial capitalization differences don't reject.
 *
 * Returns `ok: true` when:
 *   - `project.githubRepo` is null (no binding to check against)
 *   - the `prUrl` does not match the github-URL shape (defensive: we
 *     only assert cross-repo here, not URL well-formedness — the caller
 *     validates URL syntax upstream)
 *   - the parsed project repo is malformed (likewise defensive)
 *   - both parse and match
 */
export function checkPrRepoMatchesProject(
  prUrl: string,
  project: PrRepoMatchesProjectProject,
): PrRepoMatchesProjectResult {
  if (!project.githubRepo) return { ok: true };

  const projectRepo = parseOwnerRepo(project.githubRepo);
  if (!projectRepo) return { ok: true };

  const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
  if (!prMatch) return { ok: true };

  const prOwner = prMatch[1];
  const prRepo = prMatch[2];
  if (
    prOwner.toLowerCase() !== projectRepo.owner.toLowerCase() ||
    prRepo.toLowerCase() !== projectRepo.repo.toLowerCase()
  ) {
    return {
      ok: false,
      reason: "cross_repo",
      prOwner,
      prRepo,
      projectRepo: project.githubRepo,
    };
  }
  return { ok: true };
}

export function prRepoMatchesProjectRejectionMessage(
  prOwner: string,
  prRepo: string,
  projectRepo: string,
): string {
  return `PR belongs to ${prOwner}/${prRepo} but this task's project is linked to ${projectRepo}`;
}

export const prRepoMatchesProjectGate: Gate = {
  code: GateCode.PrRepoMatchesProject,
  name: "PR URL repo matches project binding",
  appliesTo: ["task_finish", "submit_pr"],
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
