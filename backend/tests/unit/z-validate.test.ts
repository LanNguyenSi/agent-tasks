/**
 * Contract test for the shared request validator `zValidate` (lib/z-validate.ts).
 *
 * The whole point of the helper is that, on zod 4 (where `ZodError.issues` is
 * non-enumerable), a failed validation STILL returns the base wire body:
 *   400 { success: false, error: { issues: [...], name: "ZodError" } }
 * with top-level keys EXACTLY [success, error] and error keys EXACTLY
 * [issues, name] (no `message`). Clients (mcp-server/src/errors.ts) read
 * `body.error.issues`, so dropping `issues` is a regression.
 *
 * Pinned here per target (json / query / param) on a minimal Hono app, plus one
 * route-level check through the real agentTokenRouter (whose handler is never
 * reached on a validation failure, so no auth/DB is needed).
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { zValidate } from "../../src/lib/z-validate.js";
import { agentTokenRouter } from "../../src/routes/agent-tokens.js";

const jsonSchema = z.object({
  a: z.string(),
  k: z.enum(["x", "y"]),
});
const querySchema = z.object({ page: z.string() });
const paramSchema = z.object({ id: z.guid() });

/** The zod 4 issue shape as it arrives over JSON (path is PropertyKey[]). */
type Issue = { code: string; path: Array<string | number | symbol>; message: string };
function issuesOf(body: unknown): Issue[] {
  return (body as { error: { issues: Issue[] } }).error.issues;
}

function buildFixture(): Hono {
  const app = new Hono();
  app.post("/j", zValidate("json", jsonSchema), (c) => c.json(c.req.valid("json")));
  app.get("/q", zValidate("query", querySchema), (c) => c.json(c.req.valid("query")));
  app.get("/p/:id", zValidate("param", paramSchema), (c) => c.json(c.req.valid("param")));
  return app;
}

/** Asserts the exact base key set and issue shape shared by every target. */
function expectBaseValidationBody(status: number, body: unknown) {
  expect(status).toBe(400);
  const obj = body as Record<string, unknown>;
  expect(Object.keys(obj).sort()).toEqual(["error", "success"]);
  expect(obj.success).toBe(false);
  const err = obj.error as Record<string, unknown>;
  expect(Object.keys(err).sort()).toEqual(["issues", "name"]);
  expect(err.name).toBe("ZodError");
  expect(Array.isArray(err.issues)).toBe(true);
  const issues = err.issues as Issue[];
  expect(issues.length).toBeGreaterThan(0);
  for (const issue of issues) {
    expect(typeof issue.code).toBe("string");
    expect(typeof issue.message).toBe("string");
    expect(Array.isArray(issue.path)).toBe(true);
  }
  // zod 4 ZodError.issues was the thing the raw spread lost; the helper must
  // rebuild it, and it must not leak the zod-4-only `message` back onto error.
  expect(err).not.toHaveProperty("message");
}

describe("zValidate wire body (contract)", () => {
  it("json failure keeps the base body and issue fields", async () => {
    const res = await buildFixture().fetch(
      new Request("http://test/j", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1, k: "z" }),
      }),
    );
    const body = await res.json();
    expectBaseValidationBody(res.status, body);
    const issues = issuesOf(body);
    expect(issues.some((i) => i.path.join(".") === "a")).toBe(true);
    expect(issues.some((i) => i.path.join(".") === "k")).toBe(true);
  });

  it("query failure keeps the base body", async () => {
    const res = await buildFixture().fetch(new Request("http://test/q?x=1"));
    const body = await res.json();
    expectBaseValidationBody(res.status, body);
    const issues = issuesOf(body);
    expect(issues.some((i) => i.path.join(".") === "page")).toBe(true);
  });

  it("param failure keeps the base body", async () => {
    const res = await buildFixture().fetch(new Request("http://test/p/not-a-guid"));
    const body = await res.json();
    expectBaseValidationBody(res.status, body);
    const issues = issuesOf(body);
    expect(issues.some((i) => i.path.join(".") === "id")).toBe(true);
  });

  it("success path is unchanged and reaches the handler", async () => {
    const app = buildFixture();
    const res = await app.request("http://test/j", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: "ok", k: "x" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: "ok", k: "x" });
    const q = await app.request("http://test/q?page=3");
    expect(q.status).toBe(200);
    expect(await q.json()).toEqual({ page: "3" });
    const p = await app.request(`http://test/p/${"550e8400-e29b-41d4-a716-446655440000"}`);
    expect(p.status).toBe(200);
  });
});

describe("zValidate is wired into real routers", () => {
  it("agentTokenRouter POST / rejects an invalid body with the contract wire body (no handler/auth reached)", async () => {
    const res = await agentTokenRouter.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: "not-a-guid", name: "" }),
    });
    const body = await res.json();
    expectBaseValidationBody(res.status, body);
    const issues = issuesOf(body);
    expect(issues.some((i) => i.path.join(".") === "teamId")).toBe(true);
  });
});
