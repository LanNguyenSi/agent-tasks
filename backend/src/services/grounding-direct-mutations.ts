import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "../types/auth.js";
import { canonicalGroundingJson, GroundingAccessError, groundingAuthority, groundingWorkflow, type GroundingTask } from "./grounding-context.js";
import { mutateGroundingRouteContext } from "./grounding-route-context.js";
import { changesDirectContext, directPatchSchema } from "./grounding-direct-input.js";
import { checkPrRepoMatchesProject } from "./gates/pr-repo-matches-project.js";
import { groundingRouteTaskInclude } from "./grounding-route-effects.js";
import { groundingTransaction, lockGroundingTask, assertNoGroundingReservation } from "./grounding-transaction.js";
import { templateDataSchema, calculateConfidence, resolveEffectiveThreshold, resolveTriggeredRiskModifiers, combineEffectiveThreshold, type TemplateData, type TemplateFields } from "../lib/confidence.js";
import { deriveNextActions } from "./confidence-gate.js";
import { resolveEnforcementMode } from "../lib/enforcement-mode.js";

export const directRespecSchema = z.object({ description: z.string().trim().min(1).max(50000).optional(), templateData: templateDataSchema.refine(v => Object.keys(v).length > 0).optional() }).strict().refine(v => v.description !== undefined || v.templateData !== undefined);
export const directAgentPatchSchema = directPatchSchema.pick({ branchName: true, prUrl: true, prNumber: true, result: true });
export const directSubmitSchema = z.object({ branchName: z.string().min(1).max(255), prUrl: z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/), prNumber: z.number().int().positive() }).strict();
export class GroundingHistoryRetained extends GroundingAccessError {
  constructor() { super("grounding_history_retained", 409); }
}
export async function directWriteAccess(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, kind: "patch" | "respec" | "submit-pr") {
  if (actor.type === "agent" && !actor.scopes.includes(kind === "submit-pr" ? "tasks:transition" : "tasks:update")) throw new GroundingAccessError("forbidden", 403);
  if (!await groundingAuthority.canWrite(actor, task.projectId, db)) throw new GroundingAccessError("forbidden", 403);
  if (kind === "respec") {
    if (actor.type === "agent" && task.status !== "backlog" && task.createdByAgentId !== actor.tokenId && !task.project.allowNonCreatorRespec) throw new GroundingAccessError("forbidden", 403);
    if (!["open", "backlog"].includes(task.status) || task.claimedByUserId || task.claimedByAgentId || task.reviewClaimedByUserId || task.reviewClaimedByAgentId) throw new GroundingAccessError("bad_state", 409);
  }
  if (kind === "submit-pr") {
    const owns = actor.type === "agent" ? task.claimedByAgentId === actor.tokenId : task.claimedByUserId === actor.userId;
    if (!owns) throw new GroundingAccessError("forbidden", 403);
    const { def } = await groundingWorkflow(db, task);
    if (!def.states.some(s => s.name === task.status && !s.terminal)) throw new GroundingAccessError("bad_state", 409);
  }
}
export function directConfidence(task: GroundingTask) {
  const fields = (task.project.taskTemplate as { fields?: TemplateFields } | null)?.fields ?? null;
  const score = calculateConfidence({ title: task.title, description: task.description, templateData: task.templateData as TemplateData | null, templateFields: fields });
  const threshold = resolveEffectiveThreshold(score.inferredTaskType, task.project.taskTypeThresholds, task.project.confidenceThreshold);
  const risk = resolveTriggeredRiskModifiers(task, task.project.riskModifiers);
  const effectiveThreshold = combineEffectiveThreshold(threshold.effectiveThreshold, risk.riskModifierPoints);
  return { score: score.score, threshold: effectiveThreshold, effectiveThreshold, thresholdSource: threshold.thresholdSource, triggeredRiskModifiers: risk.triggeredRiskModifiers, enforcementMode: resolveEnforcementMode(task.project), blocking: score.blocking, missing: score.missing, findings: score.findings, nextActions: deriveNextActions(score.findings) };
}
export async function mutateDirectTask(client: PrismaClient, task: GroundingTask, actor: Actor, kind: "patch" | "respec" | "submit-pr", input: unknown) {
  const schema = kind === "respec" ? directRespecSchema : kind === "submit-pr" ? directSubmitSchema : actor.type === "agent" ? directAgentPatchSchema : directPatchSchema;
  const body: z.infer<typeof directPatchSchema> = schema.parse(input);
  if ("status" in body && body.status !== undefined && body.status !== task.status) throw new GroundingAccessError("bad_state", 409);
  const result = await mutateGroundingRouteContext(client, {
    taskId: task.id, projectId: task.projectId, actor, reason: `direct_${kind}`,
    revalidate: (db, fresh) => directWriteAccess(db, fresh, actor, kind),
    mutate: async (db, fresh) => {
      if ("status" in body && body.status !== undefined && body.status !== fresh.status) throw new GroundingAccessError("bad_state", 409);
      if ("deliverableRepo" in body && body.deliverableRepo !== undefined && !await groundingAuthority.hasRole(actor, fresh.projectId, "ADMIN", db)) throw new GroundingAccessError("forbidden", 403);
      if (body.prUrl && !checkPrRepoMatchesProject(body.prUrl, { deliverableRepo: "deliverableRepo" in body && body.deliverableRepo !== undefined ? body.deliverableRepo : fresh.deliverableRepo }, fresh.project).ok) throw new GroundingAccessError("forbidden", 403);
      const changed = changesDirectContext(fresh, body);
      const data: Prisma.TaskUpdateInput = {};
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined || key === "status") continue;
        const previous = fresh[key as keyof GroundingTask];
        const before = previous instanceof Date ? previous.toISOString() : previous;
        if (canonicalGroundingJson(key === "labels" ? [...value as string[]].sort() : value) !== canonicalGroundingJson(key === "labels" ? [...before as string[]].sort() : before)) Object.assign(data, { [key]: key === "templateData" && value === null ? Prisma.JsonNull : value });
      }
      const updated = Object.keys(data).length ? await db.task.update({ where: { id: task.id }, data, include: groundingRouteTaskInclude }) : await db.task.findUniqueOrThrow({ where: { id: task.id }, include: groundingRouteTaskInclude });
      if (Object.keys(data).length) {
        const audit = async (action: string, payload: Prisma.InputJsonObject) => db.auditLog.create({ data: { taskId: task.id, projectId: fresh.projectId, actorId: actor.type === "human" ? actor.userId : null, action, payload } });
        if (kind !== "patch") await audit(kind === "respec" ? "task.respec" : "task.pr_submitted", { actorType: actor.type, actorId: actor.type === "human" ? actor.userId : actor.tokenId, changes: Object.fromEntries(Object.keys(data).map(key => [key, { from: fresh[key as keyof GroundingTask], to: body[key as keyof typeof body] }])) as Prisma.InputJsonObject });
        if ("labels" in data) await audit("task.labels_changed", { from: fresh.labels, to: body.labels!, actorType: actor.type });
        if ("deliverableRepo" in data) await audit("task.deliverable_repo_changed", { from: fresh.deliverableRepo, to: body.deliverableRepo!, actorType: actor.type });
        if (body.prUrl && updated.deliverableRepo && updated.deliverableRepo !== fresh.project.githubRepo) await audit("task.foreign_pr_linked", { prUrl: body.prUrl, deliverableRepo: updated.deliverableRepo, projectRepo: fresh.project.githubRepo, actorType: actor.type, via: kind });
      }
      return { value: { task: updated, ...(kind === "respec" ? { confidence: directConfidence({ ...updated, project: fresh.project }) } : {}) }, changed };
    },
  });
  return result.value;
}

export async function rejectEnrolledDelete(client: PrismaClient, taskId: string, actor: Actor) {
  await groundingTransaction(client, async db => {
    const task = await lockGroundingTask(db, taskId);
    if (actor.type !== "human" || !await groundingAuthority.canWrite(actor, task.projectId, db)) throw new GroundingAccessError("forbidden", 403);
    await assertNoGroundingReservation(db, taskId);
    const history = await Promise.all([db.groundingCohort.count({ where: { taskId } }), db.groundingBinding.count({ where: { taskId } }), db.groundingOperation.count({ where: { taskId } }), db.groundingAttempt.count({ where: { taskId } })]);
    if (history.some(Boolean)) throw new GroundingHistoryRetained();
  });
}

export async function authorizeDirectSubmission(client: PrismaClient, taskId: string, actor: Actor) {
  await groundingTransaction(client, async db => {
    const task = await lockGroundingTask(db, taskId);
    await directWriteAccess(db, task, actor, "submit-pr");
    await assertNoGroundingReservation(db, taskId);
  });
}
