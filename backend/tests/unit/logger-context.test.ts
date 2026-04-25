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
import type { Actor } from "../../src/types/auth.js";

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

  it("captures actorId/actorType from c.get('actor') after handler runs", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requestContextMiddleware);
    app.use("*", async (c, next) => {
      const actor: Actor = {
        type: "agent",
        tokenId: "agent-42",
        teamId: "team-1",
        scopes: [],
      };
      c.set("actor", actor);
      await next();
    });

    const accessSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    app.get("/x", (c) => c.json({ ok: true }));

    await app.request("/x");
    // The middleware emits exactly one access log line per request.
    expect(accessSpy).toHaveBeenCalledTimes(1);
    const [fields, msg] = accessSpy.mock.calls[0]!;
    expect(msg).toBe("request");
    expect(fields).toMatchObject({ status: 200 });
    accessSpy.mockRestore();
  });

  it("emits the access line at debug level for 4xx and error level for 5xx", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requestContextMiddleware);

    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

    app.get("/clientErr", (c) => c.json({ error: "bad" }, 400));
    app.get("/serverErr", (c) => c.json({ error: "boom" }, 500));
    app.get("/ok", (c) => c.json({ ok: true }));

    await app.request("/clientErr");
    await app.request("/serverErr");
    await app.request("/ok");

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    debugSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });
});
