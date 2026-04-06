import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppVariables } from "../types/hono.js";
import type { Actor } from "../types/auth.js";
import { prisma } from "../lib/prisma.js";
import { findDelegationUser } from "../services/github-delegation.js";
import { logAuditEvent } from "../services/audit.js";
import { requireScope } from "../middleware/auth.js";

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
