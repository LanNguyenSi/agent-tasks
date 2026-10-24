/**
 * Pins the zod 4 format primitives the migration chose, so an accidental switch
 * to a stricter/simpler v4 default fails here rather than silently narrowing or
 * widening a request field's accept-set (contract 4).
 *
 *   z.guid()      keeps the v3 `.uuid()` accept set (any 8-4-4-4-12 hex, no RFC
 *                 9562 version/variant enforcement) — v4 `z.uuid()` would reject
 *                 ids like the all-zero-variant one below.
 *   z.url()       v4 home of v3 `.url()` (scheme-carrying URLs incl. postgres/
 *                 redis pass; spaces and bare authorities fail).
 *   z.iso.datetime() v4 home of v3 `.datetime()` (Z-suffixed instants, optional
 *                 fractional seconds; offsets and bare local times rejected).
 *   z.email()     v4 home of v3 `.email()` (accepts the same set used by auth).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("zod 4 format accept-sets (migration contract 4)", () => {
  it("z.guid accepts a non-RFC-variant hex id and rejects a non-guid", () => {
    expect(z.guid().safeParse("00000000-0000-0000-0000-000000000001").success).toBe(true);
    expect(z.guid().safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(true);
    expect(z.guid().safeParse("task-1").success).toBe(false);
    expect(z.guid().safeParse("not-a-guid").success).toBe(false);
  });

  it("z.url accepts scheme-carrying URLs and rejects non-URLs", () => {
    expect(z.url().safeParse("postgresql://u:p@localhost:5432/db").success).toBe(true);
    expect(z.url().safeParse("redis://localhost:6379").success).toBe(true);
    expect(z.url().safeParse("http://example.com/path?q=1").success).toBe(true);
    expect(z.url().safeParse("not a url").success).toBe(false);
    expect(z.url().safeParse("example.com").success).toBe(false);
  });

  it("z.iso.datetime requires the Z suffix and rejects offsets and local times", () => {
    expect(z.iso.datetime().safeParse("2020-01-01T00:00:00Z").success).toBe(true);
    expect(z.iso.datetime().safeParse("2020-01-01T00:00:00.123Z").success).toBe(true);
    expect(z.iso.datetime().safeParse("2020-01-01T00:00:00+01:00").success).toBe(false);
    expect(z.iso.datetime().safeParse("2020-01-01 00:00:00Z").success).toBe(false);
    expect(z.iso.datetime().safeParse("2020-01-01").success).toBe(false);
  });

  it("z.email accepts the auth set and rejects obvious non-emails", () => {
    for (const ok of ["u@e.com", "1@evil.com", "github.com@evil.test", "user+tag@example.com"]) {
      expect(z.email().safeParse(ok).success).toBe(true);
    }
    for (const bad of ["plainaddress", "user@@example.com", "@example.com", "user @example.com"]) {
      expect(z.email().safeParse(bad).success).toBe(false);
    }
  });
});
