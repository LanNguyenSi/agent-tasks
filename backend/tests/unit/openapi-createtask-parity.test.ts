/**
 * Drift guard: the OpenAPI `CreateTaskRequest` schema in
 * backend/src/routes/docs.ts is a hand-written object, independent of the Zod
 * `createTaskSchema` in backend/src/routes/tasks.ts. It silently drifted once
 * already (externalRef / labels / dependsOn / debugFlavor were accepted but
 * undocumented until task 144c1bf2 synced them by hand). This pins the two
 * together so a future field added on one side only fails CI.
 *
 * Scope: key parity + the required-set only. Value-level drift (enum members,
 * min/max, formats) between the two definitions is intentionally NOT checked.
 */
import { describe, it, expect } from "vitest";
import { openApiSpec } from "../../src/routes/docs.js";
import { createTaskSchema } from "../../src/routes/tasks.js";

const createTaskRequest = openApiSpec.components.schemas.CreateTaskRequest;

describe("OpenAPI CreateTaskRequest <-> Zod createTaskSchema parity", () => {
  it("documents exactly the property keys the Zod schema accepts", () => {
    const zodKeys = Object.keys(createTaskSchema.shape).sort();
    const openApiKeys = Object.keys(createTaskRequest.properties).sort();
    // If this fails, a field was added or removed on one side only — sync the
    // CreateTaskRequest object in backend/src/routes/docs.ts with
    // createTaskSchema in backend/src/routes/tasks.ts.
    expect(openApiKeys).toEqual(zodKeys);
  });

  it("marks exactly the non-optional Zod fields as required", () => {
    // A field is optional for input when it is .optional() OR has a .default()
    // (Zod reports both via isOptional()). Everything else must appear in the
    // OpenAPI `required` array.
    const zodRequired = Object.entries(createTaskSchema.shape)
      .filter(([, schema]) => !schema.isOptional())
      .map(([key]) => key)
      .sort();
    const openApiRequired = [...(createTaskRequest.required ?? [])].sort();
    expect(openApiRequired).toEqual(zodRequired);
  });
});
