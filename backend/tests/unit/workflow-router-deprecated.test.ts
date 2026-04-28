/**
 * Workflow customization was removed when agent-tasks locked to the fixed
 * 4-state model. The router still serves GET (so the read-only effective-
 * workflow page can render) but every mutation verb returns 410 Gone.
 *
 * The mutating routes are listed by hand because grepping `workflowRouter`
 * for `.post / .put / .delete` is what we want to enforce as policy:
 * adding a new write route in the future MUST come with a 410 here, or
 * the test fails.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

// Stub the team-access service so the middleware doesn't reach into
// Prisma during these tests — the 410 returns BEFORE any handler logic.
vi.mock("../../src/services/team-access.js", () => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    workflow: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    project: { findUnique: vi.fn() },
  },
}));
vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { workflowRouter } from "../../src/routes/workflows.js";

const ADMIN: Actor = { type: "human", userId: "user-1", teamId: "team-1", role: "ADMIN" };

function makeApp() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", ADMIN);
    await next();
  });
  app.route("/", workflowRouter);
  return app;
}

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const WORKFLOW_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const MUTATING_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "POST", path: `/projects/${PROJECT_ID}/workflow/customize` },
  { method: "POST", path: `/projects/${PROJECT_ID}/workflow/apply-template/coding-agent` },
  { method: "DELETE", path: `/projects/${PROJECT_ID}/workflow` },
  {
    method: "POST",
    path: "/workflows",
    body: { projectId: PROJECT_ID, name: "x", definition: {} },
  },
  {
    method: "PUT",
    path: `/workflows/${WORKFLOW_ID}`,
    body: { name: "x" },
  },
];

describe("workflowRouter — deprecation gate", () => {
  for (const { method, path, body } of MUTATING_ROUTES) {
    it(`${method} ${path} returns 410`, async () => {
      const init: RequestInit = {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      };
      const res = await makeApp().request(path, init);
      expect(res.status).toBe(410);
      const payload = (await res.json()) as { error: string; message: string };
      expect(payload.error).toBe("deprecated");
      expect(payload.message).toMatch(/4-state/i);
    });
  }

  it("GET /workflow-rules still returns 200 (read paths preserved)", async () => {
    const res = await makeApp().request("/workflow-rules");
    expect(res.status).toBe(200);
  });
});
