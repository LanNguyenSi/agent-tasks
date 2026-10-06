/**
 * Shared GitHub PR merge helper.
 *
 * Single point where `allowAgentPrMerge` delegation is resolved and the
 * GitHub Merge API is called. Used by:
 *   1. The existing `POST /api/github/pull-requests/:prNumber/merge` route
 *   2. `task_finish { autoMerge: true }` (Mode A and Mode B)
 *   3. `POST /tasks/:id/merge`
 *
 * Owner/repo is derived from `task.project.githubRepo` — NOT from any
 * request body — closing the cross-repo exploit path (ADR-0010 §5b).
 *
 * With Grounding configured, the caller passes the runtime's effect-boundary
 * guard, which checks exactly the repository and PR number this function is
 * about to send immediately before the GitHub merge call, and the call does
 * not follow a GitHub redirect (a renamed or transferred repository); the
 * unconfigured application passes null, no guard runs and the call keeps
 * fetch's default redirect handling.
 *
 * ADR-0010 §5c: a task's PR lifecycle may belong to a foreign repo via
 * `deliverableRepo`. This project's GitHub delegation token has no standing
 * there, so merge automation refuses outright — checked HERE, at the single
 * choke point every caller already goes through, so no call site can forget
 * the refusal.
 */
import { findDelegationUser } from "./github-delegation.js";
import { logAuditEvent } from "./audit.js";
import { parseOwnerRepo } from "./transition-rules.js";
import {
  effectiveDeliverableRepo,
  isForeignDeliverable,
} from "./gates/pr-repo-matches-project.js";
import type { Actor } from "../types/auth.js";
import { groundingRedirectRefusal, isGithubRedirect, type GroundingRemoteRefusalCode, type GroundingRemoteTargetGuard } from "./grounding-scope.js";

export interface MergeTask {
  id: string;
  prNumber: number | null;
  deliverableRepo?: string | null;
  project: {
    id: string;
    teamId: string;
    githubRepo: string | null;
  };
}

export type MergeResult =
  | { ok: true; sha: string | null; alreadyMerged: boolean }
  | {
      ok: false;
      error: "no_delegation" | "github_error" | "foreign_deliverable_merge_refused" | "merge_in_progress" | "conflict" | GroundingRemoteRefusalCode | typeof groundingRedirectRefusal.error;
      message: string;
      status?: number;
    };

/**
 * Runs once every refusal that needs no GitHub call has passed (foreign
 * deliverable, missing repository or PR number, no delegation, the grounding
 * effect-boundary guard), immediately before the irreversible merge call. The
 * merge paths use it to take the task's merge reservation (see
 * task-merge-reservation.ts) there, so a refused merge never touches the task
 * row and a task that moved since the caller's gates refuses the merge instead
 * of merging. Returns null to proceed, or the refusal to answer.
 */
export type BeforeGithubMerge = () => Promise<Extract<MergeResult, { ok: false }> | null>;

export async function performPrMerge(
  task: MergeTask,
  mergeMethod: "squash" | "merge" | "rebase",
  actor: Actor,
  groundingGuard: GroundingRemoteTargetGuard | null,
  beforeGithubMerge?: BeforeGithubMerge,
): Promise<MergeResult> {
  // Foreign-deliverable hard refusal. A task whose effective deliverable
  // repo diverges from project.githubRepo has its PR lifecycle owned by
  // that foreign repo — merge it there directly. An override equal to
  // project.githubRepo (in any casing — GitHub names are case-insensitive)
  // is a harmless no-op and does NOT trip this.
  if (isForeignDeliverable(task, task.project)) {
    const effectiveRepo = effectiveDeliverableRepo(task, task.project);
    return {
      ok: false,
      error: "foreign_deliverable_merge_refused",
      message: `This task's deliverable PR lives in ${effectiveRepo ?? "an external repo"}, not this project's linked repo (${task.project.githubRepo ?? "none"}). ${effectiveRepo ?? "The foreign repo"} owns its own merge lifecycle — merge automation refuses to act on it. Merge the PR directly on the foreign repo.`,
      status: 409,
    };
  }

  // Derive owner/repo from the project — never from request body.
  const parsed = parseOwnerRepo(task.project.githubRepo);
  if (!parsed) {
    return {
      ok: false,
      error: "github_error",
      message: "Project has no linked GitHub repository (githubRepo is missing or malformed).",
    };
  }

  if (task.prNumber == null) {
    return {
      ok: false,
      error: "github_error",
      message: "Task has no PR number. Call task_submit_pr first.",
    };
  }

  // Resolve delegation user with merge consent. Prefer the actor (token
  // owner for agents, the human themselves for human callers) so GitHub
  // operations attribute to the user who triggered them.
  const delegationUser = await findDelegationUser(task.project.teamId, "allowAgentPrMerge", {
    preferUserId: actor.userId,
  });
  if (!delegationUser) {
    return {
      ok: false,
      error: "no_delegation",
      message:
        "No authorized user for GitHub delegation. A team member must connect GitHub and enable 'Allow agents to merge PRs' in Settings.",
    };
  }

  const { owner, repo } = parsed;
  const prNumber = task.prNumber;
  // Grounding effect-boundary check on exactly the repository and PR number
  // sent below, immediately before the call.
  if (groundingGuard) {
    const refused = await groundingGuard({ repo: `${owner}/${repo}`, prNumber, kind: "merge", taskId: task.id });
    if (refused) return { ok: false, error: refused.error, message: refused.message, status: refused.status };
  }

  // The last point before the irreversible call: let the caller take its
  // merge reservation (bound to the state its gates decided from).
  if (beforeGithubMerge) {
    const refusal = await beforeGithubMerge();
    if (refusal) return refusal;
  }

  // Call GitHub Merge API.
  let ghResponse: Response;
  try {
    ghResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
      {
        method: "PUT",
        ...(groundingGuard ? { redirect: "manual" as const } : {}),
        headers: {
          Authorization: `Bearer ${delegationUser.githubAccessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "agent-tasks-bot",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ merge_method: mergeMethod }),
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void logAuditEvent({
      action: "github.pr_merge_failed",
      projectId: task.project.id,
      taskId: task.id,
      payload: {
        agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
        owner,
        repo,
        prNumber,
        mergeMethod,
        error: message,
      },
    });
    return { ok: false, error: "github_error", message: `GitHub API unreachable: ${message}`, status: 502 };
  }

  // A redirect answer is not a merge result: re-sending the PUT would reach a
  // repository the check above never saw, so it is refused instead.
  if (groundingGuard && isGithubRedirect(ghResponse)) {
    await ghResponse.body?.cancel().catch(() => undefined);
    void logAuditEvent({
      action: "github.pr_merge_failed",
      projectId: task.project.id,
      taskId: task.id,
      payload: {
        agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
        owner,
        repo,
        prNumber,
        mergeMethod,
        githubStatus: ghResponse.status,
        githubMessage: groundingRedirectRefusal.error,
      },
    });
    return { ok: false, error: groundingRedirectRefusal.error, message: groundingRedirectRefusal.message, status: groundingRedirectRefusal.status };
  }

  if (!ghResponse.ok) {
    const ghError = (await ghResponse.json().catch(() => ({ message: "Unknown GitHub error" }))) as {
      message?: string;
    };

    // 405 "already been merged" is idempotent success.
    if (ghResponse.status === 405 && ghError.message?.includes("already been merged")) {
      void logAuditEvent({
        action: "github.pr_merged",
        actorId: delegationUser.userId,
        projectId: task.project.id,
        taskId: task.id,
        payload: {
          agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
          delegatedUserId: delegationUser.userId,
          delegatedUserLogin: delegationUser.login,
          owner,
          repo,
          prNumber,
          mergeMethod,
          sha: null,
          alreadyMerged: true,
        },
      });
      return { ok: true, sha: null, alreadyMerged: true };
    }

    // Genuine failure.
    void logAuditEvent({
      action: "github.pr_merge_failed",
      projectId: task.project.id,
      taskId: task.id,
      payload: {
        agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
        owner,
        repo,
        prNumber,
        mergeMethod,
        githubStatus: ghResponse.status,
        githubMessage: ghError.message,
      },
    });
    return {
      ok: false,
      error: "github_error",
      message: `GitHub API error: ${ghError.message ?? ghResponse.statusText}`,
      status: ghResponse.status,
    };
  }

  // Success.
  const mergeResult = (await ghResponse.json()) as { sha: string; message: string; merged: boolean };

  void logAuditEvent({
    action: "github.pr_merged",
    actorId: delegationUser.userId,
    projectId: task.project.id,
    taskId: task.id,
    payload: {
      agentTokenId: actor.type === "agent" ? actor.tokenId : undefined,
      delegatedUserId: delegationUser.userId,
      delegatedUserLogin: delegationUser.login,
      owner,
      repo,
      prNumber,
      mergeMethod,
      sha: mergeResult.sha,
    },
  });

  return { ok: true, sha: mergeResult.sha, alreadyMerged: false };
}
