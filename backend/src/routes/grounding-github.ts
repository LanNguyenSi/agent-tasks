import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppVariables } from "../types/hono.js";
import type { Actor } from "../types/auth.js";
import { GroundingGithubMergeService } from "../services/grounding-github-merge.js";
import { GroundingAccessError, groundingAuthority, unavailable } from "../services/grounding-context.js";
import { selectGroundingRouteContext } from "../services/grounding-route-context.js";
import { type GroundingTaskCompletionDependencies, groundingCompletionErrorResponse, groundingCompletionRouteResponse } from "./grounding-task-completion.js";

const mergeKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const createKey = z.string().trim().min(1).max(255);
const mergeBody = z.object({ taskId: z.string().uuid(), owner: z.string().min(1).max(255), repo: z.string().min(1).max(255), merge_method: z.enum(["merge", "squash", "rebase"]).default("squash"), idempotencyKey: z.string().optional() }).strict();
const createBody = z.object({ taskId: z.string().uuid(), owner: z.string().min(1).max(255), repo: z.string().min(1).max(255), head: z.string().min(1).max(1024), base: z.string().min(1).max(1024).default("main"), title: z.string().min(1).max(4096), body: z.string().max(65536).optional(), idempotencyKey: z.string().optional() }).strict();
function key(c: Context<{ Variables: AppVariables }>, bodyKey: string | undefined, schema: typeof mergeKey) {
  const header = c.req.header("Idempotency-Key");
  const fromHeader = header === undefined ? undefined : schema.safeParse(header);
  const fromBody = bodyKey === undefined ? undefined : schema.safeParse(bodyKey);
  if (fromHeader?.success === false || fromBody?.success === false || (!fromHeader && !fromBody)) return { error: "grounding_operation_key_required", status: 400 as const };
  if (fromHeader?.success && fromBody?.success && fromHeader.data !== fromBody.data) return { error: "grounding_operation_conflict", status: 409 as const };
  return { value: fromHeader?.data ?? fromBody!.data! };
}
function agent(c: Context<{ Variables: AppVariables }>, scopes: string[]): Actor | null {
  const actor = c.get("actor");
  return actor?.type === "agent" && scopes.every(scope => actor.scopes.includes(scope)) ? actor : null;
}

/** Mounted before the legacy GitHub writer whenever any Grounding capability is configured. */
export function createGroundingGithubRouter(deps: GroundingTaskCompletionDependencies) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.post("/pull-requests", async c => {
    const actor = agent(c, ["tasks:update", "github:pr_create"]);
    if (!actor) return c.json({ error: "forbidden" }, 403);
    let taskId = "";
    try {
      const input = createBody.safeParse(await c.req.json());
      if (!input.success) return c.json({ error: "validation_error" }, 400);
      taskId = input.data.taskId;
      const operationKey = key(c, input.data.idempotencyKey, createKey);
      if ("error" in operationKey) return c.json({ error: operationKey.error }, operationKey.status);
      if (!deps.githubCreate) unavailable();
      const { taskId: _taskId, idempotencyKey: _key, ...request } = input.data;
      const result = await deps.githubCreate.createOrResume(taskId, actor, operationKey.value, request);
      if (result.replayed) c.header("X-Idempotent-Replay", "true");
      return c.json(result.body, result.status);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) return c.json({ error: "validation_error" }, 400);
      return groundingCompletionErrorResponse(error, c, taskId, "finish");
    }
  });
  router.post("/pull-requests/:prNumber/merge", async c => {
    const actor = agent(c, ["tasks:transition", "github:pr_merge"]);
    if (!actor) return c.json({ error: "forbidden" }, 403);
    let taskId = "";
    try {
      const path = c.req.param("prNumber"); const prNumber = Number(path);
      if (!/^[1-9][0-9]*$/.test(path) || !Number.isSafeInteger(prNumber) || prNumber > 2147483647) return c.json({ error: "bad_request" }, 400);
      const parsed = mergeBody.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error" }, 400);
      taskId = parsed.data.taskId;
      const operationKey = key(c, parsed.data.idempotencyKey, mergeKey);
      if ("error" in operationKey) return c.json({ error: operationKey.error }, operationKey.status);
      if (!(deps.service instanceof GroundingGithubMergeService)) unavailable();
      const service = deps.service;
      const transport = { endpoint: "github_merge" as const, body: { ...parsed.data, idempotencyKey: operationKey.value, prNumber } };
      const previous = await service.lookupRouteOperation(taskId, actor, operationKey.value, transport);
      if (!previous) {
        const task = await deps.db.task.findUnique({ where: { id: taskId } });
        if (!task) throw new GroundingAccessError("not_found", 404);
        if (!await groundingAuthority.canWrite(actor, task.projectId, deps.db)) throw new GroundingAccessError("forbidden", 403);
        const context = await selectGroundingRouteContext(deps.db, { taskId, projectId: task.projectId });
        if (context.mode === "UNPROVISIONED") return c.json({ error: "grounding_enrollment_required" }, 409);
        await service.reserveMerge(taskId, actor, operationKey.value, { action: "merge", method: parsed.data.merge_method, route: { kind: "github_merge", transport } });
      }
      if (previous?.state === "COMPLETED" || previous?.state === "CANCELLED") {
        c.header("X-Idempotent-Replay", "true");
        return groundingCompletionRouteResponse(c, previous.result);
      }
      try { return groundingCompletionRouteResponse(c, await service.dispatchMerge(taskId, actor, operationKey.value)); }
      catch (error) {
        if (error instanceof GroundingAccessError && Number(error.status) !== 503) throw error;
        // Only authenticated matching durable history can classify a local failure as pending.
        const current = await service.lookupRouteOperation(taskId, actor, operationKey.value, transport);
        if (current?.state === "DISPATCHED") return c.json({ state: "DISPATCHED", pending: true }, 202);
        throw error;
      }
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) return c.json({ error: "validation_error" }, 400);
      const response = groundingCompletionErrorResponse(error, c, taskId, "merge");
      if (response.status === 503) return c.json({ error: "grounding_verification_unavailable", message: "Retry with the same Idempotency-Key and unchanged request to resolve the durable operation." }, 503);
      return response;
    }
  });
  return router;
}
