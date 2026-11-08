import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    agentToken: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-must-be-32chars!!",
    GITHUB_CLIENT_ID: "test-id",
    GITHUB_CLIENT_SECRET: "test-secret",
    FRONTEND_URL: "http://localhost:3000",
    CORS_ORIGINS: "http://localhost:3000",
    PORT: 3001,
    DATABASE_URL: "postgresql://test:test@localhost/test",
  },
}));

import { authMiddleware } from "../../src/middleware/auth.js";
import { buildClearSessionCookie, createSessionToken } from "../../src/services/session.js";

const SECRET = "test-session-secret-must-be-32chars!!";

function buildApp() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", authMiddleware);
  app.get("/probe", (c) => c.json(c.get("actor") ?? null));
  // Mirrors the app wiring (`app.use("/api/auth/logout", authMiddleware)`
  // in app.ts) and the logout handler in routes/auth.ts, which clears the
  // cookie and answers 200 once the middleware has let the request through.
  app.post("/logout", (c) => {
    c.header("Set-Cookie", buildClearSessionCookie());
    return c.json({ message: "Logged out" });
  });
  return app;
}

describe("authMiddleware session cookie auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid session cookie (human actor)", async () => {
    const token = await createSessionToken("user-xyz", SECRET);
    const res = await buildApp().request("/probe", {
      headers: { Cookie: `session=${encodeURIComponent(token)}` },
    });

    expect(res.status).toBe(200);
    const actor = (await res.json()) as { type: string; userId?: string };
    expect(actor.type).toBe("human");
    expect(actor.userId).toBe("user-xyz");
  });

  it("answers the same 401 status and body for a malformed session cookie as for no cookie", async () => {
    const withoutCookie = await buildApp().request("/probe");
    const withMalformed = await buildApp().request("/probe", {
      headers: { Cookie: "session=%E0" },
    });

    expect(withoutCookie.status).toBe(401);
    expect(withMalformed.status).toBe(401);
    expect(await withMalformed.json()).toEqual(await withoutCookie.json());
  });

  it("401s when the malformed session value sits next to other cookies", async () => {
    const res = await buildApp().request("/probe", {
      headers: { Cookie: "theme=dark; session=%E0; csrf=abc" },
    });

    expect(res.status).toBe(401);
  });

  it("logout with a malformed session cookie answers 401 like an absent session, not 500", async () => {
    // app.ts mounts authMiddleware on /api/auth/logout, so an absent or
    // malformed session is answered by the middleware (401, no cookie
    // clearing, the handler never runs) exactly as an absent session.
    const withMalformed = await buildApp().request("/logout", {
      method: "POST",
      headers: { Cookie: "session=%E0" },
    });
    const withoutCookie = await buildApp().request("/logout", { method: "POST" });

    expect(withMalformed.status).toBe(401);
    expect(withoutCookie.status).toBe(401);
    expect(await withMalformed.json()).toEqual(await withoutCookie.json());
    expect(withMalformed.headers.get("set-cookie")).toBeNull();
  });

  it("logout with a valid session cookie answers 200 and clears the cookie", async () => {
    const token = await createSessionToken("user-xyz", SECRET);
    const res = await buildApp().request("/logout", {
      method: "POST",
      headers: { Cookie: `session=${encodeURIComponent(token)}` },
    });

    expect(res.status).toBe(200);
    const clearCookie = res.headers.get("set-cookie");
    expect(clearCookie).toContain("session=;");
    expect(clearCookie).toContain("Max-Age=0");
  });
});
