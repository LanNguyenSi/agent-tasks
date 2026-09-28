import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppVariables } from "../types/hono.js";
import type { Actor } from "../types/auth.js";
import { GroundingGithubMergeService } from "../services/grounding-github-merge.js";
import { GroundingAccessError, groundingAuthority, unavailable } from "../services/grounding-context.js";
import { selectGroundingRouteContext } from "../services/grounding-route-context.js";
import { candidateRepositoryFenceOwned, isEnforcedRemoteOperation, type GroundingRemoteTargets, type GroundingScopeTask } from "../services/grounding-scope.js";
import { assertGroundingScopeWired, type GroundingTaskCompletionDependencies, groundingCompletionErrorResponse, groundingCompletionRouteResponse } from "./grounding-task-completion.js";

const mergeKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const createKey = z.string().trim().min(1).max(255);
const mergeBody = z.object({ taskId: z.string().uuid(), owner: z.string().min(1).max(255), repo: z.string().min(1).max(255), merge_method: z.enum(["merge", "squash", "rebase"]).default("squash"), idempotencyKey: z.string().optional() }).strict();
const createBody = z.object({ taskId: z.string().uuid(), owner: z.string().min(1).max(255), repo: z.string().min(1).max(255), head: z.string().min(1).max(1024), base: z.string().min(1).max(1024).default("main"), title: z.string().min(1).max(4096), body: z.string().max(65536).optional(), idempotencyKey: z.string().optional() }).strict();
const legacyTaskId = z.string().uuid();
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

/**
 * The only request fields the routing decision reads, taken without any
 * validation beyond what the legacy handler's own schema requires of them:
 * a UUID taskId, and owner/repo when both are non-empty strings, joined the
 * way the legacy creator joins them for its GitHub URL. Null when the body
 * names no task the legacy handler could act on; the legacy handler then
 * rejects the request itself.
 */
function legacyRouting(raw: unknown) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (!legacyTaskId.safeParse(body.taskId).success) return null;
  const named = typeof body.owner === "string" && body.owner.length > 0 && typeof body.repo === "string" && body.repo.length > 0;
  return { taskId: body.taskId as string, repo: named ? `${body.owner as string}/${body.repo as string}` : null, bodyKey: body.idempotencyKey };
}
/** Every well-formed key the request carries, header or body, for the
 * durable-history lookup only; format errors are reported on the Grounding
 * path, never before a legacy hand-off. */
function historyKeys(c: Context<{ Variables: AppVariables }>, bodyKey: unknown, schema: typeof mergeKey) {
  const keys = new Set<string>();
  for (const value of [c.req.header("Idempotency-Key"), bodyKey]) {
    const parsed = schema.safeParse(value);
    if (parsed.success) keys.add(parsed.data);
  }
  return [...keys];
}
async function readJson(c: Context<{ Variables: AppVariables }>): Promise<unknown> {
  try { return await c.req.json(); } catch { return undefined; }
}
type LegacyDecision = "legacy" | "grounding_enrollment_required" | "grounding_finalization_pending";
/** Where an UNPROVISIONED task's fresh remote operation goes: the legacy
 * handler, or a 409 when it is enforced or when a candidate repository's fence
 * is owned by another operation (the legacy effect could not be recorded). */
async function legacyDecision(deps: GroundingTaskCompletionDependencies, task: GroundingScopeTask, targets: GroundingRemoteTargets): Promise<LegacyDecision> {
  if (await isEnforcedRemoteOperation(deps.db, deps.scope, task, targets)) return "grounding_enrollment_required";
  if (await candidateRepositoryFenceOwned(deps.db, task, targets)) return "grounding_finalization_pending";
  return "legacy";
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
      const raw = await readJson(c);
      const routing = legacyRouting(raw);
      // A request naming no task is the legacy creator's to reject.
      if (!routing) return next();
      taskId = routing.taskId;
      // Durable create history for a supplied key, or any unfinished create
      // on the task, stays with the grouped create service that owns it.
      const keys = historyKeys(c, routing.bodyKey, createKey);
      const history = await deps.db.groundingGithubCreateOperation.findFirst({
        where: { taskId, OR: [...keys.map(value => ({ key: value })), { state: { in: ["RESERVED", "DISPATCHED"] } }] },
        select: { id: true },
      });
      if (!history) {
        const task = await deps.db.task.findUnique({ where: { id: taskId }, include: { project: true } });
        if (!task) return next();
        const context = await selectGroundingRouteContext(deps.db, { taskId, projectId: task.projectId });
        // Outside the enforced scope PR creation is the legacy creator's,
        // keyed or not, and it receives the request exactly as sent.
        const decision = context.mode === "UNPROVISIONED" ? await legacyDecision(deps, task, { repos: [routing.repo] }) : null;
        if (decision === "legacy") return next();
        if (!await groundingAuthority.canWrite(actor, task.projectId, deps.db)) throw new GroundingAccessError("forbidden", 403);
        if (decision === "grounding_finalization_pending") return c.json({ error: decision }, 409);
      }
      // Grounding-owned from here: the strict request contract applies.
      const input = createBody.safeParse(raw);
      if (!input.success) return c.json({ error: "validation_error" }, 400);
      const operationKey = key(c, input.data.idempotencyKey, createKey);
      if ("error" in operationKey) return c.json({ error: operationKey.error }, operationKey.status);
      if (!("value" in operationKey)) return c.json({ error: "grounding_operation_key_required", message: "Supply a unique Idempotency-Key for this logical operation; reuse it only for identical retries." }, 400);
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
  router.post("/pull-requests/:prNumber/merge", async (c, next) => {
    const actor = agent(c, ["tasks:transition", "github:pr_merge"]);
    if (!actor) return c.json({ error: "forbidden" }, 403);
    let taskId = "";
    try {
      if (!(deps.service instanceof GroundingGithubMergeService)) unavailable();
      const service = deps.service;
      const path = c.req.param("prNumber");
      const raw = await readJson(c);
      const routing = legacyRouting(raw);
      // A request naming no task is the legacy merger's to reject.
      if (!routing) return next();
      taskId = routing.taskId;
      const keys = historyKeys(c, routing.bodyKey, mergeKey);
      const history = keys.length > 0 && (
        await deps.db.groundingOperation.findFirst({ where: { taskId, key: { in: keys } }, select: { id: true } })
        ?? await deps.db.groundingGithubMergeGroup.findFirst({ where: { seedTaskId: taskId, key: { in: keys } }, select: { id: true } })
      );
      if (!history) {
        const task = await deps.db.task.findUnique({ where: { id: taskId }, include: { project: true } });
        if (!task) return next();
        const context = await selectGroundingRouteContext(deps.db, { taskId, projectId: task.projectId });
        if (context.mode === "UNPROVISIONED") {
          // The legacy handler merges the project's repository and the task's
          // PR number (the path number, parsed with parseInt, only when the
          // task has none), ignoring the body owner/repo, so every one of
          // those is a candidate target.
          const legacyNumber = Number.parseInt(path, 10);
          const decision = await legacyDecision(deps, task, { repos: [routing.repo], prNumbers: [Number.isNaN(legacyNumber) ? null : legacyNumber] });
          if (decision === "legacy") return next();
          if (!await groundingAuthority.canWrite(actor, task.projectId, deps.db)) throw new GroundingAccessError("forbidden", 403);
          return c.json({ error: decision }, 409);
        }
      }
      // Grounding-owned from here: the strict request contract applies.
      const prNumber = Number(path);
      if (!/^[1-9][0-9]*$/.test(path) || !Number.isSafeInteger(prNumber) || prNumber > 2147483647) return c.json({ error: "bad_request" }, 400);
      const parsed = mergeBody.safeParse(raw);
      if (!parsed.success) return c.json({ error: "validation_error" }, 400);
      const operationKey = key(c, parsed.data.idempotencyKey, mergeKey);
      if ("error" in operationKey) return c.json({ error: operationKey.error }, operationKey.status);
      const keyValue = "value" in operationKey ? operationKey.value : undefined;
      const buildTransport = (idempotencyKey: string) => ({ endpoint: "github_merge" as const, body: { ...parsed.data, idempotencyKey, prNumber } });
      const previous = keyValue ? await service.lookupRouteOperation(taskId, actor, keyValue, buildTransport(keyValue)) : null;
      if (!previous) {
        const task = await deps.db.task.findUnique({ where: { id: taskId }, include: { project: true } });
        if (!task) throw new GroundingAccessError("not_found", 404);
        if (!await groundingAuthority.canWrite(actor, task.projectId, deps.db)) throw new GroundingAccessError("forbidden", 403);
        const context = await selectGroundingRouteContext(deps.db, { taskId, projectId: task.projectId });
        // Reached only when durable history named a key that no longer
        // resolves; an UNPROVISIONED task is never merged fresh here.
        if (context.mode === "UNPROVISIONED") return c.json({ error: "grounding_enrollment_required" }, 409);
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
