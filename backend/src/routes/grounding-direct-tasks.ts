import { prisma } from "../lib/prisma.js";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppVariables } from "../types/hono.js";
import type { GroundingTaskCompletionDependencies } from "./grounding-task-completion.js";
import { GroundingAccessError, groundingAuthority, groundingWorkflow, unavailable } from "../services/grounding-context.js";
import { GroundingReceiptVerificationError } from "../services/grounding-receipt.js";
import { selectGroundingRouteContext } from "../services/grounding-route-context.js";
import { directPatchSchema, directReviewSchema, directTransitionSchema } from "../services/grounding-direct-input.js";
import { directAgentPatchSchema, directRespecSchema, mutateDirectTask, rejectEnrolledDelete } from "../services/grounding-direct-mutations.js";
import { approveTarget, requestChangesTarget } from "../services/default-workflow.js";
import type { GroundingDirectDescriptor } from "../services/grounding-direct-context.js";
import { resolveDirectGroundingTarget } from "../services/grounding-direct-context.js";
import type { GroundingRouteTransport, OperationInput } from "../services/grounding-operations.js";

function routeError(error: unknown, c: Context<{ Variables: AppVariables }>, descriptor?: GroundingDirectDescriptor) {
  if (error instanceof z.ZodError) return c.json({ error: "validation_error", details: error.issues }, 400);
  if (error instanceof GroundingAccessError) return c.json({ error: error.code }, error.status);
  if (error instanceof GroundingReceiptVerificationError) return c.json({ error: error.code, ...(descriptor ? { groundingHint: {
    kind: "external_grounding_v1", attempts: { issue: { url: `/api/tasks/${c.req.param("id")}/grounding-attempts/direct`, body: descriptor }, receipt: { url: `/api/tasks/${c.req.param("id")}/grounding-attempts/:attemptId/receipt` } }, completion: { requiredHeader: "Idempotency-Key" },
  } } : {}) }, error.code === "grounding_verification_unavailable" ? 503 : 409);
  return c.json({ error: "grounding_verification_unavailable" }, 503);
}

/** Only authoritative enrollment selects these adapters; legacy metadata never selects a policy. */
export function createGroundingDirectTaskRouter(deps: GroundingTaskCompletionDependencies = { db: prisma }) {
  const router = new Hono<{ Variables: AppVariables }>();
  for (const endpoint of ["transition", "review", "patch", "respec", "delete"] as const) {
    const path = `/tasks/:id${endpoint === "patch" || endpoint === "delete" ? "" : `/${endpoint}`}`;
    router.on(endpoint === "patch" ? "PATCH" : endpoint === "delete" ? "DELETE" : "POST", path, async (c, next) => {
      let descriptor: GroundingDirectDescriptor | undefined;
      try {
        const actor = c.get("actor");
        if (!actor) return c.json({ error: "unauthorized" }, 401);
        const taskId = c.req.param("id")!;
        const task = await deps.db.task.findUnique({ where: { id: taskId }, include: { project: true } });
        if (!task) throw new GroundingAccessError("not_found", 404);
        if (!await groundingAuthority.canWrite(actor, task.projectId, deps.db)) throw new GroundingAccessError("forbidden", 403);
        const mode = await selectGroundingRouteContext(deps.db, { taskId, projectId: task.projectId });
        if (mode.mode === "UNPROVISIONED") return next();
        if (endpoint === "delete") { await rejectEnrolledDelete(deps.db, taskId, actor); return next(); }
        if (actor.type === "agent" && !actor.scopes.includes(endpoint === "respec" || endpoint === "patch" ? "tasks:update" : "tasks:transition")) throw new GroundingAccessError("forbidden", 403);
        const raw: unknown = await c.req.json().catch(() => null);
        if (endpoint === "respec") return c.json(await mutateDirectTask(deps.db, task, actor, "respec", directRespecSchema.parse(raw)));
        const body = (endpoint === "patch" ? actor.type === "agent" ? directAgentPatchSchema : directPatchSchema : endpoint === "review" ? directReviewSchema : directTransitionSchema).parse(raw);
        const transport: GroundingRouteTransport = { endpoint, body };
        const keyHeader = c.req.header("Idempotency-Key");
        const key = keyHeader ? z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).parse(keyHeader) : null;
        if (key && deps.service) {
          const history = await deps.service.lookupRouteOperation(taskId, actor, key, transport);
          if (history) {
            if (history.state !== "COMPLETED") throw new GroundingAccessError("grounding_finalization_pending", 409);
            return c.json(z.object({ route: z.record(z.unknown()) }).parse(history.result).route);
          }
        }
        // No-op status and result/commentary writes do not create a completion attempt.
        if (endpoint === "patch" && (!("status" in body) || body.status === undefined || body.status === task.status)) return c.json(await mutateDirectTask(deps.db, task, actor, "patch", body));
        // The C04 recovery adapter already joins the atomic mutation protocol.
        if (endpoint === "patch" && task.status === "abandoned") return next();
        if (!deps.service) unavailable();
        const { def } = await groundingWorkflow(deps.db, task);
        const to = endpoint === "review" ? ("action" in body && body.action === "approve" ? approveTarget(def, task.status) : requestChangesTarget(def, task.status)) : (body as { status: string }).status;
        if (!to) throw new GroundingAccessError("bad_state", 409);
        descriptor = { version: 1, endpoint, target: to };
        const forced = "force" in body && body.force === true;
        const resolved = await resolveDirectGroundingTarget(deps.db, task, actor, descriptor, undefined, forced);
        if (resolved.success && !key) return c.json({ error: "grounding_operation_key_required", message: "Supply Idempotency-Key for this logical completion." }, 400);
        const input: OperationInput = { action: resolved.action, route: { kind: "direct", transport, direct: descriptor }, ...(forced ? { overrideReason: (body as { forceReason?: string }).forceReason ?? "" } : {}) };
        const result = resolved.success ? await deps.service.complete(taskId, actor, key!, input) : await deps.service.dispose(taskId, actor, key ?? randomUUID(), input);
        return c.json(z.object({ route: z.record(z.unknown()) }).parse(result).route);
      } catch (error) { return routeError(error, c, descriptor); }
    });
  }
  return router;
}
