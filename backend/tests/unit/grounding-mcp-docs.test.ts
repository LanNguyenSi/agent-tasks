import { describe, expect, it } from "vitest";
import { openApiSpec } from "../../src/routes/docs.js";

describe("grounding OpenAPI transport", () => {
  it("documents both assessment transport routes and completion operation keys", () => {
    const paths = openApiSpec.paths as Record<string, { post?: { parameters?: Array<{ name: string; in: string }>; requestBody?: unknown } }>;
    expect(paths["/api/tasks/{id}/grounding-attempts"]?.post?.requestBody).toBeDefined();
    expect(paths["/api/tasks/{id}/grounding-attempts/{attemptId}/receipt"]?.post?.requestBody).toBeDefined();
    for (const path of ["/api/tasks/{id}/finish", "/api/tasks/{id}/merge", "/api/tasks/{id}/abandon"]) {
      expect(paths[path]?.post?.parameters).toContainEqual({ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" }, description: "Required for a provisioned task." });
    }
  });
});
