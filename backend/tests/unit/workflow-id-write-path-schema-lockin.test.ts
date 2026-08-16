/**
 * Lock-in test for task 28bdcdfd (follow-up to 70d3a2b4, the workflowId
 * create-time project-ownership validation).
 *
 * The invariant "only the single-create path (POST /projects/:projectId/tasks,
 * validated against createTaskSchema + the cross-project ownership check in
 * routes/tasks.ts) can set workflowId" is currently secured purely
 * structurally: every other write-path Zod schema either omits the field
 * entirely (updateTaskSchema, agentUpdateTaskSchema, respecTaskSchema never
 * declared it) or explicitly `.omit()`s it (importTaskSchema, derived from
 * createTaskSchema). There was no test pinning that — a future edit that
 * re-adds `workflowId` to one of these schemas (e.g. "just expose it on PATCH
 * too") would silently reopen the sibling write paths the cross-project
 * check does not cover, and nothing would fail.
 *
 * This test asserts, per schema, that:
 *   (1) `workflowId` is not a declared key on the Zod object shape, and
 *   (2) parsing a payload that includes `workflowId` never lets the value
 *       reach the parsed output — either the parse fails outright, or the
 *       field is silently stripped (Zod's default `z.object` behavior for an
 *       unrecognized key).
 * Either outcome in (2) satisfies "reject/strip"; (1) is the precise
 * structural signal that catches a field re-add even before behavior is
 * exercised.
 */
import { describe, it, expect } from "vitest";
import {
  updateTaskSchema,
  agentUpdateTaskSchema,
  respecTaskSchema,
  importTaskSchema,
} from "../../src/routes/tasks.js";

// A syntactically valid UUID so a schema that (hypothetically, post-mutation)
// re-validates workflowId with `.uuid()` still parses successfully instead of
// failing for an unrelated reason — the probe must prove the value reaches
// (or doesn't reach) parsed output, not just that a malformed UUID errors.
const PROBE_WORKFLOW_ID = "12345678-1234-1234-1234-123456789012";

const cases: Array<{
  name: string;
  schema: {
    shape: Record<string, unknown>;
    safeParse: (input: unknown) => {
      success: boolean;
      data?: unknown;
      error?: { issues: Array<{ path: Array<string | number>; message: string }> };
    };
  };
  basePayload: Record<string, unknown>;
}> = [
  { name: "updateTaskSchema", schema: updateTaskSchema, basePayload: {} },
  { name: "agentUpdateTaskSchema", schema: agentUpdateTaskSchema, basePayload: {} },
  { name: "respecTaskSchema", schema: respecTaskSchema, basePayload: { description: "Updated description" } },
  { name: "importTaskSchema", schema: importTaskSchema, basePayload: { title: "Imported task" } },
];

describe("write-path schema lock-in: workflowId stays single-create-only", () => {
  it.each(cases)("$name does not declare workflowId in its shape", ({ name, schema }) => {
    expect(Object.keys(schema.shape), `${name}.shape must not declare 'workflowId'`).not.toContain("workflowId");
  });

  it.each(cases)(
    "$name rejects or strips a workflowId field passed on the request body",
    ({ name, schema, basePayload }) => {
      // Pin that basePayload itself still parses BEFORE probing with
      // workflowId. Without this, a future edit that adds a new required
      // field to the schema makes the combined payload fail for a reason
      // that has nothing to do with workflowId — and the old tautological
      // `else` branch below (`expect(result.success).toBe(false)`, already
      // known false because we're inside the `else`) would rubber-stamp
      // that as "rejected outright", going green while proving nothing.
      expect(
        schema.safeParse(basePayload).success,
        `${name} basePayload no longer parses, update it or this lock-in is inert`,
      ).toBe(true);

      const result = schema.safeParse({ ...basePayload, workflowId: PROBE_WORKFLOW_ID });

      if (result.success) {
        // Stripped (Zod's default unknown-key behavior for a plain
        // z.object()): the value must not have survived into parsed output.
        expect(
          Object.prototype.hasOwnProperty.call(result.data as object, "workflowId"),
          `${name} let workflowId reach parsed output — re-adding the field to this schema must fail this test`,
        ).toBe(false);
      } else {
        // Rejected outright — also an acceptable lock-in outcome, but only
        // if the rejection is actually attributable to workflowId (e.g. a
        // future `.strict()` schema flagging it as an unrecognized key).
        // The basePayload assertion above already rules out "rejected for
        // an unrelated reason", but pin the failure's own issue paths too.
        const paths = (result.error?.issues ?? []).map((issue) => issue.path.join("."));
        expect(
          paths.some((path) => path.includes("workflowId")),
          `${name} rejected the payload but no issue path names 'workflowId' (paths: ${paths.join(", ") || "<none>"})`,
        ).toBe(true);
      }
    },
  );
});
