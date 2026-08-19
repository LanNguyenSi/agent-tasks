/**
 * Integration test for the M4 suggest-rewrite rate limit against the REAL
 * `createApp()` — proves the WIRING (app.ts's
 * `app.use("/api/tasks/:id/suggest-rewrite", rateLimit(...))` line), not
 * just the `rateLimit` middleware in isolation (already covered by
 * rate-limit.test.ts). Modeled on json-body-limit-app.test.ts's pattern for
 * booting the real app without a DB.
 *
 * Review round-2 finding 1: the suggest-rewrite endpoint makes a paid,
 * externally-billed Anthropic call with SDK defaults that retry timeouts
 * (see services/llm-rewrite.ts), so it needs its own rate limit distinct
 * from the general /api/tasks/* traffic. The limit is registered BEFORE
 * authMiddleware in app.ts, so a request that trips it never reaches auth
 * or the DB — the 11th request within the window 429s with no
 * Authorization header supplied, proving the gate runs ahead of auth.
 *
 * `:id` is part of the rate-limit key (`${ip}:${c.req.path}`, see
 * middleware/rate-limit.ts) since the middleware is mounted on the literal
 * request path, not a route-pattern label. The second describe block below
 * documents that scoping explicitly: two different task ids get two
 * independent buckets from the same caller. That is a known, accepted
 * scoping (mirrors every other path-keyed limiter already in app.ts), not a
 * gap introduced here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";

const PREVIOUS_DATABASE_URL = process.env.DATABASE_URL;
const PREVIOUS_SESSION_SECRET = process.env.SESSION_SECRET;

let createApp: (corsOrigins: string) => Hono<{ Variables: AppVariables }>;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgresql://fake:fake@localhost:5432/fake";
  process.env.SESSION_SECRET = "x".repeat(32);
  ({ createApp } = await import("../../src/app.js"));
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

function post(taskId: string) {
  return app().request(`/api/tasks/${taskId}/suggest-rewrite`, { method: "POST" });
}

describe("suggest-rewrite rate limit wired into the real createApp()", () => {
  it("429s the 11th request within the window for the same task id, BEFORE auth runs (no credentials supplied, would otherwise 401)", async () => {
    const taskId = "rl-wiring-task-1";
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await post(taskId)).status);
    }

    // First 10 clear the limiter and fall through to authMiddleware, which
    // 401s on the missing Authorization header/cookie (no real actor, no DB
    // hit). The 11th is rejected by the limiter itself.
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);

    const res = await post(taskId); // one more, still within the window
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("does not gate an ordinary task route that is not suggest-rewrite (falls through to auth: 401, not 429, after 11 calls)", async () => {
    for (let i = 0; i < 11; i++) {
      const res = await app().request("/api/tasks/rl-wiring-task-2", { method: "GET" });
      expect(res.status).toBe(401);
    }
  });
});

describe("suggest-rewrite rate limit scoping (documents a known limitation)", () => {
  it("gives two different task ids independent buckets from the same caller — exhausting one id's limit does not affect another id", async () => {
    const exhausted = "rl-scope-task-a";
    for (let i = 0; i < 10; i++) {
      expect((await post(exhausted)).status).toBe(401);
    }
    expect((await post(exhausted)).status).toBe(429); // this id's bucket is now full

    // A fresh id from the same (unresolvable-in-test, shared "unknown")
    // caller identity is NOT rejected — the limiter keys on the full
    // request path (which embeds :id), not on a route-pattern label.
    const fresh = "rl-scope-task-b";
    expect((await post(fresh)).status).toBe(401);
  });
});
