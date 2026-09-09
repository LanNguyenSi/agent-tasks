import { lockGroundingAuthority } from "./grounding-direct-authority.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import { requireGroundingCohort } from "./grounding-cohort.js";
import { mismatch, unavailable } from "./grounding-context.js";
import { groundingTransaction, lockGroundingTask } from "./grounding-transaction.js";
import type { GroundingTask } from "./grounding-context.js";
import { GroundingAccessError } from "./grounding-context.js";
import { mutateGroundingContext } from "./grounding-context-mutation.js";
import type { Actor } from "../types/auth.js";

/**
 * The route-facing cohort decision is deliberately independent of task
 * metadata.  Metadata is agent supplied and may describe a historical local
 * wrapper session; it can never enroll a task into the external protocol.
 */
export type GroundingRouteContext =
  | { mode: "UNPROVISIONED" }
  | { mode: "EXTERNAL_V1" }
  | { mode: "LEGACY_LOCAL" }
  | { mode: "OFF" };

export interface ExternalGroundingHint {
  kind: "external_grounding_v1";
  taskId: string;
  attempts: {
    issue: { url: string; body: { intent: "finish" | "approve" | "merge" } };
    receipt: { url: string; body: { session: { id: string; revision: number }; receipt: string } };
  };
  completion: {
    requiredHeader: "Idempotency-Key";
  };
}

/** A session-free, followable route contract for externally provisioned work. */
export function buildExternalGroundingHint(
  taskId: string,
  intent: ExternalGroundingHint["attempts"]["issue"]["body"]["intent"] = "finish",
): ExternalGroundingHint {
  const base = `/api/tasks/${encodeURIComponent(taskId)}/grounding-attempts`;
  return {
    kind: "external_grounding_v1",
    taskId,
    attempts: {
      issue: { url: base, body: { intent } },
      receipt: {
        url: `${base}/:attemptId/receipt`,
        body: { session: { id: "<producer-session-id>", revision: 1 }, receipt: "<signed-receipt>" },
      },
    },
    completion: { requiredHeader: "Idempotency-Key" },
  };
}

/**
 * Select the authoritative route mode after the caller has locked the task.
 * A cohort and binding are a single enrollment record: a partial or invalid
 * pair is unavailable, never a reason to fall back to metadata or legacy
 * wrapper behavior.
 */
export async function selectGroundingRouteContextInTransaction(
  db: Prisma.TransactionClient,
  input: { taskId: string; projectId: string },
): Promise<GroundingRouteContext> {
  const [cohort, binding] = await Promise.all([
    db.groundingCohort.findUnique({ where: { taskId: input.taskId } }),
    db.groundingBinding.findUnique({ where: { taskId: input.taskId } }),
  ]);

  if (!cohort && !binding) return { mode: "UNPROVISIONED" };
  // A binding is exclusively an external enrollment object. A cohort-only
  // LEGACY_LOCAL/OFF row is valid and intentionally remains distinguishable
  // from an unprovisioned historical task.
  if (!cohort || (cohort.mode === "EXTERNAL_V1" && !binding)) unavailable();

  // Reuse the C03 cohort/binding validator rather than duplicating its mode,
  // project and protection invariants in the route layer.
  const verified = await requireGroundingCohort(db, input.taskId, input.projectId);
  if (verified.mode === "EXTERNAL_V1") return { mode: "EXTERNAL_V1" };
  if (verified.mode === "LEGACY_LOCAL") return { mode: "LEGACY_LOCAL" };
  if (verified.mode === "OFF") return { mode: "OFF" };
  return unavailable();
}

/**
 * A bounded read that locks the task while resolving the enrollment pair.
 * Mutation routes call the in-transaction form through their shared mutation
 * protocol; pickup/start use this form solely to decide presentation.
 */
export async function selectGroundingRouteContext(
  client: PrismaClient,
  input: { taskId: string; projectId: string },
): Promise<GroundingRouteContext> {
  return groundingTransaction(client, async db => {
    const task = await lockGroundingTask(db, input.taskId);
    if (task.projectId !== input.projectId) mismatch();
    return selectGroundingRouteContextInTransaction(db, input);
  });
}

/**
 * Serialize legacy presentation with enrollment. This is intentionally not a
 * generic mutation callback: its presenter is the bounded, in-process legacy
 * wrapper initializer and its accompanying metadata write. External and OFF
 * callers pass through without invoking that initializer. Provision uses the
 * same parent/task locks, so it cannot turn a task external between mode
 * selection and a legacy wrapper session being recorded.
 */
export async function presentGroundingRouteContext<T>(
  client: PrismaClient,
  input: {
    taskId: string;
    projectId: string;
    present: (task: GroundingTask, context: GroundingRouteContext) => Promise<T>;
    persist?: (db: Prisma.TransactionClient, task: GroundingTask, value: T) => Promise<void>;
  },
): Promise<{ task: GroundingTask; context: GroundingRouteContext; value: T }> {
  return groundingTransaction(client, async db => {
    const task = await lockGroundingTask(db, input.taskId);
    if (task.projectId !== input.projectId) mismatch();
    const context = await selectGroundingRouteContextInTransaction(db, input);
    const value = await input.present(task, context);
    if (input.persist) await input.persist(db, task, value);
    return { task, context, value };
  });
}

/**
 * Common adapter for direct route claim/status mutations. It locks parent then
 * task, rechecks the route's authority and expected state under that lock,
 * performs the route's existing CAS with the supplied transaction client, and
 * only supersedes a generation when the CAS actually changed the row.
 */
export async function mutateGroundingRouteContext<T>(
  client: PrismaClient,
  input: {
    taskId: string;
    projectId: string;
    actor: Actor;
    reason: string;
    revalidate: (db: Prisma.TransactionClient, task: GroundingTask) => Promise<void>;
    mutate: (db: Prisma.TransactionClient, task: GroundingTask) => Promise<{ value: T; changed: boolean }>;
  },
): Promise<{ value: T; changed: boolean }> {
  return mutateGroundingContext(client, {
    projectIds: [input.projectId],
    audit: { actor: input.actor, reason: input.reason },
    selectAndAuthorize: async () => [input.taskId],
    mutate: async (db, tasks) => {
      const task = tasks[0];
      if (!task) throw new GroundingAccessError("not_found", 404);
      await lockGroundingAuthority(db, input.actor, task.projectId);
      await input.revalidate(db, task);
      return input.mutate(db, task);
    },
    didMutate: result => result.changed,
  });
}
