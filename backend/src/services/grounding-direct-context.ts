import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Actor } from "../types/auth.js";
import { GroundingAccessError, groundingAuthority, groundingWorkflow, mismatch, type GroundingAuthority, type GroundingTask } from "./grounding-context.js";
import { isReviewState, isTerminalState, approveTarget, requestChangesTarget } from "./default-workflow.js";
import { checkReviewApprovalGate } from "./review-gate.js";

export const directDescriptorSchema = z.object({
  version: z.literal(1), endpoint: z.enum(["transition", "patch", "review"]),
  target: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
}).strict();
export type GroundingDirectDescriptor = z.infer<typeof directDescriptorSchema>;
export function readDirectDescriptor(value: unknown): GroundingDirectDescriptor | null {
  if (value === null) return null;
  const parsed = directDescriptorSchema.safeParse(value);
  if (!parsed.success) mismatch();
  return parsed.data;
}
export async function requireDirectActor(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, endpoint: GroundingDirectDescriptor["endpoint"], authority: GroundingAuthority = groundingAuthority) {
  if ((endpoint === "patch" && actor.type !== "human") ||
      (actor.type === "agent" && !actor.scopes.includes("tasks:transition")) ||
      !await authority.canWrite(actor, task.projectId, db)) throw new GroundingAccessError("forbidden", 403);
}

/** Installed endpoint policy, independent of v2 claim ownership. Never selected by receipt input. */
export async function resolveDirectGroundingTarget(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, descriptor: GroundingDirectDescriptor, authority: GroundingAuthority = groundingAuthority, force = false) {
  const direct = readDirectDescriptor(descriptor)!;
  await requireDirectActor(db, task, actor, direct.endpoint, authority);
  if (force && (direct.endpoint !== "transition" || actor.type !== "human" || !await authority.hasRole(actor, task.projectId, "ADMIN", db))) throw new GroundingAccessError("forbidden", 403);
  const { definition, def, workflowId } = await groundingWorkflow(db, task);
  const to = direct.target;
  const fromReview = isReviewState(def, task.status);
  const discard = direct.endpoint === "patch" && task.status === "backlog" && to === "abandoned";
  const promote = direct.endpoint === "patch" && task.status === "backlog" && to === "open";
  const reopen = direct.endpoint === "patch" && task.status === "abandoned" && to === def.initialState;
  if (reopen && !await authority.hasRole(actor, task.projectId, "ADMIN", db)) throw new GroundingAccessError("forbidden", 403);
  const edge = def.transitions.find(t => t.from === task.status && t.to === to);
  if (!edge && !discard && !promote && !reopen) throw new GroundingAccessError("bad_state", 409);
  if (edge?.requiredRole && !await authority.hasRole(actor, task.projectId, edge.requiredRole, db)) throw new GroundingAccessError("forbidden", 403);
  const terminal = isTerminalState(def, to);
  // A discard is a disposition even when a custom workflow includes abandoned as terminal.
  const success = !discard && !promote && !reopen && to !== "abandoned" && (terminal || isReviewState(def, to));
  if (direct.endpoint === "review") {
    if (task.status !== "review" || ![approveTarget(def, task.status), requestChangesTarget(def, task.status)].includes(to)) throw new GroundingAccessError("bad_state", 409);
    const holdsReview = actor.type === "agent" ? task.reviewClaimedByAgentId === actor.tokenId : task.reviewClaimedByUserId === actor.userId;
    if ((task.reviewClaimedByAgentId || task.reviewClaimedByUserId) && !holdsReview) throw new GroundingAccessError("bad_state", 409);
    if (!checkReviewApprovalGate(task, actor, task.project).allowed) throw new GroundingAccessError("forbidden", 403);
  } else if (fromReview && terminal && !force && !checkReviewApprovalGate(task, actor, task.project).allowed) throw new GroundingAccessError("forbidden", 403);
  const action = success ? fromReview ? "approve" as const : "finish" as const : "transition" as const;
  return { target: { workflowId, from: task.status, to, action: action === "transition" ? "approve" as const : action }, definition, def, action, success, terminal, special: discard ? "task.backlog_discarded" as const : promote ? "task.backlog_promoted" as const : reopen ? "task.unabandoned" as const : null };
}
