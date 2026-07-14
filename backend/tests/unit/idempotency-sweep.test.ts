/**
 * Unit tests for the idempotency TTL sweep (services/idempotency-sweep.ts).
 *
 * Follow-up from PR #372 (M2 webhook idempotency): both `webhook_deliveries`
 * and `tool_invocations` grow unbounded without a reaper. Covers:
 * 1. `sweepIdempotencyTables` deletes rows older than the retention window
 *    from both tables and retains fresh rows (via the mocked deleteMany
 *    `where` predicate, matching the repo's prisma-mock test pattern).
 * 2. The default retention comes from config.IDEMPOTENCY_TTL_DAYS.
 * 3. `scheduleIdempotencySweep` fires on the configured interval and the
 *    in-flight guard skips an overlapping tick.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-must-be-32chars!!",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    IDEMPOTENCY_TTL_DAYS: 30,
  },
}));

const { mockWebhookDeliveryDeleteMany, mockToolInvocationDeleteMany } = vi.hoisted(() => ({
  mockWebhookDeliveryDeleteMany: vi.fn(),
  mockToolInvocationDeleteMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    webhookDelivery: { deleteMany: mockWebhookDeliveryDeleteMany },
    toolInvocation: { deleteMany: mockToolInvocationDeleteMany },
  },
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { sweepIdempotencyTables, scheduleIdempotencySweep } from "../../src/services/idempotency-sweep.js";
import { logger } from "../../src/lib/logger.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockWebhookDeliveryDeleteMany.mockResolvedValue({ count: 0 });
  mockToolInvocationDeleteMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  // Each scheduling test starts its own setInterval; clear pending fake
  // timers before switching back so a leftover interval from one test
  // can't tick (and flip the in-flight guard) during a later test.
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("sweepIdempotencyTables", () => {
  it("deletes rows older than the retention window from both tables", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00Z"));

    mockWebhookDeliveryDeleteMany.mockResolvedValue({ count: 3 });
    mockToolInvocationDeleteMany.mockResolvedValue({ count: 5 });

    const result = await sweepIdempotencyTables(30);

    const expectedCutoff = new Date("2026-06-14T00:00:00Z");

    expect(mockWebhookDeliveryDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expectedCutoff } },
    });
    expect(mockToolInvocationDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expectedCutoff } },
    });
    expect(result).toEqual({ webhookDeliveries: 3, toolInvocations: 5 });
  });

  it("uses config.IDEMPOTENCY_TTL_DAYS as the default retention", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00Z"));

    await sweepIdempotencyTables();

    const expectedCutoff = new Date("2026-06-14T00:00:00Z"); // 30-day default

    expect(mockWebhookDeliveryDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expectedCutoff } },
    });
  });

  it("retains rows newer than the cutoff (deleteMany predicate excludes them)", async () => {
    // The predicate itself is the retention boundary — deleteMany only
    // matches rows with createdAt strictly before the cutoff, so a row
    // created after the cutoff is never targeted. Assert the exact
    // predicate shape rather than round-tripping through a fake DB, since
    // this suite mocks prisma like the sibling idempotency tests do.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00Z"));

    await sweepIdempotencyTables(1);

    const call = mockWebhookDeliveryDeleteMany.mock.calls[0][0];
    const cutoff: Date = call.where.createdAt.lt;
    const freshRowCreatedAt = new Date("2026-07-14T00:00:00Z"); // now, i.e. not stale
    const staleRowCreatedAt = new Date("2026-07-12T00:00:00Z"); // 2 days old, older than 1-day retention

    expect(freshRowCreatedAt.getTime()).toBeGreaterThanOrEqual(cutoff.getTime());
    expect(staleRowCreatedAt.getTime()).toBeLessThan(cutoff.getTime());
  });

  it("logs a summary only when rows were actually pruned", async () => {
    mockWebhookDeliveryDeleteMany.mockResolvedValue({ count: 0 });
    mockToolInvocationDeleteMany.mockResolvedValue({ count: 0 });

    await sweepIdempotencyTables(30);
    expect(logger.info).not.toHaveBeenCalled();

    mockWebhookDeliveryDeleteMany.mockResolvedValue({ count: 1 });
    await sweepIdempotencyTables(30);
    expect(logger.info).toHaveBeenCalledOnce();
  });
});

describe("scheduleIdempotencySweep", () => {
  it("runs a sweep on every interval tick", async () => {
    vi.useFakeTimers();

    const handle = scheduleIdempotencySweep(1_000, 30);

    expect(mockWebhookDeliveryDeleteMany).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockWebhookDeliveryDeleteMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockWebhookDeliveryDeleteMany).toHaveBeenCalledTimes(2);

    clearInterval(handle);
  });

  it("skips an overlapping tick while the previous sweep is still in flight", async () => {
    vi.useFakeTimers();

    let resolveDelete!: (v: { count: number }) => void;
    // Only the first call hangs; once it resolves, later calls fall back
    // to the resolved default from beforeEach. This keeps the un-awaited
    // interval (still running until we clearInterval below) from hanging
    // forever and leaking an in-flight guard into later tests.
    mockWebhookDeliveryDeleteMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );
    mockToolInvocationDeleteMany.mockResolvedValue({ count: 0 });

    const handle = scheduleIdempotencySweep(1_000, 30);

    // First tick starts and hangs (deleteMany not yet resolved).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockWebhookDeliveryDeleteMany).toHaveBeenCalledTimes(1);

    // Second tick fires while the first is still in flight — the guard
    // must skip it rather than starting a second overlapping sweep.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockWebhookDeliveryDeleteMany).toHaveBeenCalledTimes(1);

    // Let the first sweep finish, then a subsequent tick should run again.
    resolveDelete({ count: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockWebhookDeliveryDeleteMany).toHaveBeenCalledTimes(2);

    clearInterval(handle);
  });

  it("logs and does not throw when a sweep tick fails", async () => {
    vi.useFakeTimers();
    mockWebhookDeliveryDeleteMany.mockRejectedValueOnce(new Error("db down"));

    const handle = scheduleIdempotencySweep(1_000, 30);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(logger.error).toHaveBeenCalledOnce();

    // Guard is released even after a failure — the next tick runs.
    mockWebhookDeliveryDeleteMany.mockResolvedValue({ count: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockWebhookDeliveryDeleteMany).toHaveBeenCalledTimes(2);

    clearInterval(handle);
  });
});
