import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { AgentTasksClient } from "../src/client.js";
import { TASK_TYPE_VALUES, buildTools } from "../src/tools.js";
import { mapBackendError, type TeachingError } from "../src/errors.js";
import { z } from "zod";
import { taskTypeSchema, templateDataSchema } from "../../backend/src/lib/confidence.js";
// Same cross-workspace test-only import idiom as tests/errors.test.ts: the
// 400 body is produced here by the BACKEND's own validator wrapper, so this
// file maps what the real producer sends, not a hand-built approximation.
import { zValidate } from "../../backend/src/lib/z-validate.js";

const config = { baseUrl: "https://example.test", token: "tok_abc" };

function tool(name: string) {
  const found = buildTools(new AgentTasksClient(config), { legacy: true }).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

/**
 * Typed view of mapBackendError's generic-degrade issue summary. The
 * TeachingError `detail` is deliberately a plain Record<string, unknown>, so
 * this is the one place that narrows `detail.issues`; no `as unknown as`.
 */
function mappedIssues(err: TeachingError): Array<Record<string, unknown>> {
  const issues = err.error.detail?.issues;
  return Array.isArray(issues) ? issues : [];
}

function templateDataDescription(name: string): string {
  // ZodRawShape's values are typed as the core $ZodType in zod 4, which
  // carries no `description`; the runtime values are classic z.ZodType
  // instances (that is what z.enum/z.record build here), whose declared
  // `description` property reads back what .describe() set.
  return (tool(name).inputShape.templateData as z.ZodType).description ?? "";
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
  /**
   * The real producer: the backend's shared zValidate wrapper mounted with
   * the real templateData schema on a minimal Hono app, asked to validate an
   * invalid taskType. The wrapper serializes the zod 4 error explicitly from
   * `error.issues` (zod 4 makes `issues` non-enumerable, so a bare spread of
   * the error would lose it), producing on the wire
   * { success: false, error: { issues: [...], name: "ZodError" } }, which is
   * what errors.ts consumes.
   */
  async function realBackendValidation400(): Promise<unknown> {
    const app = new Hono();
    app.post("/v", zValidate("json", z.object({ templateData: templateDataSchema })), (c) =>
      c.json({ ok: true }),
    );
    const res = await app.request("http://test/v", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateData: { taskType: "tooling" } }),
    });
    expect(res.status).toBe(400);
    return res.json();
  }

  it("maps the backend validator's JSON body to a templateData.taskType issue listing all values", async () => {
    const wire = await realBackendValidation400();
    const mapped = mapBackendError(400, wire);
    const entry = mappedIssues(mapped).find((e) => e.path === "templateData.taskType");
    expect(entry, JSON.stringify(mapped)).toBeDefined();
    expect(entry?.allowed).toBe(taskTypeSchema.options.join("|"));
    expect(taskTypeSchema.options).toHaveLength(6);
  });

  it("renders a numeric enum option as its number", () => {
    const wire = { success: false, error: { issues: [{ code: "invalid_enum_value", path: ["n"], options: ["a", 2, "b"], message: "bad" }] } };
    const mapped = mapBackendError(400, wire);
    expect(mappedIssues(mapped)[0]?.allowed).toBe("a|2|b");
  });

  it("marks any other non-string enum option with a visible placeholder", () => {
    const wire = { success: false, error: { issues: [{ code: "invalid_enum_value", path: ["n"], options: ["a", { x: 1 }, "b"], message: "bad" }] } };
    const mapped = mapBackendError(400, wire);
    expect(mappedIssues(mapped)[0]?.allowed).toBe("a|?|b");
  });
});
