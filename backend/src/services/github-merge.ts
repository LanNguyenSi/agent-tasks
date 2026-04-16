/**
 * Shared GitHub PR merge helper.
 *
 * Single point where `allowAgentPrMerge` delegation is resolved and the
 * GitHub Merge API is called. Used by:
 *   1. The existing `POST /api/github/pull-requests/:prNumber/merge` route
 *   2. `task_finish { autoMerge: true }` (Mode A and Mode B)
 *
 * Owner/repo is derived from `task.project.githubRepo` — NOT from any
 * request body — closing the cross-repo exploit path (ADR-0010 §5b).
 */
import { findDelegationUser } from "./github-delegation.js";
import { logAuditEvent } from "./audit.js";
import { parseOwnerRepo } from "./transition-rules.js";
import type { Actor } from "../types/auth.js";

export interface MergeTask {
  id: string;
  prNumber: number | null;
  project: {
    id: string;
    teamId: string;
    githubRepo: string | null;
  };
}

export type MergeResult =
  | { ok: true; sha: string | null; alreadyMerged: boolean }
  | { ok: false; error: "no_delegation" | "github_error"; message: string; status?: number };

export async function performPrMerge(
  task: MergeTask,
  mergeMethod: "squash" | "merge" | "rebase",
  actor: Actor,
): Promise<MergeResult> {
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

  // Resolve delegation user with merge consent.
  const delegationUser = await findDelegationUser(task.project.teamId, "allowAgentPrMerge");
  if (!delegationUser) {
    return {
      ok: false,
      error: "no_delegation",
      message:
        "No authorized user for GitHub delegation. A team member must connect GitHub and enable 'Allow agents to merge PRs' in Settings.",
    };
  }

  // Call GitHub Merge API.
  const { owner, repo } = parsed;
  const prNumber = task.prNumber;
  let ghResponse: Response;
  try {
    ghResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
      {
        method: "PUT",
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
