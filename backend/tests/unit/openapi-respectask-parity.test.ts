/**
 * Drift guard: the OpenAPI `RespecTaskRequest` schema in
 * backend/src/routes/docs.ts is a hand-written object, independent of the Zod
 * `respecTaskSchema` in backend/src/routes/tasks.ts. Mirrors
 * openapi-createtask-parity.test.ts's approach so a future field added on one
 * side only fails CI, same as CreateTaskRequest.
 *
 * `respecTaskSchema` is the plain (unrefined) object schema — the route wraps
 * it in `.refine(...)` to enforce "at least one of description/templateData",
 * a business rule that isn't expressible as a flat JSON Schema `required`
 * array (documented instead via `anyOf` on RespecTaskRequest; not checked
 * here, same "value-level drift not checked" scope as the CreateTaskRequest
 * parity test).
 *
 * Scope: key parity + the required-set only.
 */
import { describe, it, expect } from "vitest";
import { openApiSpec } from "../../src/routes/docs.js";
import { respecTaskSchema } from "../../src/routes/tasks.js";

const respecTaskRequest = openApiSpec.components.schemas.RespecTaskRequest;

describe("OpenAPI RespecTaskRequest <-> Zod respecTaskSchema parity", () => {
  it("documents exactly the property keys the Zod schema accepts", () => {
    const zodKeys = Object.keys(respecTaskSchema.shape).sort();
    const openApiKeys = Object.keys(respecTaskRequest.properties).sort();
    // If this fails, a field was added or removed on one side only — sync the
    // RespecTaskRequest object in backend/src/routes/docs.ts with
    // respecTaskSchema in backend/src/routes/tasks.ts.
    expect(openApiKeys).toEqual(zodKeys);
  });

  it("marks exactly the non-optional Zod fields as required", () => {
    // Both fields are individually .optional() on respecTaskSchema — the
    // "at least one required" rule lives in the route's separate .refine()
    // wrapper, not in this base schema. So the OpenAPI `required` array must
    // be empty, matching the base schema.
    const zodRequired = Object.entries(respecTaskSchema.shape)
      .filter(([, schema]) => !schema.isOptional())
      .map(([key]) => key)
      .sort();
    const openApiRequired = [...(respecTaskRequest.required ?? [])].sort();
    expect(openApiRequired).toEqual(zodRequired);
  });
});
