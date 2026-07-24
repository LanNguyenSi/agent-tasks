/**
 * Unit tests for the app-wide JSON body-size ceiling (hardening, 769df3c4).
 *
 * Mounts `jsonBodyLimit` on a throwaway Hono app (no Prisma / real routers
 * involved — this is a pure middleware, exercised with real Hono request
 * handling, not a mock) rather than booting the full `createApp()`, which
 * pulls in the real (unmocked) Prisma client and every router's transitive
 * dependencies — a pattern no existing test file uses. This keeps the test
 * fast and isolated while still exercising the real `hono/body-limit`
 * behavior end to end.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  jsonBodyLimit,
  JSON_BODY_LIMIT_BYTES,
  ATTACHMENT_UPLOAD_PATH_RE,
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
});
