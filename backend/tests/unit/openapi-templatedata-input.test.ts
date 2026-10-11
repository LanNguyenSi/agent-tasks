/**
 * Drift guard for the request/response split of the templateData OpenAPI
 * schemas (task 8908e2a2): requests accept each spec section as a string or a
 * list of at most 200 strings (TemplateDataInput, TemplatePreset), responses
 * always carry the stored string (TemplateData). Create and respec bodies must
 * reference the request-side schema.
 */
import { describe, it, expect } from "vitest";
import { openApiSpec } from "../../src/routes/docs.js";

const SPEC_FIELDS = [
  "goal",
  "acceptanceCriteria",
  "context",
  "constraints",
  "scope",
  "outOfScope",
  "dependencies",
  "risk",
  "agentPrompt",
] as const;

const LIST_OR_STRING = {
  oneOf: [
    { type: "string" },
    { type: "array", items: { type: "string" }, maxItems: 200 },
  ],
};

type Props = Record<string, Record<string, unknown>>;
const schemas = openApiSpec.components.schemas as unknown as Record<
  string,
  { properties: Props }
>;

describe("OpenAPI templateData request/response split", () => {
  it.each(SPEC_FIELDS)(
    "TemplateDataInput.%s accepts a string or a list of at most 200 strings",
    (field) => {
      expect(schemas.TemplateDataInput.properties[field]).toMatchObject(
        LIST_OR_STRING,
      );
    },
  );

  it.each(SPEC_FIELDS)(
    "TemplatePreset.%s accepts a string or a list of at most 200 strings",
    (field) => {
      expect(schemas.TemplatePreset.properties[field]).toMatchObject(
        LIST_OR_STRING,
      );
    },
  );

  it.each(SPEC_FIELDS)(
    "response TemplateData.%s stays a plain string",
    (field) => {
      expect(schemas.TemplateData.properties[field]).toMatchObject({
        type: "string",
      });
      expect(schemas.TemplateData.properties[field]).not.toHaveProperty(
        "oneOf",
      );
    },
  );

  it("create and respec request bodies reference TemplateDataInput", () => {
    expect(schemas.CreateTaskRequest.properties.templateData).toEqual({
      $ref: "#/components/schemas/TemplateDataInput",
    });
    expect(schemas.RespecTaskRequest.properties.templateData).toMatchObject({
      allOf: [{ $ref: "#/components/schemas/TemplateDataInput" }],
    });
  });
});
