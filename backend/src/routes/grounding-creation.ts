import { Hono } from "hono";
import { z } from "zod";
import { type Signal, type PrismaClient } from "@prisma/client";
import type { AppVariables } from "../types/hono.js";
import { maybeDeliverSignalWebhook } from "../services/signal.js";
import { createTaskSchema, importTaskSchema } from "./tasks.js";
import { GroundingAccessError, groundingAuthority, groundingWorkflow, unavailable } from "../services/grounding-context.js";
import { groundingTransaction, lockGroundingProjects } from "../services/grounding-transaction.js";
import type { GroundingAttemptsService } from "../services/grounding-attempts.js";
import { isReviewState, isTerminalState } from "../services/default-workflow.js";
import { groundingRouteTaskInclude } from "../services/grounding-route-effects.js";
import { directConfidence } from "../services/grounding-direct-mutations.js";
import { GroundingReceiptVerificationError } from "../services/grounding-receipt.js";

/** Server-owned, explicit selection. No environment, project flag, metadata or other-task inference. */
export type GroundingCreationPolicy = readonly { projectId: string; subjectMode: "TASK_SPEC" | "CODE_HEAD" }[];
const policySchema = z.array(z.object({ projectId: z.string().uuid(), subjectMode: z.enum(["TASK_SPEC", "CODE_HEAD"]) }).strict());
export function createGroundingCreationRouter(db: PrismaClient, attempts?: GroundingAttemptsService, policy: GroundingCreationPolicy = []) {
  const router = new Hono<{ Variables: AppVariables }>();
  for (const batch of [false, true]) router.post(`/projects/:projectId/tasks${batch ? "/import" : ""}`, async (c, next) => {
    try {
      const selected = policySchema.parse(policy).filter(entry => entry.projectId === c.req.param("projectId"));
      if (!selected.length) return next();
      if (selected.length !== 1 || !attempts) unavailable();
      const selection = selected[0]!;
      const actor = c.get("actor");
      if (!actor) return c.json({ error: "unauthorized" }, 401);
      if ((actor.type === "agent" && !actor.scopes.includes("tasks:create")) || !await groundingAuthority.canWrite(actor, selection.projectId, db)) throw new GroundingAccessError("forbidden", 403);
      const raw: unknown = await c.req.json().catch(() => null);
      const items = batch ? z.object({ tasks: z.array(importTaskSchema).min(1).max(200) }).parse(raw).tasks : [createTaskSchema.parse(raw)];
      if (actor.type === "agent" && items.some(item => item.status !== undefined && item.status !== "backlog")) return c.json({ error: "backlog_routing_enforced", message: "Agent-created tasks must enter backlog." }, 400);
      const create = async (body: z.infer<typeof createTaskSchema>) => {
        const committed = await groundingTransaction(db, async tx => {
        await lockGroundingProjects(tx, [selection.projectId]);
        if (!await groundingAuthority.canWrite(actor, selection.projectId, tx)) throw new GroundingAccessError("forbidden", 403);
        const project = await tx.project.findUniqueOrThrow({ where: { id: selection.projectId } });
        // A transaction-local provisional row supplies the exact same workflow resolver as completion.
        // Rejection rolls it back, including dependencies and the externalRef key.
        if (body.workflowId && !await tx.workflow.findFirst({ where: { id: body.workflowId, projectId: project.id } })) throw new GroundingAccessError("bad_state", 409);
        if (body.dependsOn?.length && await tx.task.count({ where: { id: { in: [...new Set(body.dependsOn)] }, projectId: project.id } }) !== new Set(body.dependsOn).size) throw new GroundingAccessError("bad_state", 409);
        if (body.externalRef && await tx.task.findUnique({ where: { projectId_externalRef: { projectId: project.id, externalRef: body.externalRef } } })) return null;
        const task = await tx.task.create({ data: {
          projectId: project.id, title: body.title, description: body.description, status: actor.type === "agent" ? "backlog" : body.status ?? "open", priority: body.priority,
          workflowId: body.workflowId, dueAt: body.dueAt ? new Date(body.dueAt) : null, templateData: body.templateData, externalRef: body.externalRef, labels: body.labels, deliverableRepo: body.deliverableRepo,
          ...(body.debugFlavor !== undefined ? { metadata: { debugFlavor: body.debugFlavor } } : {}),
          ...(body.dependsOn?.length ? { blockedBy: { connect: [...new Set(body.dependsOn)].map(id => ({ id })) } } : {}),
          createdByUserId: actor.type === "human" ? actor.userId : null, createdByAgentId: actor.type === "agent" ? actor.tokenId : null,
        }, include: { project: true } });
        const { def } = await groundingWorkflow(tx, task);
        if (isReviewState(def, task.status) || isTerminalState(def, task.status)) throw new GroundingReceiptVerificationError("grounding_required");
        if (task.status !== "backlog" && !def.states.some(state => state.name === task.status)) throw new GroundingAccessError("bad_state", 409);
        await attempts.provisionInTransaction(tx, { taskId: task.id, projectId: project.id, subjectMode: selection.subjectMode });
        await tx.auditLog.create({ data: { projectId: project.id, taskId: task.id, actorId: actor.type === "human" ? actor.userId : null, action: batch ? "task.imported" : "task.created", payload: { externalRef: body.externalRef ?? null, groundingCreationPolicy: "explicit_external_v1", subjectMode: selection.subjectMode, actorType: actor.type } } });
        if (body.deliverableRepo) await tx.auditLog.create({ data: { projectId: project.id, taskId: task.id, actorId: actor.type === "human" ? actor.userId : null, action: "task.deliverable_repo_set", payload: { deliverableRepo: body.deliverableRepo, actorType: actor.type, via: batch ? "batch_import" : "create" } } });
        const signals: Signal[] = [];
        if (task.status === "open") {
          const agents = await tx.agentToken.findMany({ where: { teamId: project.teamId, revokedAt: null, scopes: { has: "tasks:claim" }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true }, orderBy: { id: "asc" } });
          const actorName = actor.type === "agent" ? (await tx.agentToken.findUnique({ where: { id: actor.tokenId }, select: { name: true } }))?.name ?? "Agent" : (await tx.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))?.name ?? "Human";
          const context = { taskTitle: task.title, taskStatus: task.status, projectSlug: project.slug, projectName: project.name, branchName: task.branchName, prUrl: task.prUrl, prNumber: task.prNumber, actor: { type: actor.type, name: actorName } };
          for (const agent of agents) signals.push(await tx.signal.create({ data: { type: "task_available", taskId: task.id, projectId: project.id, recipientAgentId: agent.id, context } }));
          if (agents.length) await tx.auditLog.create({ data: { projectId: project.id, taskId: task.id, action: "task.created", payload: { event: "task_available_signal", recipientCount: agents.length } } });
        }
        return { task: await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: groundingRouteTaskInclude }), confidence: directConfidence(task), signals };
        });
        if (!committed) return null;
        for (const signal of committed.signals) void maybeDeliverSignalWebhook(signal, db).catch(() => {});
        return { task: committed.task, confidence: committed.confidence };
      };
      if (!batch) { const created = await create(items[0]!); return created ? c.json(created, 201) : c.json({ error: "conflict", message: "externalRef already exists" }, 409); }
      const seen = new Set<string>(); const skipped: string[] = []; const created: { index: number; id: string }[] = []; const errors: { index: number; error: string }[] = [];
      for (let index = 0; index < items.length; index++) {
        const body = items[index]!;
        if (body.externalRef && seen.has(body.externalRef)) { skipped.push(body.externalRef); continue; }
        if (body.externalRef) seen.add(body.externalRef);
        try { const row = await create(body); if (row) created.push({ index, id: row.task.id }); else if (body.externalRef) skipped.push(body.externalRef); }
        catch (error) { errors.push({ index, error: error instanceof GroundingReceiptVerificationError && error.code === "grounding_required" ? "grounding_required: create an initial task, then obtain a direct attempt and complete it" : error instanceof GroundingAccessError ? error.code : "grounding_verification_unavailable" }); }
      }
      return c.json({ created: created.length, skipped: skipped.length, failed: errors.length, ids: created, skippedRefs: skipped, errors }, created.length > 0 ? 201 : errors.length > 0 ? 422 : 200);
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: "validation_error", details: error.issues }, 400);
      if (error instanceof GroundingAccessError) return c.json({ error: error.code }, error.status);
      if (error instanceof GroundingReceiptVerificationError && error.code === "grounding_required") return c.json({ error: error.code, message: "Create an initial task first, then obtain a fresh direct attempt and complete it." }, 409);
      return c.json({ error: "grounding_verification_unavailable" }, 503);
    }
  });
  return router;
}
