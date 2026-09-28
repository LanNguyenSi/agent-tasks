import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppVariables } from "../types/hono.js";
import type { Actor } from "../types/auth.js";
import { GroundingGithubMergeService } from "../services/grounding-github-merge.js";
import { GroundingAccessError, groundingAuthority, unavailable } from "../services/grounding-context.js";
import { selectGroundingRouteContext } from "../services/grounding-route-context.js";
import { canonicalGithubRepo } from "../services/grounding-github-fence.js";
import { isEnforcedRemoteOperation } from "../services/grounding-scope.js";
import { assertGroundingScopeWired, type GroundingTaskCompletionDependencies, groundingCompletionErrorResponse, groundingCompletionRouteResponse } from "./grounding-task-completion.js";

const mergeKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const createKey = z.string().trim().min(1).max(255);
const mergeBody = z.object({ taskId: z.string().uuid(), owner: z.string().min(1).max(255), repo: z.string().min(1).max(255), merge_method: z.enum(["merge", "squash", "rebase"]).default("squash"), idempotencyKey: z.string().optional() }).strict();
const createBody = z.object({ taskId: z.string().uuid(), owner: z.string().min(1).max(255), repo: z.string().min(1).max(255), head: z.string().min(1).max(1024), base: z.string().min(1).max(1024).default("main"), title: z.string().min(1).max(4096), body: z.string().max(65536).optional(), idempotencyKey: z.string().optional() }).strict();
type KeyResult = { value: string } | { missing: true } | { error: string; status: 400 | 409 };
/** Absence of both header and body key is not itself an error: whether a key is
 * required at all depends on enrollment/scope, resolved by the caller. */
function key(c: Context<{ Variables: AppVariables }>, bodyKey: string | undefined, schema: typeof mergeKey): KeyResult {
  const header = c.req.header("Idempotency-Key");
  const fromHeader = header === undefined ? undefined : schema.safeParse(header);
  const fromBody = bodyKey === undefined ? undefined : schema.safeParse(bodyKey);
  if (fromHeader === undefined && fromBody === undefined) return { missing: true };
  if (fromHeader?.success === false || fromBody?.success === false) return { error: "grounding_operation_key_required", status: 400 };
  if (fromHeader?.success && fromBody?.success && fromHeader.data !== fromBody.data) return { error: "grounding_operation_conflict", status: 409 };
  return { value: fromHeader?.data ?? fromBody!.data! };
}
function agent(c: Context<{ Variables: AppVariables }>, scopes: string[]): Actor | null {
  const actor = c.get("actor");
  return actor?.type === "agent" && scopes.every(scope => actor.scopes.includes(scope)) ? actor : null;
}
/** Best-effort canonicalization for a request-supplied owner/repo pair; an
 * invalid pair adds no candidate, and the task's own repositories still do. */
function explicitRepo(owner: string, repo: string): string | null {
  try { return canonicalGithubRepo(`${owner}/${repo}`); } catch { return null; }
}

/**
 * Replace the request body the next handler reads with one carrying `key` as
 * its idempotencyKey. Hono caches the body text as a promise (its declared
 * type says string); json() re-parses that cached text on every call.
 */
function forwardBodyKey(c: Context<{ Variables: AppVariables }>, raw: unknown, key: string) {
  const text = JSON.stringify({ ...raw as Record<string, unknown>, idempotencyKey: key });
  c.req.bodyCache = { text: Promise.resolve(text) as unknown as string };
}

/** Mounted before the legacy GitHub writer whenever any Grounding capability is configured. */
export function createGroundingGithubRouter(deps: GroundingTaskCompletionDependencies) {
  assertGroundingScopeWired(deps);
  const router = new Hono<{ Variables: AppVariables }>();
  router.post("/pull-requests", async (c, next) => {
    const actor = agent(c, ["tasks:update", "github:pr_create"]);
    if (!actor) return c.json({ error: "forbidden" }, 403);
    let taskId = "";
    try {
      const raw: unknown = await c.req.json();
      const input = createBody.safeParse(raw);
      if (!input.success) return c.json({ error: "validation_error" }, 400);
      taskId = input.data.taskId;
      const operationKey = key(c, input.data.idempotencyKey, createKey);
      if ("error" in operationKey) return c.json({ error: operationKey.error }, operationKey.status);
      const keyValue = "value" in operationKey ? operationKey.value : undefined;
      // Durable create history for this key, or any unfinished create on the
      // task, stays with the grouped create service that owns it.
      const history = await deps.db.groundingGithubCreateOperation.findFirst({
        where: { taskId, OR: [...(keyValue === undefined ? [] : [{ key: keyValue }]), { state: { in: ["RESERVED", "DISPATCHED"] } }] },
        select: { id: true },
      });
      if (!history) {
        const task = await deps.db.task.findUnique({ where: { id: taskId }, include: { project: true } });
        if (!task) throw new GroundingAccessError("not_found", 404);
        if (!await groundingAuthority.canWrite(actor, task.projectId, deps.db)) throw new GroundingAccessError("forbidden", 403);
        const context = await selectGroundingRouteContext(deps.db, { taskId, projectId: task.projectId });
        if (context.mode === "UNPROVISIONED") {
          const guarded = await isEnforcedRemoteOperation(deps.db, deps.scope, task, { repos: [explicitRepo(input.data.owner, input.data.repo)] });
          // Outside the enforced scope PR creation is the legacy creator's,
          // keyed or not. The legacy creator reads its key only from the
          // body, so a header key is forwarded there.
          if (!guarded) {
            if (keyValue !== undefined) forwardBodyKey(c, raw, keyValue);
            return next();
          }
        }
      }
      if (keyValue === undefined) return c.json({ error: "grounding_operation_key_required", message: "Supply a unique Idempotency-Key for this logical operation; reuse it only for identical retries." }, 400);
      if (!deps.githubCreate) unavailable();
      const { taskId: _taskId, idempotencyKey: _key, ...request } = input.data;
      const result = await deps.githubCreate.createOrResume(taskId, actor, keyValue, request);
      if (result.replayed) c.header("X-Idempotent-Replay", "true");
      return c.json(result.body, result.status);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) return c.json({ error: "validation_error" }, 400);
      return groundingCompletionErrorResponse(error, c, taskId, "finish");
    }
  });
  router.post("/pull-requests/:prNumber/merge", async (c, next) => {
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
      const keyValue = "value" in operationKey ? operationKey.value : undefined;
      if (!(deps.service instanceof GroundingGithubMergeService)) unavailable();
      const service = deps.service;
      const buildTransport = (idempotencyKey: string) => ({ endpoint: "github_merge" as const, body: { ...parsed.data, idempotencyKey, prNumber } });
      const previous = keyValue ? await service.lookupRouteOperation(taskId, actor, keyValue, buildTransport(keyValue)) : null;
      if (!previous) {
        const task = await deps.db.task.findUnique({ where: { id: taskId }, include: { project: true } });
        if (!task) throw new GroundingAccessError("not_found", 404);
        if (!await groundingAuthority.canWrite(actor, task.projectId, deps.db)) throw new GroundingAccessError("forbidden", 403);
        const context = await selectGroundingRouteContext(deps.db, { taskId, projectId: task.projectId });
        if (context.mode === "UNPROVISIONED") {
          // The legacy handler merges the project's repository and the task's
          // PR number (the path number only when the task has none), ignoring
          // the body owner/repo, so every one of those is a candidate target.
          const guarded = await isEnforcedRemoteOperation(deps.db, deps.scope, task, { repos: [explicitRepo(parsed.data.owner, parsed.data.repo)], prNumbers: [prNumber] });
          if (guarded) return c.json({ error: "grounding_enrollment_required" }, 409);
          return next();
        }
        if (!keyValue) return c.json({ error: "grounding_operation_key_required", message: "Supply a unique Idempotency-Key for this logical operation; reuse it only for identical retries." }, 400);
        await service.reserveMerge(taskId, actor, keyValue, { action: "merge", method: parsed.data.merge_method, route: { kind: "github_merge", transport: buildTransport(keyValue) } });
      }
      const activeKey = keyValue!;
      if (previous?.state === "COMPLETED" || previous?.state === "CANCELLED") {
        c.header("X-Idempotent-Replay", "true");
        return groundingCompletionRouteResponse(c, previous.result);
      }
      try { return groundingCompletionRouteResponse(c, await service.dispatchMerge(taskId, actor, activeKey)); }
      catch (error) {
        if (error instanceof GroundingAccessError && Number(error.status) !== 503) throw error;
        // Only authenticated matching durable history can classify a local failure as pending.
        const current = await service.lookupRouteOperation(taskId, actor, activeKey, buildTransport(activeKey));
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
