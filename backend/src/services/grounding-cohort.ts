import type { GroundingCohort, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { groundingTransaction, lockGroundingTask, assertNoGroundingReservation } from "./grounding-transaction.js";
import { GroundingAccessError, mismatch, unavailable } from "./grounding-context.js";

const token = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const cohortSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("EXTERNAL_V1"), protected: z.literal(true), provenance: token, legacySessionId: z.null(), legacyPhase: z.null() }),
  z.object({ mode: z.literal("OFF"), protected: z.literal(false), provenance: token, legacySessionId: z.null(), legacyPhase: z.null() }),
  z.object({ mode: z.literal("LEGACY_LOCAL"), protected: z.boolean(), provenance: token, legacySessionId: token, legacyPhase: token }),
]);
export type GroundingCohortInput = z.infer<typeof cohortSchema>;
export async function requireGroundingCohort(db: Prisma.TransactionClient, taskId: string, projectId: string): Promise<GroundingCohort> {
  const cohort = await db.groundingCohort.findUnique({ where: { taskId } });
  if (!cohort) throw new GroundingAccessError("grounding_not_provisioned", 409);
  if (cohort.projectId !== projectId || !cohortSchema.safeParse(cohort).success) unavailable();
  const binding = await db.groundingBinding.findUnique({ where: { taskId } });
  if ((cohort.mode === "EXTERNAL_V1") !== Boolean(binding) || (binding && (!binding.protected || binding.projectId !== projectId))) unavailable();
  return cohort;
}
export async function provisionGroundingCohortInTransaction(db: Prisma.TransactionClient, taskId: string, projectId: string, input: GroundingCohortInput) {
  const parsed = cohortSchema.safeParse(input);
  if (!parsed.success) unavailable();
  await assertNoGroundingReservation(db, taskId);
  const existing = await db.groundingCohort.findUnique({ where: { taskId } });
  if (existing) {
    if (existing.projectId !== projectId || Object.entries(parsed.data).some(([key, value]) => existing[key as keyof GroundingCohort] !== value)) mismatch();
    return existing;
  }
  return db.groundingCohort.create({ data: { taskId, projectId, ...parsed.data } });
}
/** Trusted server-only enrollment; external enrollment uses GroundingAttemptsService.provision. */
export async function provisionGroundingCohort(client: PrismaClient, input: { taskId: string; projectId: string; cohort: Exclude<GroundingCohortInput, { mode: "EXTERNAL_V1" }> }) {
  return groundingTransaction(client, async db => {
    const task = await lockGroundingTask(db, input.taskId);
    if (task.projectId !== input.projectId || (input.cohort.mode as string) === "EXTERNAL_V1") mismatch();
    if (await db.groundingBinding.findUnique({ where: { taskId: task.id } })) mismatch();
    return provisionGroundingCohortInTransaction(db, task.id, task.projectId, input.cohort);
  });
}
