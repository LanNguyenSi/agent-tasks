import { describe, it, expect } from "vitest";
import { AgentTasksClient } from "../src/client.js";
import { TASK_TYPE_VALUES, buildTools } from "../src/tools.js";
import { mapBackendError } from "../src/errors.js";
import { taskTypeSchema } from "../../backend/src/lib/confidence.js";

const config = { baseUrl: "https://example.test", token: "tok_abc" };

function tool(name: string) {
  const found = buildTools(new AgentTasksClient(config), { legacy: true }).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

function templateDataDescription(name: string): string {
  return tool(name).inputShape.templateData.description ?? "";
}

describe("templateData.taskType values in tool descriptions", () => {
  it("the local list equals the backend taskTypeSchema options", () => {
    expect([...TASK_TYPE_VALUES].sort()).toEqual([...taskTypeSchema.options].sort());
  });

  it.each(["task_create", "task_respec"])("%s names every backend taskType value", (name) => {
    const text = templateDataDescription(name);
    for (const value of taskTypeSchema.options) {
      expect(text, `${name} description misses ${value}`).toContain(value);
    }
  });
});

describe("invalid taskType 400", () => {
  it("lists all allowed values in the mapped error", () => {
    const parsed = taskTypeSchema.safeParse("tooling");
    expect(parsed.success).toBe(false);
    const mapped = mapBackendError(400, { success: false, error: (parsed as { error: unknown }).error });
    const text = JSON.stringify(mapped);
    for (const value of taskTypeSchema.options) expect(text).toContain(value);
  });
});
