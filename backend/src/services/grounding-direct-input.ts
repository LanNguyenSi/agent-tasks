import { z } from "zod";
import { templateDataSchema } from "../lib/confidence.js";
import { httpUrl } from "../lib/url-guard.js";
import { canonicalGroundingJson, GroundingAccessError, mismatch, type GroundingTask } from "./grounding-context.js";
import type { OperationRequest } from "./grounding-operations.js";
import { directDescriptorSchema } from "./grounding-direct-context.js";

const status = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const directTransitionSchema = z.object({ status, force: z.boolean().optional(), forceReason: z.string().max(500).optional() }).strict();
export const directReviewSchema = z.object({ action: z.enum(["approve", "request_changes"]), comment: z.string().max(5000).optional() }).strict();
export const directPatchSchema = z.object({
  title: z.string().min(1).max(255).optional(), description: z.string().nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(), status: status.optional(),
  dueAt: z.string().datetime().nullable().optional(), branchName: z.string().max(255).nullable().optional(),
  prUrl: httpUrl().nullable().optional(), prNumber: z.number().int().positive().nullable().optional(),
  result: z.string().max(32768).nullable().optional(), templateData: templateDataSchema.nullable().optional(),
  externalRef: z.string().trim().min(1).max(255).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  deliverableRepo: z.string().trim().min(3).max(255).regex(/^[^/\s]+\/[^/\s]+$/).nullable().optional(),
}).strict();
export const directContextFields = ["title", "description", "templateData", "branchName", "prUrl", "prNumber", "deliverableRepo", "labels"] as const;
export function changesDirectContext(task: GroundingTask, body: Record<string, unknown>) {
  return directContextFields.some(key => body[key] !== undefined && canonicalGroundingJson(key === "labels" ? [...body[key] as string[]].sort() : body[key]) !== canonicalGroundingJson(key === "labels" ? [...task.labels].sort() : task[key]));
}
export function readDirectOperation(request: OperationRequest) {
  if (request.route?.kind !== "direct") return null;
  const endpoint = request.route.transport.endpoint;
  if (!["transition", "patch", "review"].includes(endpoint)) mismatch();
  const schema = endpoint === "transition" ? directTransitionSchema : endpoint === "review" ? directReviewSchema : directPatchSchema;
  const parsed = schema.safeParse(request.route.transport.body);
  if (!parsed.success || !request.route.direct) throw new GroundingAccessError("bad_state", 409);
  const descriptor = directDescriptorSchema.parse(request.route.direct);
  if (descriptor.endpoint !== endpoint || (endpoint !== "review" && (parsed.data as { status?: string }).status !== descriptor.target)) mismatch();
  const force = endpoint === "transition" && (parsed.data as z.infer<typeof directTransitionSchema>).force === true;
  const forceReason = endpoint === "transition" ? (parsed.data as z.infer<typeof directTransitionSchema>).forceReason?.trim() : undefined;
  if (force ? !forceReason || request.overrideReason !== forceReason : request.overrideReason !== null) throw new GroundingAccessError("bad_state", 409);
  return { descriptor, body: parsed.data, force };
}
