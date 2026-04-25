/**
 * TTL cache abstraction with two backends:
 *
 * - `InMemoryCache<T>`: per-process Map with FIFO eviction. Matches the
 *   behaviour the legacy `github-checks.ts` in-memory cache had, so
 *   single-instance deploys keep their old semantics.
 * - `RedisCache<T>`: ioredis-backed `SET key value PX ttl` with JSON
 *   round-trip. Horizontal-scale safe: every backend pod sees the same
 *   values, so GitHub API hit rate stays 1/N × request rate rather than
 *   fanning out linearly by pod count.
 *
 * The factory `getCache(namespace)` picks the backend based on
 * `config.REDIS_URL`. When unset, callers get an InMemoryCache — no
 * connection attempt, no ioredis import side effects. When set, the
 * ioredis client is instantiated lazily on first access and reused.
 *
 * ## Failure mode for Redis
 *
 * Every `get`/`set` on `RedisCache` is wrapped: a transport error is
 * logged and translated into a *cache miss* (for get) or a silent drop
 * (for set). A request never fails because Redis is unhealthy — it just
 * pays the underlying cost (GitHub API call, recomputation, …). That's
 * the whole point of a cache: graceful degradation, not a new single
 * point of failure.
 *
 * ## Serialization caveat
 *
 * `RedisCache` uses `JSON.stringify` / `JSON.parse`. Callers must not
 * store `Date` objects, `Map`/`Set` instances, `BigInt`, or circular
 * structures — all the usual JSON limits apply. For `github-checks.ts`
 * the values are plain records of strings/numbers/booleans, so this is
 * safe today.
 */

// Type-only import: stripped by tsc, so this does NOT force ioredis onto
// the runtime module graph. The actual ioredis module is pulled in via
// the dynamic `await import("ioredis")` inside `getRedisClient` only
// when REDIS_URL is configured.
import type { Redis as RedisClient } from "ioredis";
import { logger } from "../lib/logger.js";

// NOTE: this module intentionally reads Redis env vars directly via
// `process.env` instead of importing `config/index.js`. The config
// module performs a strict zod parse at import time — any test that
// transitively imports cache.ts would then need a full test `.env`
// set up. Redis config is narrow, optional, and doesn't benefit from
// the full zod pipeline, so reading it ad-hoc keeps the test surface
// small.
function readRedisUrl(): string | undefined {
  const url = process.env.REDIS_URL;
  return url && url.length > 0 ? url : undefined;
}

function readRedisKeyPrefix(): string {
  return process.env.REDIS_KEY_PREFIX ?? "agent-tasks:";
}

export interface Cache<T> {
  /**
   * Fetch a value by key. Returns `undefined` on miss, expired entry,
   * or backend error — never throws on a Redis transport failure.
   */
  get(key: string): Promise<T | undefined>;
  /**
   * Store a value with a TTL in milliseconds. Silently drops on
   * backend error so a cache-write failure never fails a request.
   */
  set(key: string, value: T, ttlMs: number): Promise<void>;
  /**
   * Remove every entry visible at the start of the call. Used by tests
   * and by force-invalidation paths. For Redis this means SCAN + DEL on
   * the namespace, which is O(n) and NOT atomic — a concurrent `set`
   * during the drain may survive the clear. Don't use this for
   * correctness-critical invalidation.
   */
  clear(): Promise<void>;
  /**
   * Current entry count. Present for test introspection. Returns `-1`
   * on backends that cannot count efficiently (Redis SCAN is O(n) and
   * we don't want to make it look like an O(1) operation).
   */
  size(): Promise<number>;
}

interface InMemoryEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Per-process cache with FIFO eviction once the entry budget is hit.
 * Map iteration order is insertion order, so dropping the first key is
 * the oldest insertion — cheap O(1) eviction.
 */
export class InMemoryCache<T> implements Cache<T> {
  private readonly entries = new Map<string, InMemoryEntry<T>>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<T | undefined> {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() > hit.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async set(key: string, value: T, ttlMs: number): Promise<void> {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) this.entries.delete(firstKey);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  async size(): Promise<number> {
    return this.entries.size;
  }
}

/**
 * Redis-backed Cache<T>. Values are JSON-serialized; TTL is passed to
 * Redis as PX so expiry is the server's responsibility and no manual
 * sweep is needed.
 *
 * `clear()` deletes every key under the instance's namespace via SCAN
 * + DEL. Safe for small namespaces (the github-checks cache is
 * capped at ~2000 entries); callers that need a high-volume clear
 * should invalidate by key instead.
 */
export class RedisCache<T> implements Cache<T> {
  constructor(
    private readonly client: RedisClient,
    /** Fully qualified namespace: `${REDIS_KEY_PREFIX}${namespace}:`. */
    private readonly namespace: string,
    private readonly logger: (err: unknown, op: string) => void = defaultLog,
  ) {}

  private prefixed(key: string): string {
    return `${this.namespace}${key}`;
  }

  async get(key: string): Promise<T | undefined> {
    try {
      const raw = await this.client.get(this.prefixed(key));
      if (raw === null) return undefined;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger(err, "cache.get");
      return undefined;
    }
  }

  async set(key: string, value: T, ttlMs: number): Promise<void> {
    try {
      await this.client.set(
        this.prefixed(key),
        JSON.stringify(value),
        "PX",
        ttlMs,
      );
    } catch (err) {
      this.logger(err, "cache.set");
    }
  }

  async clear(): Promise<void> {
    try {
      const pattern = `${this.namespace}*`;
      const stream = this.client.scanStream({ match: pattern, count: 100 });
      const toDelete: string[] = [];
      for await (const keys of stream as AsyncIterable<string[]>) {
        if (keys.length > 0) toDelete.push(...keys);
      }
      if (toDelete.length > 0) {
        await this.client.del(...toDelete);
      }
    } catch (err) {
      this.logger(err, "cache.clear");
    }
  }

  async size(): Promise<number> {
    // Redis doesn't count keys under a prefix cheaply. Returning -1
    // signals "unknown" rather than lying with a zero.
    return -1;
  }
}

function defaultLog(err: unknown, op: string): void {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn({ component: "cache", op, errMessage: message }, "cache op failed");
}

// ── Factory ────────────────────────────────────────────────────────────────

// Store the in-flight promise (not the resolved client) so two parallel
// first-time callers both await the same construction rather than each
// racing into `new Redis(...)` and leaking a socket. Resolved value
// stays cached for the lifetime of the process.
let sharedRedisClientPromise: Promise<RedisClient> | null = null;

/**
 * Lazily create (and cache) the shared ioredis client. Dynamic import
 * of `ioredis` keeps it off the module graph when REDIS_URL is unset —
 * local dev and the test suite don't pay the connection cost or hold
 * open sockets at module load.
 */
function getRedisClient(): Promise<RedisClient> | null {
  const url = readRedisUrl();
  if (!url) return null;
  if (sharedRedisClientPromise) return sharedRedisClientPromise;
  sharedRedisClientPromise = (async () => {
    const { default: Redis } = await import("ioredis");
    return new Redis(url, {
      // Don't retry forever — fail fast into cache-miss semantics.
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: false,
    });
  })();
  return sharedRedisClientPromise;
}

/**
 * Return a Cache<T> for the given namespace. Picks RedisCache when
 * REDIS_URL is configured, InMemoryCache otherwise. Safe to call
 * multiple times per namespace — in-memory callers get a fresh Map
 * each time, which is exactly what the legacy github-checks behaviour
 * wanted (module-level singletons per cache).
 */
export async function getCache<T>(
  namespace: string,
  opts: { maxEntries?: number } = {},
): Promise<Cache<T>> {
  const clientPromise = getRedisClient();
  if (!clientPromise) {
    return new InMemoryCache<T>(opts.maxEntries ?? 1000);
  }
  const client = await clientPromise;
  return new RedisCache<T>(
    client,
    `${readRedisKeyPrefix()}${namespace}:`,
  );
}
