import { z } from "zod";
import type { Prisma, Signal } from "@prisma/client";
import type { Actor } from "../types/auth.js";
import { GovernanceMode, resolveGovernanceMode } from "../lib/governance-mode.js";
import { canonicalGroundingJson, GroundingAccessError, groundingWorkflow, mismatch, type GroundingTask } from "./grounding-context.js";
import type { GroundingDecision } from "./grounding-completion.js";
import type { OperationRequest } from "./grounding-operations.js";
import { isReviewState, isTerminalState } from "./default-workflow.js";

const text = z.string().max(32768);
const contextSchema = z.object({
  taskTitle: text, taskStatus: z.string().max(128), projectSlug: text, projectName: text,
  branchName: text.nullable(), prUrl: text.nullable(), prNumber: z.number().int().nullable(),
  actor: z.object({ type: z.enum(["human", "agent"]), name: text }).strict(),
  reviewComment: text.optional(), assigneeName: text.optional(),
}).strict();
const mergeMethod = z.enum(["merge", "squash", "rebase"]).default("squash");
const finishBody = z.object({ result: z.string().max(5000).optional(), prUrl: z.string().max(32768).optional(), prNumber: z.number().int().positive().optional(), autoMerge: z.boolean().default(false), mergeMethod }).strict();
const reviewBody = z.object({ result: z.string().max(5000).optional(), outcome: z.enum(["approve", "request_changes"]), autoMerge: z.boolean().default(false), mergeMethod }).strict();
const patchSchema = z.object({
  status: z.string().max(128), result: text.optional(),
  claimedByUserId: z.null().optional(), claimedByAgentId: z.null().optional(), claimedAt: z.null().optional(),
  reviewClaimedByUserId: z.null().optional(), reviewClaimedByAgentId: z.null().optional(), reviewClaimedAt: z.null().optional(),
}).strict();
const planSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["work_finish", "review_finish", "self_approve_finish", "task_merge", "abandon"]),
  action: z.enum(["finish", "approve", "request_changes", "merge", "abandon"]),
  remote: z.boolean(), alreadyMerged: z.boolean().optional(), patch: patchSchema,
  response: z.object({ kind: z.enum(["work", "review"]).optional(), targetStatus: z.string().max(128).optional(), outcome: z.enum(["approve", "request_changes"]).optional(), skippedGates: z.array(z.string().max(128)).max(128).optional() }).strict(),
  acknowledge: z.boolean(),
  signals: z.array(z.object({ type: z.enum(["review_needed", "changes_requested", "task_approved", "self_merge_notice"]), recipientAgentId: z.string().uuid().nullable(), recipientUserId: z.string().uuid().nullable(), context: contextSchema }).strict()).max(10000),
  comments: z.array(text).max(10),
  audits: z.array(z.object({ action: z.enum(["task.transitioned", "task.reviewed", "task.released", "task.auto_merged", "task.merged", "task.self_merge_notice_emitted", "task.foreign_pr_linked"]), payload: z.record(z.unknown()) }).strict()).max(10),
}).strict();
export type GroundingRoutePlan = z.infer<typeof planSchema>;

/** Compile only installed route behavior; transport data never supplies patches or recipients. */
export async function buildGroundingRoutePlan(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, request: OperationRequest, decision: GroundingDecision, remote: boolean): Promise<GroundingRoutePlan | undefined> {
  if (!request.route) return undefined;
  const { kind, transport } = request.route;
  const expectedEndpoint = kind === "task_merge" ? "merge" : kind === "abandon" ? "abandon" : "finish";
  if (transport.endpoint !== expectedEndpoint ||
      (kind === "work_finish" && request.action !== "finish") ||
      (["review_finish", "self_approve_finish"].includes(kind) && !["approve", "request_changes"].includes(request.action)) ||
      (kind === "task_merge" && (request.action !== "merge" || !remote)) ||
      (kind === "abandon" && (request.action !== "abandon" || remote))) throw new GroundingAccessError("bad_state", 409);
  const body = (kind === "work_finish" ? finishBody : kind === "review_finish" || kind === "self_approve_finish" ? reviewBody : kind === "task_merge" ? z.object({ mergeMethod }).strict() : z.object({}).strict()).safeParse(transport.body);
  if (!body.success) throw new GroundingAccessError("bad_state", 409);
  if (kind.endsWith("finish")) {
    const finish = body.data as z.infer<typeof finishBody> & { outcome?: string };
    if ((finish.result ?? null) !== request.result || finish.mergeMethod !== request.method || finish.autoMerge !== remote || (finish.outcome && finish.outcome !== request.action)) throw new GroundingAccessError("bad_state", 409);
  } else if (kind === "task_merge" && (body.data as { mergeMethod: string }).mergeMethod !== request.method) throw new GroundingAccessError("bad_state", 409);
  // Inline PR submission cannot replace the authoritative deliverable covered by the receipt.
  if ((transport.body.prUrl !== undefined && transport.body.prUrl !== task.prUrl) ||
      (transport.body.prNumber !== undefined && transport.body.prNumber !== task.prNumber)) mismatch();
  const holdsReview = actor.type === "agent" ? task.reviewClaimedByAgentId === actor.tokenId : task.reviewClaimedByUserId === actor.userId;
  if ((kind === "review_finish" && !holdsReview) || (kind === "self_approve_finish" && (task.reviewClaimedByAgentId || task.reviewClaimedByUserId))) throw new GroundingAccessError("forbidden", 403);
  const { def } = await groundingWorkflow(db, task);
  const terminal = isTerminalState(def, decision.to);
  if (remote && (!terminal || (kind === "work_finish" && resolveGovernanceMode(task.project) !== GovernanceMode.AUTONOMOUS))) throw new GroundingAccessError("bad_state", 409);
  const actorId = actor.type === "agent" ? actor.tokenId : actor.userId;
  const actorName = actor.type === "agent"
    ? (await db.agentToken.findUnique({ where: { id: actorId }, select: { name: true } }))?.name ?? "Agent"
    : (await db.user.findUnique({ where: { id: actorId }, select: { name: true, login: true } }))?.name ?? "Human";
  const context: z.infer<typeof contextSchema> = { taskTitle: task.title, taskStatus: decision.to, projectSlug: task.project.slug, projectName: task.project.name, branchName: task.branchName, prUrl: task.prUrl, prNumber: task.prNumber, actor: { type: actor.type, name: actorName } };
  const plan: GroundingRoutePlan = { version: 1, kind, action: request.action as GroundingRoutePlan["action"], remote, patch: decision.data,
    response: {}, acknowledge: terminal && ["finish", "approve", "merge"].includes(request.action), signals: [], comments: [], audits: [] };
  const audit = (action: GroundingRoutePlan["audits"][number]["action"], payload: Record<string, unknown>) => { plan.audits.push({ action, payload }); };
  if (kind === "work_finish") {
    plan.response = { kind: "work", targetStatus: decision.to };
    audit("task.transitioned", { from: decision.from, to: decision.to, actorType: actor.type, via: "task_finish" });
    if (task.deliverableRepo && task.deliverableRepo !== task.project.githubRepo && transport.body.prUrl) audit("task.foreign_pr_linked", { prUrl: task.prUrl, deliverableRepo: task.deliverableRepo, projectRepo: task.project.githubRepo, actorType: actor.type, via: "task_finish" });
    if (isReviewState(def, decision.to)) {
      const now = new Date();
      const agents = await db.agentToken.findMany({ where: { teamId: task.project.teamId, revokedAt: null, scopes: { has: "tasks:transition" }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], ...(task.claimedByAgentId ? { id: { not: task.claimedByAgentId } } : {}) }, select: { id: true, name: true }, orderBy: { id: "asc" } });
      const humans = await db.teamMember.findMany({ where: { teamId: task.project.teamId, role: { in: ["REVIEWER", "ADMIN"] }, ...(task.claimedByUserId ? { userId: { not: task.claimedByUserId } } : {}) }, select: { userId: true, user: { select: { name: true, login: true } } }, orderBy: { userId: "asc" } });
      const recipients = [...agents.map(a => ({ type: "agent" as const, id: a.id, name: a.name })), ...humans.map(h => ({ type: "human" as const, id: h.userId, name: h.user.name ?? h.user.login ?? "Unknown" }))];
      const assigneeName = task.claimedByAgentId ? (await db.agentToken.findUnique({ where: { id: task.claimedByAgentId }, select: { name: true } }))?.name ?? "Agent" : "Human";
      for (const r of recipients) plan.signals.push({ type: "review_needed", recipientAgentId: r.type === "agent" ? r.id : null, recipientUserId: r.type === "human" ? r.id : null, context: { ...context, actor: { type: "agent", name: assigneeName }, assigneeName } });
      plan.comments.push(recipients.length ? `[system] Review requested — eligible reviewers: ${recipients.map(r => `${r.name} (${r.type})`).join(", ")}` : "[system] Review requested — no eligible reviewers found");
      audit("task.reviewed", { event: "review_needed", recipientCount: recipients.length, recipients });
    }
  } else if (kind === "review_finish" || kind === "self_approve_finish") {
    const outcome = request.action as "approve" | "request_changes";
    plan.response = { kind: "review", outcome };
    audit("task.reviewed", { reviewAction: outcome, from: decision.from, to: decision.to, actorType: actor.type, reviewerId: actorId, via: kind === "self_approve_finish" ? "task_finish_self_approve" : "task_finish" });
    if (task.claimedByAgentId || task.claimedByUserId) {
      plan.signals.push({ type: outcome === "approve" ? "task_approved" : "changes_requested", recipientAgentId: task.claimedByAgentId, recipientUserId: task.claimedByUserId, context: { ...context, ...(request.result !== null ? { reviewComment: request.result } : {}) } });
      if (outcome === "request_changes") audit("task.reviewed", { event: "changes_requested_signal", recipientAgentId: task.claimedByAgentId, recipientUserId: task.claimedByUserId, reviewer: actorName });
    }
  } else if (kind === "abandon") {
    audit("task.released", { actorType: actor.type, claimType: holdsReview ? "review" : "work", via: "task_abandon" });
  }
  if (decision.skippedRules.length) plan.response.skippedGates = decision.skippedRules;
  if (remote) {
    if (kind === "task_merge") audit("task.merged", { via: "task_merge", actorType: actor.type, ...(actor.type === "agent" ? { agentTokenId: actorId } : {}), mergeMethod: request.method });
    else audit("task.auto_merged", { mode: kind === "work_finish" ? "A" : kind === "self_approve_finish" ? "B_self_approve" : "B", mergeMethod: request.method, actorType: actor.type });
    if (resolveGovernanceMode(task.project) === GovernanceMode.AWAITS_CONFIRMATION) {
      const humans = await db.teamMember.findMany({ where: { teamId: task.project.teamId, ...(actor.type === "human" ? { userId: { not: actor.userId } } : {}) }, select: { userId: true }, orderBy: { userId: "asc" } });
      for (const human of humans) plan.signals.push({ type: "self_merge_notice", recipientAgentId: null, recipientUserId: human.userId, context });
      if (humans.length) audit("task.self_merge_notice_emitted", { via: kind === "task_merge" ? "task_merge" : "task_finish_auto_merge", actorType: actor.type, ...(actor.type === "agent" ? { agentTokenId: actorId } : { userId: actorId }), recipientCount: humans.length });
    }
  }
  return readGroundingRoutePlan(plan);
}

export function readGroundingRoutePlan(value: unknown): GroundingRoutePlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success || canonicalGroundingJson(parsed.data).length > 4 * 1024 * 1024) mismatch();
  return parsed.data;
}

/** All required durable effects share the task/receipt transaction; no network work is performed. */
export async function applyGroundingRoutePlan(db: Prisma.TransactionClient, task: GroundingTask, decision: GroundingDecision, actorType: string, actorId: string, mergeCommitSha?: string) {
  const plan = readGroundingRoutePlan(decision.routePlan);
  if (plan.action !== decision.action || canonicalGroundingJson(plan.patch) !== canonicalGroundingJson(decision.data) || plan.remote !== Boolean(mergeCommitSha)) mismatch();
  if (plan.kind === "task_merge" && typeof plan.alreadyMerged !== "boolean") mismatch();
  if (plan.acknowledge) await db.signal.updateMany({ where: { taskId: task.id, acknowledgedAt: null }, data: { acknowledgedAt: new Date() } });
  const signals: Signal[] = [];
  for (const signal of plan.signals) signals.push(await db.signal.create({ data: { ...signal, taskId: task.id, projectId: task.projectId, context: signal.context } }));
  for (const content of plan.comments) await db.comment.create({ data: { taskId: task.id, content } });
  for (const audit of plan.audits) {
    const payload = { ...audit.payload };
    if (audit.action === "task.auto_merged") payload.autoMergeSha = mergeCommitSha!;
    if (audit.action === "task.merged") { payload.sha = mergeCommitSha!; payload.alreadyMerged = plan.alreadyMerged!; }
    if (audit.action === "task.self_merge_notice_emitted") payload.mergeSha = mergeCommitSha!;
    await db.auditLog.create({ data: { taskId: task.id, projectId: task.projectId, actorId: actorType === "human" ? actorId : null, action: audit.action, payload: payload as Prisma.InputJsonObject } });
  }
  const updated = await db.task.findUniqueOrThrow({ where: { id: task.id }, include: groundingRouteTaskInclude });
  const response = { ...plan.response, task: updated, ...(mergeCommitSha ? plan.kind === "task_merge" ? { merged: true, sha: mergeCommitSha, alreadyMerged: plan.alreadyMerged! } : { autoMergeSha: mergeCommitSha } : {}) };
  return { signals, response: JSON.parse(JSON.stringify(response)) as Prisma.InputJsonObject };
}

/** Same public task projection as the lifecycle routes; no agent credentials or artifact contents. */
export const groundingRouteTaskInclude = {
  attachments: { orderBy: { createdAt: "desc" as const }, include: { createdByUser: { select: { id: true, login: true, name: true, avatarUrl: true } } } },
  artifacts: { orderBy: { createdAt: "desc" as const }, select: { id: true, taskId: true, type: true, name: true, description: true, url: true, mimeType: true, sizeBytes: true, createdByUserId: true, createdByAgentId: true, createdAt: true, createdByUser: { select: { id: true, login: true, name: true, avatarUrl: true } }, createdByAgent: { select: { id: true, name: true } } } },
  comments: { orderBy: { createdAt: "asc" as const }, include: { authorUser: { select: { id: true, login: true, name: true, avatarUrl: true } }, authorAgent: { select: { id: true, name: true } } } },
  claimedByUser: { select: { id: true, login: true, name: true, avatarUrl: true } }, claimedByAgent: { select: { id: true, name: true } },
  reviewClaimedByUser: { select: { id: true, login: true, name: true, avatarUrl: true } }, reviewClaimedByAgent: { select: { id: true, name: true } },
  blockedBy: { select: { id: true, title: true, status: true } }, blocks: { select: { id: true, title: true, status: true } },
} satisfies Prisma.TaskInclude;
