import { createHash } from "node:crypto";
import { z } from "zod";
import type { Actor } from "../types/auth.js";
import type { GroundingOperation, Prisma } from "@prisma/client";
import { canonicalGroundingJson, GroundingAccessError, groundingAuthority, type GroundingAuthority, type GroundingTask } from "./grounding-context.js";
import { GroundingDecisionError } from "./grounding-transaction.js";

export const operationRequestSchema = z.object({
  action: z.enum(["finish", "approve", "merge", "request_changes", "abandon", "release", "creator_abandon", "reopen"]),
  result: z.string().max(32768).nullable().default(null),
  reason: z.string().trim().min(1).max(2000).nullable().default(null),
  overrideReason: z.string().trim().min(1).max(2000).nullable().default(null),
  method: z.enum(["merge", "squash", "rebase"]).default("squash"),
}).strict();
export type OperationRequest = z.infer<typeof operationRequestSchema>;
export type OperationInput = z.input<typeof operationRequestSchema>;
export function operationRequest(input: OperationInput): OperationRequest {
  const parsed = operationRequestSchema.safeParse(input);
  if (!parsed.success || (!['finish', 'approve', 'merge'].includes(parsed.data.action) && parsed.data.overrideReason !== null)) throw new GroundingAccessError("bad_state", 409);
  return parsed.data;
}
export function groundingActorId(actor: Actor) { return actor.type === "agent" ? actor.tokenId : actor.userId; }
export function operationFingerprint(request: OperationRequest) { return createHash("sha256").update(canonicalGroundingJson(request)).digest("hex"); }
export function checkOperationActor(operation: GroundingOperation, actor: Actor) {
  if (operation.actorType !== actor.type || operation.actorId !== groundingActorId(actor)) throw new GroundingAccessError("forbidden", 403);
}
export async function operationAccess(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, authority: GroundingAuthority = groundingAuthority) {
  if (!await authority.canWrite(actor, task.projectId, db)) throw new GroundingAccessError("forbidden", 403);
}
export async function findOperation(db: Prisma.TransactionClient, taskId: string, key: string, actor: Actor, request?: OperationRequest) {
  if (!z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).safeParse(key).success) throw new GroundingAccessError("bad_state", 409);
  const existing = await db.groundingOperation.findUnique({ where: { taskId_key: { taskId, key } } });
  if (existing) {
    checkOperationActor(existing, actor);
    if (request && existing.fingerprint !== operationFingerprint(request)) throw new GroundingDecisionError("grounding_operation_conflict");
  }
  return existing;
}
