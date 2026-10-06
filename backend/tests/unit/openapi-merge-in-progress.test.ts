/**
 * Drift guard: the OpenAPI document (hand-written in routes/docs.ts) documents
 * the `409 merge_in_progress` answer of every documented claim or status writer
 * with a schema that matches the body the backend actually builds
 * (`mergeInProgressBody`).
 */
import { describe, it, expect } from "vitest";
import { openApiSpec } from "../../src/routes/docs.js";
import { mergeInProgressBody } from "../../src/middleware/error.js";

type Operation = { responses?: Record<string, unknown> };
const paths = openApiSpec.paths as unknown as Record<string, Record<string, Operation>>;
const schema = openApiSpec.components.schemas.MergeInProgressResponse as unknown as {
  properties: Record<string, { enum?: string[] }>;
  required: string[];
};

const WRITERS: Array<[string, string]> = [
  ["/api/tasks/{id}", "patch"],
  ["/api/tasks/{id}/finish", "post"],
  ["/api/tasks/{id}/merge", "post"],
  ["/api/tasks/{id}/abandon", "post"],
  ["/api/tasks/{id}/claim", "post"],
  ["/api/tasks/{id}/release", "post"],
  ["/api/tasks/{id}/transition", "post"],
  ["/api/github/pull-requests/{prNumber}/merge", "post"],
];

describe("OpenAPI merge_in_progress", () => {
  it("MergeInProgressResponse describes the body the backend builds", () => {
    const body = mergeInProgressBody(42);
    expect(schema.properties.error.enum).toEqual([body.error]);
    expect(Object.keys(body).sort()).toEqual(Object.keys(schema.properties).sort());
    for (const key of schema.required) expect(body).toHaveProperty(key);
  });

  it.each(WRITERS)("%s %s documents the 409 merge_in_progress answer", (path, method) => {
    const operation = paths[path]?.[method];
    expect(operation, `${method} ${path} is documented`).toBeDefined();
    const conflict = (operation!.responses as Record<string, unknown>)["409"];
    expect(conflict, `${method} ${path} documents a 409`).toBeDefined();
    expect(JSON.stringify(conflict)).toContain("#/components/schemas/MergeInProgressResponse");
  });
});
