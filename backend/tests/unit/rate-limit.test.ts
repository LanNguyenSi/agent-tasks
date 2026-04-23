import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { rateLimit } from "../../src/middleware/rate-limit.js";

async function fire(app: Hono, path: string, ip = "1.2.3.4"): Promise<Response> {
  return app.fetch(
    new Request(`http://test${path}`, {
      headers: { "x-forwarded-for": ip },
    }),
  );
}

describe("rateLimit middleware", () => {
  it("rejects with 429 once the cap is exceeded within the window", async () => {
    const app = new Hono();
    app.use("/guarded", rateLimit({ windowMs: 60_000, max: 3 }));
    app.get("/guarded", (c) => c.text("ok"));

    const results = await Promise.all([
      fire(app, "/guarded"),
      fire(app, "/guarded"),
      fire(app, "/guarded"),
      fire(app, "/guarded"),
    ]);

    const statuses = results.map((r) => r.status);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
    const body = (await results[3].json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("partitions by IP — a second client is not affected by the first's usage", async () => {
    const app = new Hono();
    app.use("/guarded", rateLimit({ windowMs: 60_000, max: 1 }));
    app.get("/guarded", (c) => c.text("ok"));

    expect((await fire(app, "/guarded", "1.1.1.1")).status).toBe(200);
    expect((await fire(app, "/guarded", "1.1.1.1")).status).toBe(429);
    expect((await fire(app, "/guarded", "2.2.2.2")).status).toBe(200);
  });

  it("exposes X-RateLimit-* headers on every response", async () => {
    const app = new Hono();
    app.use("/headers-guarded", rateLimit({ windowMs: 60_000, max: 5 }));
    app.get("/headers-guarded", (c) => c.text("ok"));

    const res = await fire(app, "/headers-guarded", "9.9.9.9");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(res.headers.get("X-RateLimit-Reset")).toMatch(/^\d+$/);
  });

  it("resets the count once the window elapses", async () => {
    const app = new Hono();
    app.use("/window-guarded", rateLimit({ windowMs: 50, max: 1 }));
    app.get("/window-guarded", (c) => c.text("ok"));

    expect((await fire(app, "/window-guarded", "4.4.4.4")).status).toBe(200);
    expect((await fire(app, "/window-guarded", "4.4.4.4")).status).toBe(429);
    await new Promise((r) => setTimeout(r, 70));
    expect((await fire(app, "/window-guarded", "4.4.4.4")).status).toBe(200);
  });

  it("groups requests with missing XFF under a single 'unknown' bucket", async () => {
    // Documented consequence of the current XFF-only keying: behind a
    // correctly configured Traefik this never fires, but if requests ever
    // reach the backend without XFF they share a bucket. Lock the behavior.
    const app = new Hono();
    app.use("/xff-guarded", rateLimit({ windowMs: 60_000, max: 2 }));
    app.get("/xff-guarded", (c) => c.text("ok"));

    const noXff = () => app.fetch(new Request("http://test/xff-guarded"));
    expect((await noXff()).status).toBe(200);
    expect((await noXff()).status).toBe(200);
    expect((await noXff()).status).toBe(429);
  });
});
