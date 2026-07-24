/**
 * Integration tests for the app-wide body-size ceiling against the REAL
 * `createApp()` — real middleware order, real route paths, real
 * `hono/body-limit` execution — rather than the isolated dummy-route
 * fixture in json-body-limit.test.ts. This is the suite reviewers asked for
 * to prove the WIRING (app.ts's `app.use("*", jsonBodyLimit)` placement,
 * and the two path exemptions/overrides), not just the middleware module in
 * isolation.
 *
 * `createApp()` is not booted anywhere else in this test suite because it
 * pulls in `config/index.ts`, whose module-level `loadConfig()` calls
 * `process.exit(1)` if `DATABASE_URL`/`SESSION_SECRET` are missing — fatal,
 * not catchable. We set well-formed-but-fake values for both before
 * importing `app.js` (config only validates their SHAPE at import time;
 * nothing here ever executes a real query) and restore the previous values
 * afterwards so this doesn't leak into sibling test files.
 *
 * Every case below deliberately sends NO Authorization header/cookie, so
 * requests that clear `jsonBodyLimit` hit `authMiddleware`'s zero-DB "no
 * credentials supplied" branch and return 401 — never touching the real
 * (unmocked) Prisma client. A 401 (or, for the webhook route, a real 200)
 * instead of jsonBodyLimit's distinctive `{error:"payload_too_large"}` 413
 * is the proof that the body-size gate let the request through to the next
 * layer, exactly as the isolated middleware tests already prove in
 * principle — this suite proves it's actually wired that way on the real
 * app and real route paths, not just possible in theory.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Hono } from "hono";

const PREVIOUS_DATABASE_URL = process.env.DATABASE_URL;
const PREVIOUS_SESSION_SECRET = process.env.SESSION_SECRET;

let createApp: (corsOrigins: string) => Hono;
let JSON_BODY_LIMIT_BYTES: number;
let WEBHOOK_BODY_LIMIT_BYTES: number;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgresql://fake:fake@localhost:5432/fake";
  process.env.SESSION_SECRET = "x".repeat(32);
  ({ createApp } = await import("../../src/app.js"));
  ({ JSON_BODY_LIMIT_BYTES, WEBHOOK_BODY_LIMIT_BYTES } = await import(
    "../../src/middleware/json-body-limit.js"
  ));
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

describe("jsonBodyLimit wired into the real createApp()", () => {
  it("rejects an oversized POST to a real, non-exempt route with 413 BEFORE auth runs (no credentials supplied, would otherwise 401)", async () => {
    const oversized = JSON.stringify({ title: "x".repeat(JSON_BODY_LIMIT_BYTES + 1000) });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(JSON_BODY_LIMIT_BYTES);

    const res = await app().request("/api/projects/proj-x/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("payload_too_large");
  });

  it("does NOT reject a near-ARTIFACT_MAX_BYTES (1,048,576) inline artifact — over the OLD 1 MiB default, under the NEW 2 MiB one — proving the collision is fixed (falls through to auth: 401, not 413)", async () => {
    // 1,100,000-byte `content` + the JSON envelope (type/name/content keys,
    // quoting) lands just over the route's own ARTIFACT_MAX_BYTES ceiling
    // (routes/tasks.ts) and, critically, over the OLD JSON_BODY_LIMIT_BYTES
    // (1_048_576) — this exact shape is what the reviewer flagged as
    // colliding before JSON_BODY_LIMIT_BYTES was raised to 2 MiB.
    const payload = JSON.stringify({ type: "other", name: "big.log", content: "a".repeat(1_100_000) });
    const size = Buffer.byteLength(payload, "utf8");
    expect(size).toBeGreaterThan(1_048_576); // would have 413'd under the old default
    expect(size).toBeLessThan(JSON_BODY_LIMIT_BYTES); // fits the new default with headroom

    const res = await app().request("/api/tasks/task-1/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    expect(res.status).toBe(401); // reached authMiddleware — jsonBodyLimit did not gate it
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toBe("payload_too_large");
  });

  it("does not gate the multipart attachment-upload path on the real mounted route — a body far over JSON_BODY_LIMIT_BYTES still falls through to auth (401, not 413)", async () => {
    const oversized = "a".repeat(JSON_BODY_LIMIT_BYTES + 500_000);

    const res = await app().request("/api/tasks/task-1/attachments/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: oversized,
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toBe("payload_too_large");
  });

  it("does not reject a large-but-legitimate batch import (200 tasks, real-world-sized descriptions) that lands between 1 MiB and 2 MiB", async () => {
    const tasks = Array.from({ length: 200 }, (_, i) => ({
      title: `Imported task ${i}`,
      description: "d".repeat(6_000), // realistic per-task payload, well under the 50_000 per-field cap
    }));
    const payload = JSON.stringify({ tasks });
    const size = Buffer.byteLength(payload, "utf8");
    expect(size).toBeGreaterThan(1_048_576); // over the OLD 1 MiB default
    expect(size).toBeLessThan(JSON_BODY_LIMIT_BYTES); // fits the new 2 MiB default

    const res = await app().request("/api/projects/proj-x/tasks/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    expect(res.status).toBe(401); // reached authMiddleware — jsonBodyLimit did not gate it
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toBe("payload_too_large");
  });

  it("processes an oversized (>2 MiB, <25 MiB) GitHub webhook body end to end — the public, unauthenticated webhook route gets its own larger ceiling instead of being silently dropped by the default", async () => {
    const payload = JSON.stringify({
      repository: { full_name: "acme/thing" },
      padding: "a".repeat(2_200_000),
    });
    const size = Buffer.byteLength(payload, "utf8");
    expect(size).toBeGreaterThan(JSON_BODY_LIMIT_BYTES); // over the default ceiling
    expect(size).toBeLessThan(WEBHOOK_BODY_LIMIT_BYTES); // under the webhook ceiling

    // No X-Hub-Signature-256 (GITHUB_WEBHOOK_SECRET is unset here, so the
    // route's own dev-mode passthrough applies — see routes/webhooks.ts) and
    // no X-GitHub-Delivery (skips the DB-backed dedup claim entirely), so
    // this reaches a real 200 without touching Prisma.
    const res = await app().request("/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);
  });
});
