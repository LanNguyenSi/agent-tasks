import { describe, expect, it } from "vitest";
import { openApiSpec } from "../../src/routes/docs.js";

describe("grounding OpenAPI transport", () => {
  it("documents both assessment transport routes and completion operation keys", () => {
    const paths = openApiSpec.paths;
    expect(paths["/api/tasks/{id}/grounding-attempts"]?.post?.requestBody).toBeDefined();
    expect(paths["/api/tasks/{id}/grounding-attempts/{attemptId}/receipt"]?.post?.requestBody).toBeDefined();
    for (const parameters of [
      paths["/api/tasks/{id}/finish"].post.parameters,
      paths["/api/tasks/{id}/merge"].post.parameters,
      paths["/api/tasks/{id}/abandon"].post.parameters,
    ]) {
      expect(parameters).toContainEqual({ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" }, description: "Required for a provisioned task." });
    }
  });
});
