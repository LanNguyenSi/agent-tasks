import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// The middleware now reads config.TRUSTED_PROXY_HOPS at import time, which
// loads config from the real env (process.exit(1) on missing DATABASE_URL /
// SESSION_SECRET in CI). Mock it like the other unit suites do; default the
// trusted-proxy hop count to 0 so the suite exercises the secure default.
vi.mock("../../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-must-be-32chars!!",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    TRUSTED_PROXY_HOPS: 0,
  },
}));

import { rateLimit } from "../../src/middleware/rate-limit.js";

// Minimal stand-in for the Node socket binding @hono/node-server exposes via
// c.env, so getConnInfo can resolve a peer address in unit tests.
function socketEnv(remoteAddress: string) {
  return { incoming: { socket: { remoteAddress, remoteFamily: "IPv4" } } };
}

async function fire(
  app: Hono,
  path: string,
  opts: { xff?: string; socket?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
  const env = opts.socket ? socketEnv(opts.socket) : undefined;
  return app.fetch(new Request(`http://test${path}`, { headers }), env);
}

describe("rateLimit middleware", () => {
  it("rejects with 429 once the cap is exceeded within the window", async () => {
    const app = new Hono();
    app.use("/guarded", rateLimit({ windowMs: 60_000, max: 3 }));
    app.get("/guarded", (c) => c.text("ok"));

    const results = await Promise.all([
      fire(app, "/guarded", { socket: "1.2.3.4" }),
      fire(app, "/guarded", { socket: "1.2.3.4" }),
      fire(app, "/guarded", { socket: "1.2.3.4" }),
      fire(app, "/guarded", { socket: "1.2.3.4" }),
    ]);

    const statuses = results.map((r) => r.status);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
    const body = (await results[3].json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("keys on the socket peer address by default, partitioning distinct clients", async () => {
    const app = new Hono();
    app.use("/guarded", rateLimit({ windowMs: 60_000, max: 1 }));
    app.get("/guarded", (c) => c.text("ok"));

    expect((await fire(app, "/guarded", { socket: "1.1.1.1" })).status).toBe(200);
    expect((await fire(app, "/guarded", { socket: "1.1.1.1" })).status).toBe(429);
    expect((await fire(app, "/guarded", { socket: "2.2.2.2" })).status).toBe(200);
  });

  it("ignores a spoofed X-Forwarded-For by default — one socket cannot mint fresh buckets", async () => {
    // Security regression: the pre-fix middleware keyed on the leftmost XFF
    // entry, so a client could rotate that value per request and never hit
    // the cap. With XFF ignored by default, every request from one socket
    // shares a bucket regardless of the forged header.
    const app = new Hono();
    app.use("/guarded", rateLimit({ windowMs: 60_000, max: 1 }));
    app.get("/guarded", (c) => c.text("ok"));

    expect(
      (await fire(app, "/guarded", { socket: "9.9.9.9", xff: "1.1.1.1" })).status,
    ).toBe(200);
    expect(
      (await fire(app, "/guarded", { socket: "9.9.9.9", xff: "2.2.2.2" })).status,
    ).toBe(429);
    expect(
      (await fire(app, "/guarded", { socket: "9.9.9.9", xff: "3.3.3.3" })).status,
    ).toBe(429);
  });

  it("with a trusted proxy hop, reads the client IP from the right of X-Forwarded-For", async () => {
    // trustedProxyHops=1 models a single Traefik hop appending the real
    // client IP as the rightmost entry. A spoofed leftmost entry does not
    // change the bucket; a different real client gets its own.
    const app = new Hono();
    app.use("/proxy-guarded", rateLimit({ windowMs: 60_000, max: 1, trustedProxyHops: 1 }));
    app.get("/proxy-guarded", (c) => c.text("ok"));

    expect((await fire(app, "/proxy-guarded", { xff: "1.1.1.1, 5.5.5.5" })).status).toBe(200);
    expect((await fire(app, "/proxy-guarded", { xff: "9.9.9.9, 5.5.5.5" })).status).toBe(429);
    expect((await fire(app, "/proxy-guarded", { xff: "1.1.1.1, 6.6.6.6" })).status).toBe(200);
  });

  it("exposes X-RateLimit-* headers on every response", async () => {
    const app = new Hono();
    app.use("/headers-guarded", rateLimit({ windowMs: 60_000, max: 5 }));
    app.get("/headers-guarded", (c) => c.text("ok"));

    const res = await fire(app, "/headers-guarded", { socket: "9.9.9.9" });
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(res.headers.get("X-RateLimit-Reset")).toMatch(/^\d+$/);
  });

  it("resets the count once the window elapses", async () => {
    const app = new Hono();
    app.use("/window-guarded", rateLimit({ windowMs: 50, max: 1 }));
    app.get("/window-guarded", (c) => c.text("ok"));

    expect((await fire(app, "/window-guarded", { socket: "4.4.4.4" })).status).toBe(200);
    expect((await fire(app, "/window-guarded", { socket: "4.4.4.4" })).status).toBe(429);
    await new Promise((r) => setTimeout(r, 70));
    expect((await fire(app, "/window-guarded", { socket: "4.4.4.4" })).status).toBe(200);
  });

  it("groups requests with no resolvable peer under a single 'unknown' bucket", async () => {
    // When neither a trusted-proxy XFF entry nor a socket address resolves
    // (e.g. a misconfigured deployment), requests share one bucket rather
    // than each getting a free pass.
    const app = new Hono();
    app.use("/unknown-guarded", rateLimit({ windowMs: 60_000, max: 2 }));
    app.get("/unknown-guarded", (c) => c.text("ok"));

    expect((await fire(app, "/unknown-guarded")).status).toBe(200);
    expect((await fire(app, "/unknown-guarded")).status).toBe(200);
    expect((await fire(app, "/unknown-guarded")).status).toBe(429);
  });
});
