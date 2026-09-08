import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { AppVariables } from "../types/hono.js";
import type { Actor } from "../types/auth.js";
import { GroundingFinalizationService } from "../services/grounding-finalization.js";
import { GroundingAccessError, groundingAuthority, groundingWorkflow, unavailable } from "../services/grounding-context.js";
import { GroundingReceiptVerificationError } from "../services/grounding-receipt.js";
import { recordBounceBack, recordTerminalSnapshot } from "../services/confidence-telemetry.js";
import { isReviewState } from "../services/default-workflow.js";
import { buildExternalGroundingHint, selectGroundingRouteContext } from "../services/grounding-route-context.js";
import { SCOPES } from "../services/scopes.js";
import type { GroundingRouteTransport, OperationInput } from "../services/grounding-operations.js";

export interface GroundingTaskCompletionDependencies {
  db: PrismaClient;
  service?: GroundingFinalizationService;
}
const methodSchema = z.enum(["squash", "merge", "rebase"]).default("squash");
const finishSchema = z.object({
  result: z.string().max(5000).optional(),
  outcome: z.enum(["approve", "request_changes"]).optional(),
  prUrl: z.string().max(32768).regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/).optional(),
  prNumber: z.number().int().positive().optional(),
  autoMerge: z.boolean().default(false),
  mergeMethod: methodSchema,
}).strict().refine(body => !(body.outcome === "request_changes" && body.autoMerge), "autoMerge is not allowed with request_changes");
const mergeSchema = z.object({ mergeMethod: methodSchema }).strict();
const abandonSchema = z.object({}).strict();
const keySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

function errorResponse(error: unknown, c: Context<{ Variables: AppVariables }>, taskId: string, intent: "finish" | "approve" | "merge") {
  if (error instanceof GroundingAccessError) return c.json({ error: error.code }, error.status);
  if (error instanceof GroundingReceiptVerificationError) {
    const status = error.code === "grounding_verification_unavailable" ? 503
      : error.code === "grounding_receipt_invalid" ? 400
        : ["grounding_receipt_unsupported", "grounding_receipt_untrusted"].includes(error.code) ? 422 : 409;
    return c.json({ error: error.code, groundingHint: buildExternalGroundingHint(taskId, intent), ...(error.code === "grounding_receipt_mismatch" ? { message: "Bind the authoritative task PR before requesting an assessment, then issue a fresh attempt." } : {}) }, status);
  }
  return c.json({ error: "grounding_verification_unavailable" }, 503);
}
function routeResponse(c: Context<{ Variables: AppVariables }>, result: unknown) {
  const parsed = z.object({ route: z.record(z.unknown()) }).safeParse(result);
  if (parsed.success) return c.json(parsed.data.route);
  const pending = z.object({ pending: z.literal(true) }).safeParse(result);
  if (pending.success) return c.json(result as Prisma.JsonObject, 202);
  const cancelled = z.object({ state: z.literal("CANCELLED") }).safeParse(result);
  if (cancelled.success) return c.json(result as Prisma.JsonObject, 409);
  return c.json({ error: "grounding_verification_unavailable" }, 503);
}

/** Installed best-effort observer; only the service's newly committed invocation calls it. */
async function calibrate(result: unknown) {
  const parsed = z.object({ action: z.string(), route: z.object({ kind: z.string().optional(), task: z.object({ id: z.string(), projectId: z.string(), status: z.string(), templateData: z.unknown() }) }) }).safeParse(result);
  if (!parsed.success || parsed.data.route.kind !== "review") return;
  const { action, route: { task } } = parsed.data;
  if (action === "request_changes") await recordBounceBack(task.id, task.projectId);
  else if (action === "approve") {
    const template = z.object({ taskType: z.string().nullable().optional() }).safeParse(task.templateData);
    await recordTerminalSnapshot({ taskId: task.id, projectId: task.projectId, finalStatus: task.status, taskType: template.success ? template.data.taskType ?? null : null });
  }
}

/** Per-app guard: only an absent authoritative enrollment may enter the compatibility router. */
export function createGroundingTaskCompletionRouter(deps: GroundingTaskCompletionDependencies = { db: prisma }) {
  const router = new Hono<{ Variables: AppVariables }>();
  for (const endpoint of ["finish", "merge", "abandon"] as const) {
    router.post(`/tasks/:id/${endpoint}`, async (c, next) => {
      const taskId = c.req.param("id");
      const actor = c.get("actor") as Actor | undefined;
      if (!actor) return c.json({ error: "unauthorized" }, 401);
      const admissionScope = endpoint === "merge" ? SCOPES.GithubPrMerge : endpoint === "abandon" ? SCOPES.TasksClaim : SCOPES.TasksTransition;
      if (actor.type === "agent" && !actor.scopes.includes(admissionScope)) return c.json({ error: "forbidden" }, 403);
      let intent: "finish" | "approve" | "merge" = endpoint === "merge" ? "merge" : "finish";
      try {
        const task = await deps.db.task.findUnique({ where: { id: taskId }, include: { project: true } });
        if (!task) return c.json({ error: "not_found" }, 404);
        if (!await groundingAuthority.canWrite(actor, task.projectId, deps.db)) throw new GroundingAccessError("forbidden", 403);
        const context = await selectGroundingRouteContext(deps.db, { taskId, projectId: task.projectId });
        // Enrollment is server-only. Activation must quiesce existing legacy requests before enrolling them.
        if (context.mode === "UNPROVISIONED") return next();
        if (!deps.service) unavailable();
        const scope = endpoint === "merge" ? SCOPES.GithubPrMerge : endpoint === "abandon" ? SCOPES.TasksClaim : SCOPES.TasksTransition;
        if (actor.type === "agent" && !actor.scopes.includes(scope)) throw new GroundingAccessError("forbidden", 403);
        const key = keySchema.safeParse(c.req.header("Idempotency-Key"));
        if (!key.success) return c.json({ error: "grounding_operation_key_required", message: "Supply a unique Idempotency-Key for this logical operation; reuse it only for identical retries." }, 400);
        let raw: unknown;
        try { raw = await c.req.json(); } catch { return c.json({ error: "validation_error", message: "A JSON object body is required." }, 400); }
        const parsed = (endpoint === "finish" ? finishSchema : endpoint === "merge" ? mergeSchema : abandonSchema).safeParse(raw);
        if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
        if (endpoint === "finish" && "outcome" in parsed.data) intent = "approve";
        const transport: GroundingRouteTransport = { endpoint, body: parsed.data };
        // Durable history owns branch identity; current claims and state must not reinterpret a retry.
        const historical = await deps.service.lookupRouteOperation(taskId, actor, key.data, transport);
        if (historical) {
          if (historical.state === "COMPLETED" || historical.state === "CANCELLED") return routeResponse(c, historical.result);
          return routeResponse(c, await deps.service.dispatchMerge(taskId, actor, key.data, calibrate));
        }
        if (endpoint === "abandon") return routeResponse(c, await deps.service.dispose(taskId, actor, key.data, { action: "abandon", route: { kind: "abandon", transport } }));
        if (endpoint === "merge") {
          const body = parsed.data as z.infer<typeof mergeSchema>;
          await deps.service.reserveMerge(taskId, actor, key.data, { action: "merge", method: body.mergeMethod, route: { kind: "task_merge", transport } });
          return routeResponse(c, await deps.service.dispatchMerge(taskId, actor, key.data, calibrate));
        }
        const body = parsed.data as z.infer<typeof finishSchema>;
        const holdsWork = actor.type === "agent" ? task.claimedByAgentId === actor.tokenId : task.claimedByUserId === actor.userId;
        const holdsReview = actor.type === "agent" ? task.reviewClaimedByAgentId === actor.tokenId : task.reviewClaimedByUserId === actor.userId;
        if (!holdsWork && !holdsReview) throw new GroundingAccessError("forbidden", 403);
        const { def } = await groundingWorkflow(deps.db, task);
        const review = holdsReview || isReviewState(def, task.status);
        if ((review && (!body.outcome || body.prUrl !== undefined || body.prNumber !== undefined)) || (!review && body.outcome)) return c.json({ error: "validation_error", message: "Review finish requires outcome; work finish accepts result and the pre-bound PR." }, 400);
        const action = review ? body.outcome! : "finish";
        const request: OperationInput = { action, result: body.result, method: body.mergeMethod, route: { kind: review ? holdsReview ? "review_finish" : "self_approve_finish" : "work_finish", transport } };
        if (action === "request_changes") return routeResponse(c, await deps.service.dispose(taskId, actor, key.data, request, calibrate));
        if (body.autoMerge) {
          await deps.service.reserveMerge(taskId, actor, key.data, { ...request, action });
          return routeResponse(c, await deps.service.dispatchMerge(taskId, actor, key.data, calibrate));
        }
        return routeResponse(c, await deps.service.complete(taskId, actor, key.data, request, calibrate));
      } catch (error) { return errorResponse(error, c, taskId, intent); }
    });
  }
  return router;
}
