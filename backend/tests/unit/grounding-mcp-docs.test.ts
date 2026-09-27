import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { openApiSpec } from "../../src/routes/docs.js";
import { createGroundingRouter } from "../../src/routes/grounding.js";
import type { AppVariables } from "../../src/types/hono.js";

const codeOnlyGroundingApp = () => {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", { type: "agent", tokenId: "token", teamId: "team", userId: "user", scopes: [] });
    await next();
  });
  app.route("/api", createGroundingRouter());
  return app;
};

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

  it("documents the code-only unavailable response emitted by the real grounding route", async () => {
    const response = await codeOnlyGroundingApp().request("/api/tasks/33333333-3333-3333-3333-333333333333/grounding-attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "finish" }),
    });
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "grounding_verification_unavailable" });

    const groundingError = openApiSpec.components.schemas.GroundingErrorResponse;
    expect(groundingError.required).toEqual(["error"]);
    expect(groundingError.properties).toMatchObject({
      error: { type: "string" },
      message: { type: "string" },
      detail: { type: "string" },
    });
    const issueResponses = openApiSpec.paths["/api/tasks/{id}/grounding-attempts"].post.responses;
    const receiptResponses = openApiSpec.paths["/api/tasks/{id}/grounding-attempts/{attemptId}/receipt"].post.responses;
    for (const responseDefinition of [
      issueResponses["400"], issueResponses["401"], issueResponses["403"], issueResponses["404"], issueResponses["409"], issueResponses["503"],
      receiptResponses["400"], receiptResponses["401"], receiptResponses["403"], receiptResponses["404"], receiptResponses["409"], receiptResponses["422"], receiptResponses["503"],
    ]) {
      expect(responseDefinition.content?.["application/json"]?.schema).toEqual({
        $ref: "#/components/schemas/GroundingErrorResponse",
      });
    }
  });
});
