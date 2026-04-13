/**
 * Unit tests for the `Cache<T>` abstraction. Only the InMemoryCache
 * backend is exercised here — the RedisCache backend lives behind a
 * `REDIS_TEST_URL` env var and is tested in `cache.redis.test.ts` so
 * CI can keep running without a redis service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCache, InMemoryCache } from "../../src/services/cache.js";

describe("InMemoryCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a value within TTL", async () => {
    const cache = new InMemoryCache<{ v: number }>(10);
    await cache.set("k", { v: 1 }, 1_000);
    expect(await cache.get("k")).toEqual({ v: 1 });
  });

  it("returns undefined on a miss", async () => {
    const cache = new InMemoryCache<number>(10);
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("expires entries after the TTL elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const cache = new InMemoryCache<string>(10);
    await cache.set("k", "v", 500);

    vi.setSystemTime(new Date(1_000_000 + 499));
    expect(await cache.get("k")).toBe("v");

    vi.setSystemTime(new Date(1_000_000 + 501));
    expect(await cache.get("k")).toBeUndefined();
  });

  it("cleans up expired entries on access", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const cache = new InMemoryCache<string>(10);
    await cache.set("k", "v", 500);
    vi.setSystemTime(new Date(1_000_000 + 501));
    await cache.get("k"); // triggers delete
    expect(await cache.size()).toBe(0);
  });

  it("evicts the oldest entry when the max-entries budget is hit", async () => {
    const cache = new InMemoryCache<number>(3);
    await cache.set("a", 1, 10_000);
    await cache.set("b", 2, 10_000);
    await cache.set("c", 3, 10_000);
    expect(await cache.size()).toBe(3);

    // Inserting a new key evicts "a" (FIFO).
    await cache.set("d", 4, 10_000);
    expect(await cache.size()).toBe(3);
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBe(2);
    expect(await cache.get("c")).toBe(3);
    expect(await cache.get("d")).toBe(4);
  });

  it("re-setting an existing key does NOT evict another entry", async () => {
    const cache = new InMemoryCache<number>(3);
    await cache.set("a", 1, 10_000);
    await cache.set("b", 2, 10_000);
    await cache.set("c", 3, 10_000);
    // Updating "a" must not drop "a" as the oldest then re-insert it at
    // the end, which would silently lose "b".
    await cache.set("a", 99, 10_000);
    expect(await cache.size()).toBe(3);
    expect(await cache.get("a")).toBe(99);
    expect(await cache.get("b")).toBe(2);
    expect(await cache.get("c")).toBe(3);
  });

  it("clear() empties the cache", async () => {
    const cache = new InMemoryCache<number>(10);
    await cache.set("a", 1, 10_000);
    await cache.set("b", 2, 10_000);
    await cache.clear();
    expect(await cache.size()).toBe(0);
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeUndefined();
  });

  it("uses an injectable clock for deterministic expiry in tests", async () => {
    let t = 0;
    const cache = new InMemoryCache<string>(10, () => t);
    await cache.set("k", "v", 100);
    t = 50;
    expect(await cache.get("k")).toBe("v");
    t = 101;
    expect(await cache.get("k")).toBeUndefined();
  });
});

describe("getCache factory", () => {
  // The factory reads REDIS_URL via process.env on every call — no
  // module-level caching of the env value — so just wiping the var
  // here is enough to force the InMemoryCache path.
  beforeEach(() => {
    delete process.env.REDIS_URL;
  });

  it("returns an InMemoryCache when REDIS_URL is unset", async () => {
    const cache = await getCache<string>("test", { maxEntries: 5 });
    expect(cache).toBeInstanceOf(InMemoryCache);
    await cache.set("k", "v", 1_000);
    expect(await cache.get("k")).toBe("v");
  });

  it("honours the maxEntries option", async () => {
    const cache = await getCache<number>("test2", { maxEntries: 2 });
    await cache.set("a", 1, 10_000);
    await cache.set("b", 2, 10_000);
    await cache.set("c", 3, 10_000);
    expect(await cache.size()).toBe(2);
    expect(await cache.get("a")).toBeUndefined();
  });
});
