/**
 * Unit tests for the app-wide request-body-size ceiling (hardening, 769df3c4).
 *
 * Mounts `jsonBodyLimit` on a throwaway Hono app (no Prisma / real routers
 * involved — this is a pure middleware, exercised with real Hono request
 * handling, not a mock) rather than booting the full `createApp()`. This
 * keeps these tests fast and isolated while still exercising the real
 * `hono/body-limit` behavior end to end. A separate integration suite
 * (json-body-limit-app.test.ts) boots the REAL `createApp()` and hits the
 * real routes to prove the wiring, not just this module in isolation.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  jsonBodyLimit,
  JSON_BODY_LIMIT_BYTES,
  WEBHOOK_BODY_LIMIT_BYTES,
  ATTACHMENT_UPLOAD_PATH_RE,
  WEBHOOK_PATH_RE,
} from "../../src/middleware/json-body-limit.js";

function makeApp() {
  const app = new Hono();
  app.use("*", jsonBodyLimit);
  app.post("/api/whatever", (c) => c.json({ ok: true }));
  // Dummy stand-in for the real multipart route (routes/tasks.ts), which
  // sets its own larger `bodyLimit` — not duplicated here. This proves
  // `jsonBodyLimit` steps aside for the path, not that the real route's own
  // limit is unchanged (that's covered by the real route's own tests).
  app.post("/api/tasks/:id/attachments/upload", (c) => c.json({ ok: true }));
  // Dummy stand-in for the real webhook route (routes/webhooks.ts).
  app.post("/api/webhooks/github", (c) => c.json({ received: true }));
  return app;
}

describe("jsonBodyLimit", () => {
  it("rejects a JSON body over JSON_BODY_LIMIT_BYTES with a clear 413", async () => {
    const app = makeApp();
    const oversized = "a".repeat(JSON_BODY_LIMIT_BYTES + 1);

    const res = await app.request("/api/whatever", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("payload_too_large");
    expect(body.message).toMatch(new RegExp(`${JSON_BODY_LIMIT_BYTES}-byte limit`));
  });

  it("accepts a JSON body at/under JSON_BODY_LIMIT_BYTES", async () => {
    const app = makeApp();
    const withinLimit = "a".repeat(1000);

    const res = await app.request("/api/whatever", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: withinLimit,
    });

    expect(res.status).toBe(200);
  });

  it("does not gate the multipart attachment-upload path — a body far over JSON_BODY_LIMIT_BYTES still reaches the route handler", async () => {
    const app = makeApp();
    const oversized = "a".repeat(JSON_BODY_LIMIT_BYTES + 1);

    const res = await app.request("/api/tasks/task-1/attachments/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: oversized,
    });

    // The dummy handler just returns 200 — if jsonBodyLimit governed this
    // path, an oversized body would 413 here exactly like the "/api/whatever"
    // case above. It does not, proving the exemption fires. The real route's
    // own (larger) bodyLimit — unchanged by this task — governs it instead.
    expect(res.status).toBe(200);
  });

  it("ATTACHMENT_UPLOAD_PATH_RE matches only the exact upload path, not sibling attachment routes", () => {
    expect(ATTACHMENT_UPLOAD_PATH_RE.test("/api/tasks/abc-123/attachments/upload")).toBe(true);
    expect(ATTACHMENT_UPLOAD_PATH_RE.test("/api/tasks/abc-123/attachments")).toBe(false);
    expect(ATTACHMENT_UPLOAD_PATH_RE.test("/api/tasks/abc-123/attachments/upload/extra")).toBe(false);
    expect(ATTACHMENT_UPLOAD_PATH_RE.test("/api/whatever")).toBe(false);
  });

  // ── GitHub webhook paths get their own, larger ceiling ────────────────────

  it("applies WEBHOOK_BODY_LIMIT_BYTES (not the tight default) to webhook paths: a body over the default but under the webhook ceiling passes", async () => {
    const app = makeApp();
    const overDefaultUnderWebhookCeiling = "a".repeat(JSON_BODY_LIMIT_BYTES + 1000);
    expect(overDefaultUnderWebhookCeiling.length).toBeLessThan(WEBHOOK_BODY_LIMIT_BYTES);

    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: overDefaultUnderWebhookCeiling,
    });

    expect(res.status).toBe(200);
  });

  it("still rejects a webhook body over WEBHOOK_BODY_LIMIT_BYTES with a clear 413", async () => {
    const app = makeApp();
    const oversized = "a".repeat(WEBHOOK_BODY_LIMIT_BYTES + 1);

    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("payload_too_large");
    expect(body.message).toMatch(new RegExp(`${WEBHOOK_BODY_LIMIT_BYTES}-byte webhook limit`));
  }, 20_000);

  it("WEBHOOK_PATH_RE matches every path under /api/webhooks/ only", () => {
    expect(WEBHOOK_PATH_RE.test("/api/webhooks/github")).toBe(true);
    expect(WEBHOOK_PATH_RE.test("/api/webhooks/")).toBe(true);
    expect(WEBHOOK_PATH_RE.test("/api/webhooks")).toBe(false);
    expect(WEBHOOK_PATH_RE.test("/api/tasks/abc/attachments/upload")).toBe(false);
    expect(WEBHOOK_PATH_RE.test("/api/whatever")).toBe(false);
  });
});
