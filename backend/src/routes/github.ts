import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppVariables } from "../types/hono.js";
import type { Actor } from "../types/auth.js";
import { prisma } from "../lib/prisma.js";
import { findDelegationUser } from "../services/github-delegation.js";
import { logAuditEvent } from "../services/audit.js";
import { requireScope } from "../middleware/auth.js";
import { checkDistinctReviewerGate, distinctReviewerRejectionMessage } from "../services/review-gate.js";

export const githubRouter = new Hono<{ Variables: AppVariables }>();

const createPrSchema = z.object({
  taskId: z.string().uuid(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  head: z.string().min(1),
  base: z.string().min(1).default("main"),
  title: z.string().min(1),
  body: z.string().optional(),
});

githubRouter.post(
  "/pull-requests",
  requireScope("tasks:update"),
  zValidator("json", createPrSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;
    if (actor.type !== "agent") {
      return c.json({ error: "forbidden", message: "Agent token required" }, 403);
    }

    const body = c.req.valid("json");

    // 1. Find the task and verify it exists
    const task = await prisma.task.findUnique({
      where: { id: body.taskId },
      include: { project: { select: { id: true, teamId: true } } },
    });

    if (!task) {
      return c.json({ error: "not_found", message: "Task not found" }, 404);
    }

    // 2. Find a user with GitHub connected + allowAgentPrCreate consent
    const delegationUser = await findDelegationUser(task.project.teamId, "allowAgentPrCreate");

    if (!delegationUser) {
      return c.json(
        { error: "forbidden", message: "No authorized user for GitHub delegation. A team member must connect GitHub and enable 'Allow agents to create PRs' in Settings." },
        403,
      );
    }

    // 3. Call GitHub API to create PR
    const ghResponse = await fetch(`https://api.github.com/repos/${body.owner}/${body.repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${delegationUser.githubAccessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "agent-tasks-bot",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: body.title,
        body: body.body ?? "",
        head: body.head,
        base: body.base,
      }),
    });

    if (!ghResponse.ok) {
      const ghError = await ghResponse.json().catch(() => ({ message: "Unknown GitHub error" })) as { message?: string };
      return c.json(
        { error: "github_error", message: `GitHub API error: ${ghError.message ?? ghResponse.statusText}` },
        ghResponse.status as 400 | 403 | 404 | 422 | 500,
      );
    }

    const pr = await ghResponse.json() as { number: number; html_url: string; title: string };

    // 4. Update task with PR metadata
    await prisma.task.update({
      where: { id: body.taskId },
      data: {
        branchName: body.head,
        prUrl: pr.html_url,
        prNumber: pr.number,
      },
    });

    // 5. Audit log
    await logAuditEvent({
      action: "github.pr_created",
      actorId: delegationUser.userId,
      projectId: task.project.id,
      taskId: task.id,
      payload: {
        agentTokenId: actor.tokenId,
        delegatedUserId: delegationUser.userId,
        delegatedUserLogin: delegationUser.login,
        owner: body.owner,
        repo: body.repo,
        prNumber: pr.number,
        prUrl: pr.html_url,
      },
    });

    return c.json({
      pullRequest: {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
      },
      task: {
        id: task.id,
        branchName: body.head,
        prUrl: pr.html_url,
        prNumber: pr.number,
      },
    }, 201);
  },
);

// ── Merge PR ─────────────────────────────────────────────────────────────────

const mergePrSchema = z.object({
  taskId: z.string().uuid(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  merge_method: z.enum(["merge", "squash", "rebase"]).default("squash"),
});

githubRouter.post(
  "/pull-requests/:prNumber/merge",
  requireScope("tasks:transition"),
  zValidator("json", mergePrSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;
    if (actor.type !== "agent") {
      return c.json({ error: "forbidden", message: "Agent token required" }, 403);
    }

    const prNumber = parseInt(c.req.param("prNumber"), 10);
    if (isNaN(prNumber)) {
      return c.json({ error: "bad_request", message: "Invalid PR number" }, 400);
    }

    const body = c.req.valid("json");

    // 1. Find the task. Pull `requireDistinctReviewer` from the project
    // alongside the team id so the distinct-reviewer gate below can run
    // without a second round-trip.
    const task = await prisma.task.findUnique({
      where: { id: body.taskId },
      include: {
        project: {
          select: { id: true, teamId: true, requireDistinctReviewer: true },
        },
      },
    });

    if (!task) {
      return c.json({ error: "not_found", message: "Task not found" }, 404);
    }

    // Governance gate: merging drives the task to `done`, so the same
    // review→done invariants the /transition handler enforces must also
    // apply here. Previously this endpoint wrote `status: "done"`
    // directly no matter what the task's current status was — which meant
    // an agent could fast-track an `open` or `in_progress` task straight
    // to done by pointing this endpoint at a valid PR number, bypassing
    // every workflow precondition, every review lock, and every
    // distinct-reviewer check.
    //
    // Two legal entry states:
    //   - `review`: normal happy path, apply the distinct-reviewer gate
    //   - `done`: idempotent re-try against an already-merged PR; the gate
    //     was evaluated when the task first reached `done` and does not
    //     need to run again (re-checking would spuriously reject
    //     admin-force-transitioned tasks that never held a review lock).
    //
    // Admin escape hatch: admins who need to bypass this gate use
    // `POST /tasks/:id/transition` with `force: true` + `forceReason` first
    // (that endpoint's existing admin-gated force path), which moves the
    // task to `done`, and THEN call this merge endpoint to perform the
    // actual GitHub merge. The escape hatch lives in exactly one place —
    // the transition handler — instead of being duplicated here where the
    // actor is always an agent and can never satisfy `isProjectAdmin`.
    if (task.status === "open" || task.status === "in_progress") {
      void logAuditEvent({
        action: "task.merge_rejected_bad_status",
        projectId: task.project.id,
        taskId: task.id,
        payload: {
          status: task.status,
          agentTokenId: actor.tokenId,
          owner: body.owner,
          repo: body.repo,
          prNumber,
        },
      });
      return c.json(
        {
          error: "forbidden",
          message: `Cannot merge: task is in '${task.status}', expected 'review'. Transition the task to 'review' first (POST /tasks/:id/transition) — or, if you need to bypass the review flow entirely, force-transition to 'done' as an admin and then re-run this merge.`,
        },
        403,
      );
    }
    if (task.status !== "review" && task.status !== "done") {
      // Any future status other than open/in_progress/review/done falls
      // through here. Fail closed and audit so the unknown-status attempt
      // is visible in the timeline.
      void logAuditEvent({
        action: "task.merge_rejected_bad_status",
        projectId: task.project.id,
        taskId: task.id,
        payload: {
          status: task.status,
          agentTokenId: actor.tokenId,
          owner: body.owner,
          repo: body.repo,
          prNumber,
          unknown: true,
        },
      });
      return c.json(
        {
          error: "forbidden",
          message: `Cannot merge: task is in '${task.status}', expected 'review' or 'done'.`,
        },
        403,
      );
    }

    // Distinct-reviewer gate. Only runs on the review→done path — the
    // `done` idempotent entry skips it on purpose (see above). Shared
    // service from backend/src/services/review-gate.ts keeps this in
    // lockstep with the /transition handler so the rule cannot drift.
    if (task.status === "review") {
      const gate = checkDistinctReviewerGate(task, actor, task.project);
      if (!gate.allowed) {
        void logAuditEvent({
          action: "task.review_rejected_self_reviewer",
          projectId: task.project.id,
          taskId: task.id,
          payload: {
            reason: gate.reason,
            actorType: actor.type,
            agentTokenId: actor.tokenId,
            endpoint: "merge",
            claimedByUserId: task.claimedByUserId,
            claimedByAgentId: task.claimedByAgentId,
            reviewClaimedByUserId: task.reviewClaimedByUserId,
            reviewClaimedByAgentId: task.reviewClaimedByAgentId,
          },
        });
        return c.json(
          { error: "forbidden", message: distinctReviewerRejectionMessage() },
          403,
        );
      }
    }

    // 2. Find a user with merge consent
    const delegationUser = await findDelegationUser(task.project.teamId, "allowAgentPrMerge");

    if (!delegationUser) {
      return c.json(
        { error: "forbidden", message: "No authorized user for GitHub delegation. A team member must connect GitHub and enable 'Allow agents to merge PRs' in Settings." },
        403,
      );
    }

    // 3. Call GitHub API to merge PR
    const ghResponse = await fetch(`https://api.github.com/repos/${body.owner}/${body.repo}/pulls/${prNumber}/merge`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${delegationUser.githubAccessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "agent-tasks-bot",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        merge_method: body.merge_method,
      }),
    });

    if (!ghResponse.ok) {
      const ghError = await ghResponse.json().catch(() => ({ message: "Unknown GitHub error" })) as { message?: string };
      // PR already merged is fine (idempotent)
      if (ghResponse.status === 405 && ghError.message?.includes("already been merged")) {
        // fall through to update task
      } else {
        return c.json(
          { error: "github_error", message: `GitHub API error: ${ghError.message ?? ghResponse.statusText}` },
          ghResponse.status as 400 | 403 | 404 | 405 | 409 | 422 | 500,
        );
      }
    }

    const mergeResult = ghResponse.ok
      ? await ghResponse.json() as { sha: string; message: string; merged: boolean }
      : { sha: null, message: "Already merged", merged: true };

    // 4. Update task status to done
    await prisma.task.update({
      where: { id: body.taskId },
      data: { status: "done" },
    });

    // 5. Audit log
    await logAuditEvent({
      action: "github.pr_merged",
      actorId: delegationUser.userId,
      projectId: task.project.id,
      taskId: task.id,
      payload: {
        agentTokenId: actor.tokenId,
        delegatedUserId: delegationUser.userId,
        delegatedUserLogin: delegationUser.login,
        owner: body.owner,
        repo: body.repo,
        prNumber,
        mergeMethod: body.merge_method,
        sha: mergeResult.sha,
      },
    });

    return c.json({
      merged: mergeResult.merged,
      sha: mergeResult.sha,
      message: mergeResult.message,
      task: {
        id: task.id,
        status: "done",
      },
    });
  },
);

// ── Comment on PR ────────────────────────────────────────────────────────────

const commentPrSchema = z.object({
  taskId: z.string().uuid(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  body: z.string().min(1),
});

githubRouter.post(
  "/pull-requests/:prNumber/comments",
  requireScope("tasks:comment"),
  zValidator("json", commentPrSchema),
  async (c) => {
    const actor = c.get("actor") as Actor;
    if (actor.type !== "agent") {
      return c.json({ error: "forbidden", message: "Agent token required" }, 403);
    }

    const prNumber = parseInt(c.req.param("prNumber"), 10);
    if (isNaN(prNumber)) {
      return c.json({ error: "bad_request", message: "Invalid PR number" }, 400);
    }

    const body = c.req.valid("json");

    // 1. Find the task
    const task = await prisma.task.findUnique({
      where: { id: body.taskId },
      include: { project: { select: { id: true, teamId: true } } },
    });

    if (!task) {
      return c.json({ error: "not_found", message: "Task not found" }, 404);
    }

    // 2. Find a user with comment consent
    const delegationUser = await findDelegationUser(task.project.teamId, "allowAgentPrComment");

    if (!delegationUser) {
      return c.json(
        { error: "forbidden", message: "No authorized user for GitHub delegation. A team member must connect GitHub and enable 'Allow agents to comment on PRs' in Settings." },
        403,
      );
    }

    // 3. Call GitHub API to post comment (issues API works for PR comments)
    const ghResponse = await fetch(`https://api.github.com/repos/${body.owner}/${body.repo}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${delegationUser.githubAccessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "agent-tasks-bot",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: body.body }),
    });

    if (!ghResponse.ok) {
      const ghError = await ghResponse.json().catch(() => ({ message: "Unknown GitHub error" })) as { message?: string };
      return c.json(
        { error: "github_error", message: `GitHub API error: ${ghError.message ?? ghResponse.statusText}` },
        ghResponse.status as 400 | 403 | 404 | 422 | 500,
      );
    }

    const comment = await ghResponse.json() as { id: number; html_url: string; body: string };

    // 4. Audit log
    await logAuditEvent({
      action: "github.pr_commented",
      actorId: delegationUser.userId,
      projectId: task.project.id,
      taskId: task.id,
      payload: {
        agentTokenId: actor.tokenId,
        delegatedUserId: delegationUser.userId,
        delegatedUserLogin: delegationUser.login,
        owner: body.owner,
        repo: body.repo,
        prNumber,
        commentId: comment.id,
        commentUrl: comment.html_url,
      },
    });

    return c.json({
      comment: {
        id: comment.id,
        url: comment.html_url,
        body: comment.body,
      },
    }, 201);
  },
);
