/**
 * Asserts the token-creation schema rejects unknown scopes. If someone ever
 * replaces `z.array(z.enum(ALL_SCOPES))` with a plain `z.array(z.string())`
 * again — producing permanently-403'd tokens instead of a 400 at mint time
 * — this test fails loudly.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/services/agent-token-service.js", () => ({
  createAgentToken: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  listAgentTokens: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  revokeAgentToken: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-must-be-32chars!!",
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    FRONTEND_URL: "http://localhost:3000",
    CORS_ORIGINS: "http://localhost:3000",
    PORT: 3001,
    DATABASE_URL: "postgresql://test:test@localhost/test",
  },
}));

import { agentTokenRouter } from "../../src/routes/agent-tokens.js";

function makeApp() {
  const actor: Actor = { type: "human", userId: "u1", teamId: "team-1" };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", agentTokenRouter);
  return app;
}

describe("POST /agent-tokens scope validation", () => {
  it("accepts all canonical scopes including github:pr_* ones", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: "00000000-0000-0000-0000-000000000001",
        name: "ok",
        scopes: ["tasks:read", "github:pr_create", "github:pr_merge"],
      }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects a token-creation payload with a typo'd scope", async () => {
    // `github:pr-create` (hyphen) is a common typo for `github:pr_create`
    // (underscore). Schema validation must fail loudly at mint time.
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: "00000000-0000-0000-0000-000000000001",
        name: "bad",
        scopes: ["tasks:read", "github:pr-create"],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts the pre-existing `sso:admin` scope — regression for the enum miss", async () => {
    // A previous refactor that narrowed the scope array to `z.enum(ALL_SCOPES)`
    // silently excluded sso:admin (a scope enforced in routes/sso.ts), so
    // minting a token with it started failing with 400. Keep this test so
    // any future narrowing has to consciously drop the scope.
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: "00000000-0000-0000-0000-000000000001",
        name: "sso-admin",
        scopes: ["sso:admin"],
      }),
    });
    expect(res.status).toBe(201);
  });

  it("GET /scopes returns the canonical list with labels", async () => {
    const res = await makeApp().request("/scopes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: Array<{ id: string; label: string }> };
    const ids = body.scopes.map((s) => s.id);
    // A few representatives — asserting exhaustive equality would couple
    // this test to every scope addition.
    expect(ids).toContain("tasks:read");
    expect(ids).toContain("github:pr_create");
    expect(ids).toContain("github:pr_merge");
    expect(ids).toContain("sso:admin");
    for (const s of body.scopes) {
      expect(s.label).toBeTruthy();
    }
  });

  it("rejects entirely unknown scopes", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: "00000000-0000-0000-0000-000000000001",
        name: "bad",
        scopes: ["admin:everything"],
      }),
    });
    expect(res.status).toBe(400);
  });
});
