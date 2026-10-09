/**
 * Pins the request-body key `templateData` on the task create and respec
 * schemas. The mcp-server wire test (mcp-server/tests/task-type-parity.test.ts)
 * wraps templateDataSchema in its own z.object({ templateData }) because it
 * cannot load the backend routes; without this test a rename of the field in
 * createTaskSchema or respecTaskSchema would leave every test green while the
 * mcp-server's error paths ("templateData.taskType") stopped matching.
 * Tracker task 8caceafb.
 */
import { describe, it, expect } from "vitest";
import { createTaskSchema, respecTaskSchema } from "../../src/routes/tasks.js";

describe("templateData request-body key", () => {
  it.each([
    ["createTaskSchema", createTaskSchema],
    ["respecTaskSchema", respecTaskSchema],
  ] as const)("%s declares templateData at the top level", (_name, schema) => {
    expect(Object.keys(schema.shape)).toContain("templateData");
  });

  it.each([
    ["createTaskSchema", createTaskSchema, { title: "t", templateData: { taskType: "tooling" } }],
    ["respecTaskSchema", respecTaskSchema, { templateData: { taskType: "tooling" } }],
  ] as const)("%s reports an invalid taskType at path templateData.taskType", (_name, schema, body) => {
    const parsed = schema.safeParse(body);
    expect(parsed.success).toBe(false);
    const paths = parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("templateData.taskType");
  });
});
