import { prisma } from "../lib/prisma.js";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppVariables } from "../types/hono.js";
import type { GroundingAfterCommit } from "../services/grounding-completion.js";
import type { GroundingTaskCompletionDependencies } from "./grounding-task-completion.js";
import { GroundingAccessError, groundingAuthority, groundingWorkflow, unavailable } from "../services/grounding-context.js";
import { GroundingReceiptVerificationError } from "../services/grounding-receipt.js";
import { selectGroundingRouteContext } from "../services/grounding-route-context.js";
import { directAdvanceTransport, directPatchSchema, directReviewSchema, directTransitionSchema } from "../services/grounding-direct-input.js";
import { directAgentPatchSchema, directRespecSchema, mutateDirectTask, rejectEnrolledDelete } from "../services/grounding-direct-mutations.js";
import { approveTarget, requestChangesTarget } from "../services/default-workflow.js";
import type { GroundingDirectDescriptor } from "../services/grounding-direct-context.js";
import { GroundingDemoteRefused, resolveDirectGroundingTarget } from "../services/grounding-direct-context.js";
import { demoteSourceStatusMessage } from "../services/task-demote.js";
import type { GroundingRouteTransport, OperationInput } from "../services/grounding-operations.js";
import { clearDisposition } from "../services/confidence-telemetry.js";
import { advanceConfiguredGatesMessage, advanceGateRefusalMessage, advanceIdempotencyKeySchema, advanceTaskSchema, decideAdvance, GroundingAdvanceRefused } from "../services/task-advance.js";
import { GroundingDecisionError } from "../services/grounding-transaction.js";
import { hasProjectAccess } from "../services/team-access.js";
import { forbidden, notFound } from "../middleware/error.js";

function routeError(error: unknown, c: Context<{ Variables: AppVariables }>, descriptor?: GroundingDirectDescriptor) {
  if (error instanceof z.ZodError) return c.json({ error: "validation_error", details: error.issues }, 400);
  if (error instanceof GroundingDemoteRefused) return c.json({ error: error.code, message: error.message }, error.status);
  if (error instanceof GroundingAdvanceRefused) return c.json(error.refusal.body, error.refusal.status);
  if (error instanceof GroundingAccessError) return c.json({ error: error.code }, error.status);
  if (error instanceof GroundingReceiptVerificationError) return c.json({ error: error.code, ...(descriptor ? { groundingHint: {
    kind: "external_grounding_v1", attempts: { issue: { url: `/api/tasks/${c.req.param("id")}/grounding-attempts/direct`, body: descriptor }, receipt: { url: `/api/tasks/${c.req.param("id")}/grounding-attempts/:attemptId/receipt` } }, completion: { requiredHeader: "Idempotency-Key" },
  } } : {}) }, error.code === "grounding_verification_unavailable" ? 503 : 409);
  return c.json({ error: "grounding_verification_unavailable" }, 503);
}

/** The REST handlers' refusals of a caller without project access and of a read-only caller (routes/tasks.ts). */
const NO_PROJECT_ACCESS = "Access denied to this project";
const READ_ONLY_ACCESS = "Requires write access (PROJECT_VIEWER is read-only)";

/**
 * The Idempotency-Key header as the REST /advance handler reads it: an absent
 * header is no key, and any present value, the empty string included, must
 * match advanceIdempotencyKeySchema or the request is refused with that
 * handler's 400 before anything is written.
 */
function idempotencyKey(c: Context<{ Variables: AppVariables }>): { key: string | null } | { refusal: Response } {
  const header = c.req.header("Idempotency-Key");
  if (header === undefined) return { key: null };
  const parsed = advanceIdempotencyKeySchema.safeParse(header);
  return parsed.success ? { key: parsed.data } : { refusal: c.json({ error: "validation_error", message: "Invalid Idempotency-Key header" }, 400) };
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
        // The REST handler's agent refusal for this endpoint: DELETE refuses
        // every agent, the others name the scope they require. Every REST
        // handler but PATCH answers it before the task lookup; PATCH answers
        // it after the access check.
        const scope = endpoint === "respec" || endpoint === "patch" ? "tasks:update" : "tasks:transition";
        const scopeRefusal = actor.type !== "agent" ? null : endpoint === "delete" ? "Agents cannot delete tasks" : actor.scopes.includes(scope) ? null : `Missing scope: ${scope}`;
        const scopeFirst = endpoint === "patch" ? null : scopeRefusal;
        const taskId = c.req.param("id")!;
        const task = await deps.db.task.findUnique({ where: { id: taskId }, include: { project: true } });
        // A missing task and a caller without write access are refused here,
        // before the enrollment is read, in the REST handler's order and
        // wording, so the answer is the same for every task. An unprovisioned
        // task the caller can write reaches the REST handler, which answers
        // its scope and body refusals itself; a provisioned one gets the same
        // scope refusal after the mode selection below.
        if (!task) return scopeFirst ? forbidden(c, scopeFirst) : notFound(c);
        if (!await groundingAuthority.canWrite(actor, task.projectId, deps.db)) {
          // DELETE checks write access alone, so a non-member reads the viewer's refusal there.
          return forbidden(c, scopeFirst ?? (endpoint !== "delete" && !await hasProjectAccess(actor, task.projectId, deps.db) ? NO_PROJECT_ACCESS : READ_ONLY_ACCESS));
        }
        const mode = await selectGroundingRouteContext(deps.db, { taskId, projectId: task.projectId });
        if (mode.mode === "UNPROVISIONED") return next();
        if (scopeRefusal) return forbidden(c, scopeRefusal);
        if (endpoint === "delete") { await rejectEnrolledDelete(deps.db, taskId, actor); return next(); }
        const raw: unknown = await c.req.json().catch(() => null);
        if (endpoint === "respec") return c.json(await mutateDirectTask(deps.db, task, actor, "respec", directRespecSchema.parse(raw)));
        const body = (endpoint === "patch" ? actor.type === "agent" ? directAgentPatchSchema : directPatchSchema : endpoint === "review" ? directReviewSchema : directTransitionSchema).parse(raw);
        const transport: GroundingRouteTransport = { endpoint, body };
        // A status PATCH that restores an abandoned task is handed to the REST
        // handler below (the no-op and backlog cases answer before it), and
        // REST reads no key, so an empty or invalid key is ignored there as on
        // REST. A valid key still looks up this route's own history first.
        const patchStatus = endpoint === "patch" ? (body as { status?: string }).status : undefined;
        const restoresAbandoned = task.status === "abandoned" && patchStatus !== undefined && patchStatus !== task.status && patchStatus !== "backlog";
        const header = idempotencyKey(c);
        if ("refusal" in header) return restoresAbandoned ? next() : header.refusal;
        const { key } = header;
        if (key && deps.service) {
          const history = await deps.service.lookupRouteOperation(taskId, actor, key, transport);
          if (history) {
            if (history.state !== "COMPLETED") throw new GroundingAccessError("grounding_finalization_pending", 409);
            return c.json(z.object({ route: z.record(z.string(), z.unknown()) }).parse(history.result).route);
          }
        }
        // No-op status and result/commentary writes do not create a completion attempt.
        if (endpoint === "patch" && (!("status" in body) || body.status === undefined || body.status === task.status)) return c.json(await mutateDirectTask(deps.db, task, actor, "patch", body));
        // Backlog is reachable only from open (the REST demote guard): any other source answers 400 with the REST text.
        if (endpoint === "patch" && (body as { status?: string }).status === "backlog" && task.status !== "open") return c.json({ error: "bad_request", message: demoteSourceStatusMessage(task.status) }, 400);
        // The C04 recovery adapter already joins the atomic mutation protocol.
        // Hand-off keeps the telemetry hook in the REST handler: it clears
        // finalDisposition post-commit when an admin restores the task. The
        // decision above rests on a read taken before the task lock, so a task
        // that turns abandoned in between is reopened by the service below;
        // the observer passed to dispose() covers that race.
        if (restoresAbandoned) return next();
        if (!deps.service) unavailable();
        // A backlog discard (backlog -> abandoned) lands in dispose() below and
        // writes no finalDisposition, like the REST discard: a backlog task has
        // no scored claim (a task only reaches backlog at creation and is never
        // claimed there). No other direct edge reaches abandoned.
        const { def } = await groundingWorkflow(deps.db, task);
        const to = endpoint === "review" ? ("action" in body && body.action === "approve" ? approveTarget(def, task.status) : requestChangesTarget(def, task.status)) : (body as { status: string }).status;
        if (!to) throw new GroundingAccessError("bad_state", 409);
        descriptor = { version: 1, endpoint, target: to };
        const forced = "force" in body && body.force === true;
        const resolved = await resolveDirectGroundingTarget(deps.db, task, actor, descriptor, undefined, forced);
        if (resolved.success && !key) return c.json({ error: "grounding_operation_key_required", message: "Supply Idempotency-Key for this logical completion." }, 400);
        const input: OperationInput = { action: resolved.action, route: { kind: "direct", transport, direct: descriptor }, ...(forced ? { overrideReason: (body as { forceReason?: string }).forceReason ?? "" } : {}) };
        // Runs once, after the committing invocation, and the service swallows its errors.
        const reopenedFromAbandoned: GroundingAfterCommit = async committed => {
          const operationId = z.object({ operationId: z.string() }).parse(committed).operationId;
          const operation = await deps.db.groundingOperation.findUnique({ where: { id: operationId } });
          const decision = z.object({ from: z.string(), to: z.string() }).parse(operation?.decision);
          if (decision.from === "abandoned" && decision.to !== "abandoned") await clearDisposition(taskId);
        };
        const result = resolved.success ? await deps.service.complete(taskId, actor, key!, input) : await deps.service.dispose(taskId, actor, key ?? randomUUID(), input, reopenedFromAbandoned);
        return c.json(z.object({ route: z.record(z.string(), z.unknown()) }).parse(result).route);
      } catch (error) { return routeError(error, c, descriptor); }
    });
  }
  // task_advance on a provisioned task: the REST handler's checks and refusals
  // (services/task-advance.ts) on the transition transport, with an `advance`
  // marker that keys its replay apart from a /transition (directAdvanceTransport).
  // An advance target is never review-like or terminal, so it is always a
  // disposition and never needs a receipt.
  router.post("/tasks/:id/advance", async (c, next) => {
    // Set once the edge is chosen: the fallback for a 409 precondition_failed
    // that carries no gate detail; one that does is worded from that detail.
    let gateRefusal: string | undefined;
    try {
      const actor = c.get("actor");
      if (!actor) return c.json({ error: "unauthorized" }, 401);
      // Scope, existence and access answer in the REST handler's order and
      // wording, so these refusals read the same for every task, provisioned
      // or not, although they are answered before next().
      if (actor.type === "agent" && !actor.scopes.includes("tasks:transition")) return c.json({ error: "forbidden", message: "Missing scope: tasks:transition" }, 403);
      const taskId = c.req.param("id")!;
      const task = await deps.db.task.findUnique({ where: { id: taskId }, include: { project: true } });
      if (!task) return notFound(c);
      if (!await groundingAuthority.canWrite(actor, task.projectId, deps.db)) {
        return forbidden(c, await hasProjectAccess(actor, task.projectId, deps.db) ? READ_ONLY_ACCESS : NO_PROJECT_ACCESS);
      }
      const mode = await selectGroundingRouteContext(deps.db, { taskId, projectId: task.projectId });
      if (mode.mode === "UNPROVISIONED") return next();
      const parsed = advanceTaskSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: "bad_request", message: parsed.error.message }, 400);
      const requested = parsed.data.to ?? null;
      const header = idempotencyKey(c);
      if ("refusal" in header) return header.refusal;
      const { key } = header;
      if (key && deps.service) {
        const history = await deps.service.lookupRouteOperation(taskId, actor, key, directAdvanceTransport(requested));
        if (history) {
          if (history.state !== "COMPLETED") throw new GroundingAccessError("grounding_finalization_pending", 409);
          return c.json(z.object({ route: z.record(z.string(), z.unknown()) }).parse(history.result).route);
        }
      }
      if (!deps.service) unavailable();
      const { def } = await groundingWorkflow(deps.db, task);
      const decision = decideAdvance(def, task, actor, requested ?? undefined);
      if (!decision.ok) return c.json(decision.body, decision.status);
      gateRefusal = advanceConfiguredGatesMessage(def, task.status, decision.to);
      const direct: GroundingDirectDescriptor = { version: 1, endpoint: "transition", target: decision.to };
      const input: OperationInput = { action: "transition", route: { kind: "direct", transport: directAdvanceTransport(requested, decision.to), direct } };
      const result = await deps.service.dispose(taskId, actor, key ?? randomUUID(), input);
      return c.json(z.object({ route: z.record(z.string(), z.unknown()) }).parse(result).route);
    } catch (error) {
      if (gateRefusal !== undefined && error instanceof GroundingDecisionError && error.code === "precondition_failed") return c.json({ error: "precondition_failed", message: error.gate ? advanceGateRefusalMessage(error.gate) : gateRefusal }, 409);
      return routeError(error, c);
    }
  });
  return router;
}
