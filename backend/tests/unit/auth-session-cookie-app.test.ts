/**
 * Malformed session cookie against the REAL `createApp()`: the wiring
 * proof auth-session-cookie.test.ts cannot give: that suite builds its
 * own small Hono app around `authMiddleware`, so it never shows that
 * the real app mounts the middleware on the routes below or what those
 * routes actually answer. Pattern copied from json-body-limit-app.test.ts:
 * well-formed-but-fake DATABASE_URL/SESSION_SECRET are set before
 * importing `app.js` (config validates only their SHAPE at import time;
 * `loadConfig()` calls `process.exit(1)` when they are missing: fatal,
 * not catchable) and the previous values are restored afterwards so
 * nothing leaks into sibling test files.
 *
 * The cookie under test is `session=%E0`: a truncated percent escape
 * makes `decodeURIComponent` throw, and `extractSessionCookie`
 * (services/session.ts) reads such a value as ABSENT, so every request
 * below behaves exactly as the same request without the cookie: the
 * middleware's zero-DB "no credentials supplied" 401, never a 500.
 *
 * Case 4 is the one case with an Authorization header: a Bearer token
 * makes `authMiddleware` look the token up in `prisma.agentToken.findUnique`,
 * which would hit the real (unconnectable) Prisma client, so this file
 * mocks `../../src/lib/prisma.js` (same shape as auth-session-cookie.test.ts)
 * with `findUnique` returning null. The middleware then falls through to
 * the session-JWT Bearer branch (pure HMAC verification, no DB): a token
 * signed with SESSION_SECRET authenticates the request WITHOUT any cookie,
 * and the `/api/auth/me` handler reads the session cookie itself, so it
 * sees the malformed cookie as absent and answers `{ user: null }`: the
 * same body the same Bearer request without the cookie gets. No case
 * here executes a real query: the mock answers the only DB lookup reached.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    agentToken: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
  },
}));

const PREVIOUS_DATABASE_URL = process.env.DATABASE_URL;
const PREVIOUS_SESSION_SECRET = process.env.SESSION_SECRET;
// Same value beforeAll sets, so a token signed with it verifies against
// the config this process loaded at import time.
const SESSION_SECRET = "x".repeat(32);

const MALFORMED = "session=%E0";

let createApp: (corsOrigins: string) => Hono<{ Variables: AppVariables }>;
let createSessionToken: (userId: string, secret: string) => Promise<string>;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgresql://fake:fake@localhost:5432/fake";
  process.env.SESSION_SECRET = SESSION_SECRET;
  ({ createApp } = await import("../../src/app.js"));
  ({ createSessionToken } = await import("../../src/services/session.js"));
});

afterAll(() => {
  if (PREVIOUS_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = PREVIOUS_DATABASE_URL;
  if (PREVIOUS_SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = PREVIOUS_SESSION_SECRET;
});

function app() {
  return createApp("http://localhost:3000");
}

describe("malformed session cookie against the real createApp()", () => {
  it("GET /api/auth/me with session=%E0 answers exactly what the same no-cookie request answers (authMiddleware's no-credentials 401, not 500)", async () => {
    const withoutCookie = await app().request("/api/auth/me");
    const withMalformed = await app().request("/api/auth/me", {
      headers: { Cookie: MALFORMED },
    });

    expect(withoutCookie.status).toBe(401); // the baseline this case pins against
    expect(withMalformed.status).toBe(withoutCookie.status);
    expect(await withMalformed.json()).toEqual(await withoutCookie.json());
  });

  it("POST /api/auth/logout with session=%E0 answers exactly what the same no-cookie request answers (middleware 401s before the clearing handler, so no Set-Cookie either)", async () => {
    const withoutCookie = await app().request("/api/auth/logout", { method: "POST" });
    const withMalformed = await app().request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: MALFORMED },
    });

    expect(withoutCookie.status).toBe(401);
    expect(withMalformed.status).toBe(withoutCookie.status);
    expect(await withMalformed.json()).toEqual(await withoutCookie.json());
    // app.ts mounts authMiddleware on /api/auth/logout, so the handler
    // (which clears the cookie) never runs on this 401.
    expect(withMalformed.headers.get("set-cookie")).toBeNull();
    expect(withoutCookie.headers.get("set-cookie")).toBeNull();
  });

  // A GET needs no body and cannot touch the DB before auth: /api/tasks/:id
  // (routes/tasks.ts) sits behind the `app.use("/api/tasks/*", authMiddleware)`
  // mount in app.ts, which 401s before the handler reads Prisma.
  it("GET /api/tasks/task-1 with session=%E0 gets the no-cookie 401 (same status and body)", async () => {
    const withoutCookie = await app().request("/api/tasks/task-1");
    const withMalformed = await app().request("/api/tasks/task-1", {
      headers: { Cookie: MALFORMED },
    });

    expect(withoutCookie.status).toBe(401);
    expect(withMalformed.status).toBe(401);
    expect(await withMalformed.json()).toEqual(await withoutCookie.json());
  });

  it("GET /api/auth/me with a Bearer session JWT plus the malformed cookie answers { user: null } (the handler treats the malformed cookie as absent, like the same Bearer request without a cookie)", async () => {
    const token = await createSessionToken("user-xyz", SESSION_SECRET);

    const withoutCookie = await app().request("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const withMalformed = await app().request("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}`, Cookie: MALFORMED },
    });

    // Bearer session JWT -> agentToken.findUnique (mocked to null) ->
    // verifySessionToken succeeds -> actor set -> handler runs. The handler
    // authenticates from the COOKIE only, so with the malformed cookie read
    // as absent (and with no cookie at all) it answers { user: null }:
    // not the middleware 401, and not a 500 from the truncated escape.
    expect(withoutCookie.status).toBe(200);
    expect(await withoutCookie.json()).toEqual({ user: null });
    expect(withMalformed.status).toBe(200);
    expect(await withMalformed.json()).toEqual({ user: null });
  });
});
