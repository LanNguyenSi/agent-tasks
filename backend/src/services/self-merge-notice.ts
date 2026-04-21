/**
 * Self-Merge Notice Signal
 *
 * When a project opts out of `requireDistinctReviewer` but is NOT soloMode,
 * the intended governance model is "async human-in-the-loop": agents may
 * self-merge, but every human team member gets a signal so the merge is
 * visible without blocking the flow. Without this notification, the middle
 * tier `(soloMode: false, requireDistinctReviewer: false)` is behaviorally
 * indistinguishable from `soloMode: true` — which defeats the point of
 * having a flag for it.
 *
 * Guard: only fires when `!soloMode && !requireDistinctReviewer`. soloMode
 * projects emit nothing (by design). requireDistinctReviewer projects never
 * reach this code path — `checkSelfMergeGate` blocks the merge upstream.
 *
 * Recipients: every human team member (ADMIN, MAINTAINER, REVIEWER, MEMBER).
 * We don't narrow to reviewer/admin here because the whole point is broad
 * visibility — anyone on the team should be able to see what their agents
 * are doing. Agents are excluded — they already saw the merge, and this
 * signal is specifically a human-notification channel.
 */
import { prisma } from "../lib/prisma.js";
import { logAuditEvent } from "./audit.js";
import { createSignal, type SignalContext } from "./signal.js";
import type { Actor } from "../types/auth.js";

export interface SelfMergeNoticeInput {
  taskId: string;
  projectId: string;
  /** Actor who performed the merge. */
  actor: Actor;
  /** Mode flags resolved at call-site so the helper stays pure. */
  project: { soloMode: boolean; requireDistinctReviewer: boolean };
  /** SHA returned by the merge (for traceability). Omit if unavailable. */
  mergeSha?: string | null;
  /** Which code path fired: task_merge verb, /github/.../merge REST, webhook, task_finish autoMerge. */
  via:
    | "task_merge"
    | "github_pr_merge"
    | "webhook_pr_merged"
    | "task_finish_auto_merge";
}

/**
 * Emit a `self_merge_notice` signal to every human team member when the
 * merge happened under the "async HITL" tier. Safe to call unconditionally
 * — the guard is inside.
 *
 * Best-effort: never throws. A DB blip inside recipient lookup or signal
 * creation must NOT roll back a merge that already succeeded on GitHub and
 * on the task row. Callers should `void` this (matches the convention for
 * the other signal emitters in services/*-signal.ts per
 * docs/signal-payload-design.md).
 */
export async function emitSelfMergeNoticeIfApplicable(
  input: SelfMergeNoticeInput,
): Promise<number> {
  try {
    return await emitSelfMergeNoticeInner(input);
  } catch (err) {
    // Swallow — best-effort contract. Log to console so the failure is
    // still grep-able in production logs; the audit system is intentionally
    // not used here because writing to it could itself be the failure mode.
    // eslint-disable-next-line no-console
    console.error(
      `[self-merge-notice] emission failed for task ${input.taskId}:`,
      err,
    );
    return 0;
  }
}

async function emitSelfMergeNoticeInner(
  input: SelfMergeNoticeInput,
): Promise<number> {
  if (input.project.soloMode) return 0;
  if (input.project.requireDistinctReviewer) return 0;

  const task = await prisma.task.findUnique({
    where: { id: input.taskId },
    include: {
      project: { select: { teamId: true, slug: true, name: true } },
    },
  });
  if (!task) return 0;

  // Notify every human on the team EXCEPT the merging human, if the actor is
  // human. If the actor is an agent, every human is notified (the agent can't
  // self-notify). This keeps the notice from spamming a human with a message
  // about their own click.
  const excludeUserId = input.actor.type === "human" ? input.actor.userId : null;
  const humans = await prisma.teamMember.findMany({
    where: {
      teamId: task.project.teamId,
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
    },
    select: { userId: true },
  });
  if (humans.length === 0) return 0;

  const actorName = await resolveActorName(input.actor);

  const context: SignalContext = {
    taskTitle: task.title,
    taskStatus: "done",
    projectSlug: task.project.slug,
    projectName: task.project.name,
    branchName: task.branchName,
    prUrl: task.prUrl,
    prNumber: task.prNumber,
    actor: { type: input.actor.type, name: actorName },
  };

  for (const h of humans) {
    await createSignal({
      type: "self_merge_notice",
      taskId: input.taskId,
      projectId: input.projectId,
      recipientUserId: h.userId,
      context,
    });
  }

  void logAuditEvent({
    action: "task.self_merge_notice_emitted",
    projectId: input.projectId,
    taskId: input.taskId,
    payload: {
      via: input.via,
      actorType: input.actor.type,
      agentTokenId: input.actor.type === "agent" ? input.actor.tokenId : undefined,
      userId: input.actor.type === "human" ? input.actor.userId : undefined,
      mergeSha: input.mergeSha ?? null,
      recipientCount: humans.length,
    },
  });

  return humans.length;
}

async function resolveActorName(actor: Actor): Promise<string> {
  if (actor.type === "agent") {
    const row = await prisma.agentToken.findUnique({
      where: { id: actor.tokenId },
      select: { name: true },
    });
    return row?.name ?? "Agent";
  }
  const row = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { name: true, login: true },
  });
  return row?.name ?? row?.login ?? "Human";
}
