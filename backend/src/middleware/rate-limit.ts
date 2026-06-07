import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "../config/index.js";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store. Single-instance only: behind a multi-pod deployment each
// pod keeps its own counters, so the effective cap is `max * pods`. Use a
// shared store (e.g. Redis) if a strict global limit is required.
const store = new Map<string, RateLimitEntry>();

// Cleanup expired entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}, 60_000).unref();

/**
 * Resolve the rate-limit key IP without trusting client-controlled input.
 *
 * X-Forwarded-For is appended-to by each proxy in the chain, so only the
 * rightmost `trustedProxyHops` entries are written by infrastructure we
 * control; every entry to their left is attacker-supplied. Trusting the
 * leftmost entry (the previous behavior) let a client rotate spoofed
 * `X-Forwarded-For` values to mint a fresh bucket per request and bypass the
 * limit entirely.
 *
 * With `trustedProxyHops > 0` we read the entry contributed by the outermost
 * trusted proxy (index `length - hops`). With 0 (the default) we ignore
 * X-Forwarded-For and use the raw socket peer address, which a client cannot
 * forge.
 */
function clientIp(c: Context, trustedProxyHops: number): string {
  if (trustedProxyHops > 0) {
    const parts = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const idx = Math.max(0, parts.length - trustedProxyHops);
      const fromXff = parts[idx];
      if (fromXff) return fromXff;
    }
  }

  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // No Node socket is bound (e.g. unit tests calling app.fetch without an
    // env). Fall back to a shared bucket rather than throwing.
    return "unknown";
  }
}

export function rateLimit({
  windowMs = 60_000,
  max = 20,
  trustedProxyHops = config.TRUSTED_PROXY_HOPS,
}: { windowMs?: number; max?: number; trustedProxyHops?: number } = {}) {
  return async (c: Context, next: Next) => {
    const ip = clientIp(c, trustedProxyHops);
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      return c.json(
        { error: "rate_limited", message: "Too many requests, please try again later" },
        429,
      );
    }

    return next();
  };
}
