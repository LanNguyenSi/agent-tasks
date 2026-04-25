/**
 * Tests for the AsyncLocalStorage-backed log context plus the
 * request-context middleware that seeds it.
 *
 * The logger is real (Pino instance from `lib/logger.ts`), but a custom
 * Pino destination stream captures every line so we can assert on the
 * structured fields without going through stdout/stderr.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

import {
  setLogContext,
  getLogContext,
  withLogContext,
  logger,
} from "../../src/lib/logger.js";
import { requestContextMiddleware } from "../../src/middleware/request-context.js";
import type { AppVariables } from "../../src/types/hono.js";

describe("logger context (AsyncLocalStorage)", () => {
  it("withLogContext exposes seeded fields via getLogContext", () => {
    withLogContext({ requestId: "r1", method: "GET", path: "/x" }, () => {
      expect(getLogContext()).toEqual({
        requestId: "r1",
        method: "GET",
        path: "/x",
      });
    });
  });

  it("setLogContext merges into the active store", () => {
    withLogContext({ requestId: "r1" }, () => {
      setLogContext({ taskId: "t1", projectId: "p1" });
      expect(getLogContext()).toMatchObject({
        requestId: "r1",
        taskId: "t1",
        projectId: "p1",
      });
    });
  });

  it("setLogContext outside a scope is a no-op (does not throw)", () => {
    expect(() => setLogContext({ taskId: "leaked" })).not.toThrow();
    expect(getLogContext()).toEqual({});
  });

  it("scopes are isolated across concurrent withLogContext calls", async () => {
    const seen: string[] = [];
    await Promise.all([
      withLogContext({ requestId: "a" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(getLogContext().requestId ?? "?");
      }),
      withLogContext({ requestId: "b" }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(getLogContext().requestId ?? "?");
      }),
    ]);
    expect(seen.sort()).toEqual(["a", "b"]);
  });
});

describe("requestContextMiddleware", () => {
  function makeApp(handler: (c: any) => Response | Promise<Response>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requestContextMiddleware);
    app.get("/x", handler);
    return app;
  }

  it("mints a requestId when none is provided and echoes it as X-Request-Id", async () => {
    let captured: string | undefined;
    const app = makeApp((c) => {
      captured = getLogContext().requestId;
      return c.json({ ok: true });
    });

    const res = await app.request("/x");
    expect(res.status).toBe(200);
    const echoed = res.headers.get("X-Request-Id");
    expect(echoed).toBeTruthy();
    expect(echoed).toBe(captured);
  });

  it("honors an inbound X-Request-Id header within the length cap", async () => {
    let captured: string | undefined;
    const app = makeApp((c) => {
      captured = getLogContext().requestId;
      return c.json({ ok: true });
    });

    const res = await app.request("/x", {
      headers: { "X-Request-Id": "external-trace-123" },
    });
    expect(captured).toBe("external-trace-123");
    expect(res.headers.get("X-Request-Id")).toBe("external-trace-123");
  });

  it("ignores an oversized inbound X-Request-Id and mints a fresh UUID", async () => {
    let captured: string | undefined;
    const app = makeApp((c) => {
      captured = getLogContext().requestId;
      return c.json({ ok: true });
    });

    const oversized = "x".repeat(101);
    const res = await app.request("/x", {
      headers: { "X-Request-Id": oversized },
    });
    expect(captured).not.toBe(oversized);
    // RFC4122-ish — 36 chars with 4 hyphens.
    expect(captured).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("X-Request-Id")).toBe(captured);
  });

  it("rejects an inbound X-Request-Id whose chars fall outside [A-Za-z0-9._-]", async () => {
    let captured: string | undefined;
    const app = makeApp((c) => {
      captured = getLogContext().requestId;
      return c.json({ ok: true });
    });

    // Header values with CR/LF are blocked by the fetch runtime itself; what
    // reaches the middleware is anything that's a *valid* header but still
    // surprising in a log line — angle brackets, spaces, semicolons, etc.
    const surprising = "abc<script>def";
    const res = await app.request("/x", {
      headers: { "X-Request-Id": surprising },
    });
    expect(captured).not.toBe(surprising);
    expect(captured).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("X-Request-Id")).toBe(captured);
  });

  it("propagates actorId stamped by upstream middleware to the handler scope", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requestContextMiddleware);
    // Stand-in for the real authMiddleware: stamps the log context BEFORE
    // calling next() so handler-emitted logs see the actor fields. This is
    // the exact ordering authMiddleware now uses (post-review fix to PR
    // #196 finding 1).
    app.use("*", async (_c, next) => {
      setLogContext({ actorId: "agent-42", actorType: "agent" });
      await next();
    });

    let captured: { actorId?: string; actorType?: string } | undefined;
    app.get("/x", (c) => {
      captured = getLogContext();
      return c.json({ ok: true });
    });

    const res = await app.request("/x");
    expect(res.status).toBe(200);
    expect(captured).toMatchObject({ actorId: "agent-42", actorType: "agent" });
  });

  it("routes the access line by status class (5xx→error, 401/403→warn, other 4xx→debug, 2xx→info)", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requestContextMiddleware);

    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => logger);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

    app.get("/notFound", (c) => c.json({ error: "missing" }, 404));
    app.get("/unauthed", (c) => c.json({ error: "auth" }, 401));
    app.get("/forbidden", (c) => c.json({ error: "no" }, 403));
    app.get("/serverErr", (c) => c.json({ error: "boom" }, 500));
    app.get("/ok", (c) => c.json({ ok: true }));

    await app.request("/notFound");
    await app.request("/unauthed");
    await app.request("/forbidden");
    await app.request("/serverErr");
    await app.request("/ok");

    expect(debugSpy).toHaveBeenCalledTimes(1); // 404
    expect(warnSpy).toHaveBeenCalledTimes(2); // 401 + 403
    expect(errorSpy).toHaveBeenCalledTimes(1); // 500
    expect(infoSpy).toHaveBeenCalledTimes(1); // 200

    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("suppresses access logging for /api/health on 2xx but still logs on 5xx", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requestContextMiddleware);

    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

    app.get("/api/health", (c) => c.json({ ok: true }));
    app.get("/api/healthBroken", (c) => c.json({ err: 1 }, 500));

    await app.request("/api/health"); // suppressed
    // A 500 from a route happens to share the prefix to prove the silence
    // logic is path-equality, not prefix-based.
    await app.request("/api/healthBroken");

    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
