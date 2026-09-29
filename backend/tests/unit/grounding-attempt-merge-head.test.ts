import { expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { assertAttemptMergeHead } from "../../src/services/grounding-completion.js";

const head = "a".repeat(40);
const other = "c".repeat(40);
function db(binding: string | null, context: { subjectMode: string; headSha: string | null }) {
  const bytes = Buffer.from(JSON.stringify({ protection: { protected: true, subjectMode: context.subjectMode }, deliverable: { headSha: context.headSha } }), "utf8");
  return {
    groundingAttempt: { findUniqueOrThrow: async () => ({ id: "attempt", contextBytes: bytes }) },
    groundingBinding: { findUnique: async () => (binding === null ? null : { taskId: "task", subjectMode: binding }) },
  } as unknown as Prisma.TransactionClient;
}

it.each([
  ["TASK_SPEC binding and context without a signed head", "TASK_SPEC", "TASK_SPEC", null, head],
  ["CODE_HEAD signed head equal to the reserved head", "CODE_HEAD", "CODE_HEAD", head, head],
  ["TASK_SPEC context whose signed head equals the reserved head", "TASK_SPEC", "TASK_SPEC", head, head],
] as const)("accepts %s", async (_case, binding, subjectMode, headSha, reserved) => {
  await expect(assertAttemptMergeHead(db(binding, { subjectMode, headSha }), "task", "attempt", reserved)).resolves.toBeUndefined();
});

it.each([
  ["CODE_HEAD signed head other than the reserved head", "CODE_HEAD", "CODE_HEAD", other],
  ["CODE_HEAD binding with a context that signs no head", "CODE_HEAD", "CODE_HEAD", null],
  ["CODE_HEAD binding with a TASK_SPEC context", "CODE_HEAD", "TASK_SPEC", null],
  ["TASK_SPEC binding with a CODE_HEAD context that signs no head", "TASK_SPEC", "CODE_HEAD", null],
  ["TASK_SPEC context whose signed head differs from the reserved head", "TASK_SPEC", "TASK_SPEC", other],
  ["missing binding", null, "TASK_SPEC", null],
] as const)("refuses %s", async (_case, binding, subjectMode, headSha) => {
  await expect(assertAttemptMergeHead(db(binding, { subjectMode, headSha }), "task", "attempt", head)).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
});
