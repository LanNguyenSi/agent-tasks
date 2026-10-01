import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

// The rate-limit middleware reads config.TRUSTED_PROXY_HOPS at import time and
// the real config loader exits the process without DATABASE_URL / SESSION_SECRET.
// Stub it like the rate-limit unit suite does; hop count 0 is the secure default.
vi.mock("../../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-must-be-32chars!!",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    TRUSTED_PROXY_HOPS: 0,
  },
}));

import { rateLimit } from "../../src/middleware/rate-limit.js";
import { startNodeServer, type RunningServer } from "../helpers/node-server.js";

// These tests drive the app through serve() from @hono/node-server on an
// ephemeral port, so the adapter's real socket binding and streaming path are
// covered. Every other backend suite calls app.fetch() directly and would not
// notice an adapter regression.

const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

let running: RunningServer | undefined;
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  await running?.close();
  running = undefined;
});

describe("node-server adapter: peer address", () => {
  it("getConnInfo resolves the real loopback peer address over a socket", async () => {
    const app = new Hono();
    app.get("/peer", (c) => c.json({ address: getConnInfo(c).remote.address ?? null }));
    running = await startNodeServer(app);

    const res = await fetch(`${running.url}/peer`);
    const body = (await res.json()) as { address: string | null };
    expect(LOOPBACK).toContain(body.address);
  });

  it("rateLimit keys on the real peer address, not the 'unknown' fallback", async () => {
    // The limiter store is module-global and keyed `${ip}:${path}`. A request
    // that reaches the app without a socket (app.fetch, no env) is keyed
    // `unknown:<path>`. With max 1, if the socket request were also keyed
    // 'unknown' the in-process request below would be the second hit and get
    // 429. A 200 there proves the socket request landed in a different bucket.
    const app = new Hono();
    app.use("/limited", rateLimit({ windowMs: 60_000, max: 1 }));
    app.get("/limited", (c) => c.text("ok"));
    running = await startNodeServer(app);

    const viaSocket = await fetch(`${running.url}/limited`);
    expect(viaSocket.status).toBe(200);

    const viaSocketAgain = await fetch(`${running.url}/limited`);
    expect(viaSocketAgain.status).toBe(429);

    const noSocket = await app.fetch(new Request("http://test/limited"));
    expect(noSocket.status).toBe(200);
    // And the unknown bucket is genuinely its own: a second in-process hit trips it.
    const noSocketAgain = await app.fetch(new Request("http://test/limited"));
    expect(noSocketAgain.status).toBe(429);
  });
});

describe("node-server adapter: streaming", () => {
  it("delivers chunks to the client before the server ends the stream", async () => {
    // Deterministic handshake, no millisecond thresholds. The server emits a
    // chunk, then withholds the next one (and the stream end) until the client
    // confirms it read the previous one. A response that is buffered before it
    // is sent can never get past the first gate, so the client times out.
    const encoder = new TextEncoder();
    let serverEnded = false;
    let ackFirst!: () => void;
    let ackSecond!: () => void;
    const firstRead = new Promise<void>((r) => (ackFirst = r));
    const secondRead = new Promise<void>((r) => (ackSecond = r));
    // On any failure path, release the gates so the server side finishes.
    cleanups.push(ackFirst, ackSecond);

    const app = new Hono();
    app.get("/stream", () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("one"));
          await firstRead;
          controller.enqueue(encoder.encode("two"));
          await secondRead;
          serverEnded = true;
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain" } });
    });
    running = await startNodeServer(app);

    const withDeadline = <T>(p: Promise<T>, what: string): Promise<T> => {
      let timer: NodeJS.Timeout;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}: response is not streamed incrementally`)),
          3_000,
        );
      });
      return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
    };

    const res = await withDeadline(fetch(`${running.url}/stream`), "response headers");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const first = await withDeadline(reader.read(), "first chunk");
    expect(decoder.decode(first.value)).toBe("one");
    expect(first.done).toBe(false);
    expect(serverEnded).toBe(false);
    ackFirst();

    const second = await withDeadline(reader.read(), "second chunk");
    expect(decoder.decode(second.value)).toBe("two");
    expect(second.done).toBe(false);
    // Two reads have landed and the server is still holding the stream open.
    expect(serverEnded).toBe(false);
    ackSecond();

    const last = await withDeadline(reader.read(), "stream end");
    expect(last.done).toBe(true);
    expect(serverEnded).toBe(true);
  });
});
