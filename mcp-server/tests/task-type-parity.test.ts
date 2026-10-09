import { describe, it, expect } from "vitest";
import { AgentTasksClient } from "../src/client.js";
import { TASK_TYPE_VALUES, buildTools } from "../src/tools.js";
import { mapBackendError } from "../src/errors.js";
import { z } from "zod";
import { taskTypeSchema, templateDataSchema } from "../../backend/src/lib/confidence.js";

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

describe("invalid taskType 400 on the wire", () => {
  it("maps the JSON-serialized zValidator body to a templateData.taskType issue listing all values", () => {
    const parsed = z.object({ templateData: templateDataSchema }).safeParse({ templateData: { taskType: "tooling" } });
    expect(parsed.success).toBe(false);
    // Same shape the backend sends: c.json({ success: false, error }, 400).
    const wire = JSON.parse(JSON.stringify({ success: false, error: (parsed as { error: unknown }).error }));
    const mapped = mapBackendError(400, wire) as unknown as { error: { detail?: { issues?: Array<Record<string, unknown>> } } };
    const issues = mapped.error.detail?.issues ?? [];
    const entry = issues.find((e) => e.path === "templateData.taskType");
    expect(entry, JSON.stringify(mapped)).toBeDefined();
    expect(entry?.allowed).toBe(taskTypeSchema.options.join("|"));
    expect(taskTypeSchema.options).toHaveLength(6);
  });

  it("renders a numeric enum option as its number", () => {
    const wire = { success: false, error: { issues: [{ code: "invalid_enum_value", path: ["n"], options: ["a", 2, "b"], message: "bad" }] } };
    const mapped = mapBackendError(400, wire) as unknown as { error: { detail?: { issues?: Array<Record<string, unknown>> } } };
    expect(mapped.error.detail?.issues?.[0]?.allowed).toBe("a|2|b");
  });

  it("marks any other non-string enum option with a visible placeholder", () => {
    const wire = { success: false, error: { issues: [{ code: "invalid_enum_value", path: ["n"], options: ["a", { x: 1 }, "b"], message: "bad" }] } };
    const mapped = mapBackendError(400, wire) as unknown as { error: { detail?: { issues?: Array<Record<string, unknown>> } } };
    expect(mapped.error.detail?.issues?.[0]?.allowed).toBe("a|?|b");
  });
});
