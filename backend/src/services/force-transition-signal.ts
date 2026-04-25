/**
 * Force-transition signal service.
 *
 * Emitted when an admin bypasses one or more `requires` gates on a task
 * transition (`POST /tasks/:id/transition {force: true}`). Without this,
 * the only trail is an audit-log row nobody reads — and gates are
 * meant to be explicit, not advisory.
 *
 * Recipients:
 *  - the task's current claimant (human OR agent, whichever is set)
 *  - the task's current reviewer (human OR agent, whichever is set, if any)
 *
 * Explicitly NOT notified:
 *  - team admins other than the forcing admin — would be noisy for
 *    teams with many admins; audit log already covers the "compliance"
 *    use case
 *  - anyone if the forced transition has no claimant and no reviewer
 *    (the signal would have nobody to go to)
 *
 * The forcing admin is NEVER a recipient of their own signal — even if
 * they happen to also be the claimant or reviewer — to avoid self-noise.
 */

import { prisma } from "../lib/prisma.js";
import { createSignal, type SignalContext } from "./signal.js";
import { logger } from "../lib/logger.js";

export interface ForceTransitionSignalInput {
  taskId: string;
  projectId: string;
  from: string;
  to: string;
  forcedRules: string[];
  forceReason?: string | null;
  /** User who forced the transition (always a human — agents can't force). */
  forcedByUserId: string;
}

/**
 * Emit force-transition signals. Does not throw — all side effects are
 * wrapped so a signal-write failure never prevents the transition from
 * persisting. Returns the number of signals written for observability.
 */
export async function emitForceTransitionedSignal(
  input: ForceTransitionSignalInput,
): Promise<number> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: input.taskId },
      include: { project: { select: { slug: true, name: true } } },
    });
    if (!task) return 0;

    const forcingUser = await prisma.user.findUnique({
      where: { id: input.forcedByUserId },
      select: { login: true, name: true },
    });
    const forcingName = forcingUser?.name ?? forcingUser?.login ?? "admin";

    const context: SignalContext = {
      taskTitle: task.title,
      taskStatus: task.status,
      projectSlug: task.project.slug,
      projectName: task.project.name,
      branchName: task.branchName,
      prUrl: task.prUrl,
      prNumber: task.prNumber,
      actor: { type: "human", name: forcingName },
      forceTransition: {
        from: input.from,
        to: input.to,
        forcedRules: input.forcedRules,
        forceReason: input.forceReason ?? null,
      },
    };

    // Build the recipient set. Each entry is at most one person/agent so
    // we can safely dedupe by a synthetic key.
    const targets = new Map<
      string,
      { recipientUserId?: string; recipientAgentId?: string }
    >();

    if (task.claimedByUserId && task.claimedByUserId !== input.forcedByUserId) {
      targets.set(`u:${task.claimedByUserId}`, { recipientUserId: task.claimedByUserId });
    }
    if (task.claimedByAgentId) {
      targets.set(`a:${task.claimedByAgentId}`, { recipientAgentId: task.claimedByAgentId });
    }
    if (
      task.reviewClaimedByUserId &&
      task.reviewClaimedByUserId !== input.forcedByUserId
    ) {
      targets.set(`u:${task.reviewClaimedByUserId}`, {
        recipientUserId: task.reviewClaimedByUserId,
      });
    }
    if (task.reviewClaimedByAgentId) {
      targets.set(`a:${task.reviewClaimedByAgentId}`, {
        recipientAgentId: task.reviewClaimedByAgentId,
      });
    }

    let written = 0;
    for (const [key, target] of targets.entries()) {
      try {
        await createSignal({
          type: "task_force_transitioned",
          taskId: input.taskId,
          projectId: input.projectId,
          recipientAgentId: target.recipientAgentId ?? null,
          recipientUserId: target.recipientUserId ?? null,
          context,
        });
        written++;
      } catch (err) {
        logger.error(
          {
            component: "force-signal",
            taskId: input.taskId,
            recipient: key,
            errMessage: (err as Error).message,
          },
          "force-signal recipient write failed",
        );
      }
    }

    return written;
  } catch (err) {
    // Signal emission is supplementary. A failure must not prevent the
    // transition from landing — match the audit-log error posture.
    logger.error(
      {
        component: "force-signal",
        taskId: input.taskId,
        errMessage: (err as Error).message,
      },
      "failed to emit force-transition signal",
    );
    return 0;
  }
}
