/**
 * M5 (task 698eeb01) calibration telemetry.
 *
 * Covers:
 *   - `scoreBand` boundary pins (both edges of every named example band, plus
 *     the top-band 100 special case) — the acceptance criterion explicitly
 *     calls out pinning band boundaries on both sides.
 *   - `computeConfidenceTelemetryAggregates` against hand-built fixtures for
 *     all five aggregates the endpoint returns.
 *   - The fail-open contract of `recordBounceBack` / `recordTerminalSnapshot`:
 *     a DB error must be swallowed (logged, not thrown) so a telemetry write
 *     failure can never block the task_finish transition it rides with.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  confidenceTelemetryUpsert: vi.fn(),
  auditLogFindFirst: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    confidenceTelemetry: { upsert: prismaMocks.confidenceTelemetryUpsert },
    auditLog: { findFirst: prismaMocks.auditLogFindFirst },
  },
}));

const loggerMocks = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({ logger: { error: loggerMocks.error } }));

import {
  scoreBand,
  computeConfidenceTelemetryAggregates,
  recordBounceBack,
  recordTerminalSnapshot,
  LOW_SCORE_MAX,
  HIGH_SCORE_MIN,
  DONE_STATUS,
  type ConfidenceTelemetryRow,
  type ClaimEventRow,
} from "../../src/services/confidence-telemetry.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scoreBand — boundary pins (both edges of every named example band)", () => {
  it("60-70: 59 falls in the band below, 60 is the lower (inclusive) edge", () => {
    expect(scoreBand(59)).toBe("50-60");
    expect(scoreBand(60)).toBe("60-70");
  });
  it("60-70: 69 is still inside, 70 rolls into the next band (upper bound exclusive)", () => {
    expect(scoreBand(69)).toBe("60-70");
    expect(scoreBand(70)).toBe("70-80");
  });
  it("70-80: both edges", () => {
    expect(scoreBand(70)).toBe("70-80");
    expect(scoreBand(79)).toBe("70-80");
    expect(scoreBand(80)).toBe("80-90");
  });
  it("80-90: both edges", () => {
    expect(scoreBand(80)).toBe("80-90");
    expect(scoreBand(89)).toBe("80-90");
    expect(scoreBand(90)).toBe("90-100");
  });
  it("top band 90-100 is closed on both ends: 90 and 100 both land in it, there is no 100-110 band", () => {
    expect(scoreBand(90)).toBe("90-100");
    expect(scoreBand(99)).toBe("90-100");
    expect(scoreBand(100)).toBe("90-100");
  });
  it("bottom edge: 0 lands in 0-10", () => {
    expect(scoreBand(0)).toBe("0-10");
  });
});

describe("computeConfidenceTelemetryAggregates — fixture-driven", () => {
  // Fixture: two tasks per named example band, one done one not, plus a
  // still-in-flight (no finalStatus) row to prove it is excluded from
  // doneRateByScoreBand/lowScoreSuccesses/highScoreFailures but still counted
  // in bounceBackByScoreBand.
  const rows: ConfidenceTelemetryRow[] = [
    // low band (< LOW_SCORE_MAX=60): one success (counts toward lowScoreSuccesses), one failure
    { scoreAtClaim: 55, finalStatus: DONE_STATUS, bounceBackCount: 2 },
    { scoreAtClaim: 58, finalStatus: "abandoned", bounceBackCount: 0 },
    // mid band 60-70
    { scoreAtClaim: 65, finalStatus: DONE_STATUS, bounceBackCount: 1 },
    { scoreAtClaim: 69, finalStatus: DONE_STATUS, bounceBackCount: 3 },
    // mid band 70-80, one still in flight (no verdict yet)
    { scoreAtClaim: 72, finalStatus: null, bounceBackCount: 1 },
    // high band (>= HIGH_SCORE_MIN=90): one success, one failure (counts toward highScoreFailures)
    { scoreAtClaim: 95, finalStatus: DONE_STATUS, bounceBackCount: 0 },
    { scoreAtClaim: 92, finalStatus: "abandoned", bounceBackCount: 0 },
    // human claim / OFF-mode project — no scoreAtClaim on record, must be excluded entirely
    { scoreAtClaim: null, finalStatus: DONE_STATUS, bounceBackCount: 0 },
  ];

  const claimEvents: ClaimEventRow[] = [
    // Monday 2026-08-10 week: 2 evaluated claims, 1 override
    { action: "task.claim_confidence_recorded", createdAt: new Date("2026-08-10T12:00:00Z") },
    { action: "task.claim_override_used", createdAt: new Date("2026-08-11T09:00:00Z") },
    // Sunday 2026-08-16 is still the SAME ISO week as Monday 2026-08-10
    { action: "task.claim_would_block_shadow", createdAt: new Date("2026-08-16T23:00:00Z") },
    // Monday 2026-08-17 week: 1 evaluated claim, 0 overrides
    { action: "task.claim_blocked_low_readiness", createdAt: new Date("2026-08-17T00:00:00Z") },
  ];

  const aggregates = computeConfidenceTelemetryAggregates(rows, claimEvents);

  it("overrideRatePerWeek buckets by ISO week (Monday-start) and computes rate = overrides / totalClaims", () => {
    expect(aggregates.overrideRatePerWeek).toEqual([
      { weekStart: "2026-08-10", overrideCount: 1, totalClaims: 3, rate: 1 / 3 },
      { weekStart: "2026-08-17", overrideCount: 0, totalClaims: 1, rate: 0 },
    ]);
  });

  it("bounceBackByScoreBand groups by band, includes the still-in-flight row, sorted ascending", () => {
    expect(aggregates.bounceBackByScoreBand).toEqual([
      { band: "50-60", taskCount: 2, avgBounceBackCount: 1 }, // (2+0)/2
      { band: "60-70", taskCount: 2, avgBounceBackCount: 2 }, // (1+3)/2
      { band: "70-80", taskCount: 1, avgBounceBackCount: 1 },
      { band: "90-100", taskCount: 2, avgBounceBackCount: 0 },
    ]);
  });

  it("doneRateByScoreBand excludes the still-in-flight row (finalStatus null)", () => {
    expect(aggregates.doneRateByScoreBand).toEqual([
      { band: "50-60", taskCount: 2, doneRate: 0.5 },
      { band: "60-70", taskCount: 2, doneRate: 1 },
      // 70-80 band's only row has no finalStatus yet — must not appear here.
      { band: "90-100", taskCount: 2, doneRate: 0.5 },
    ]);
    expect(aggregates.doneRateByScoreBand.find((b) => b.band === "70-80")).toBeUndefined();
  });

  it("lowScoreSuccesses counts terminal tasks with score < LOW_SCORE_MAX and finalStatus == done", () => {
    expect(LOW_SCORE_MAX).toBe(60);
    expect(aggregates.lowScoreSuccesses).toBe(1); // the score=55/done row only (58 is a failure)
  });

  it("highScoreFailures counts terminal tasks with score >= HIGH_SCORE_MIN and finalStatus != done", () => {
    expect(HIGH_SCORE_MIN).toBe(90);
    expect(aggregates.highScoreFailures).toBe(1); // the score=92/abandoned row only (95 is a success)
  });

  it("a row with scoreAtClaim null never appears in any score-banded aggregate", () => {
    const bandLabels = [
      ...aggregates.bounceBackByScoreBand.map((b) => b.band),
      ...aggregates.doneRateByScoreBand.map((b) => b.band),
    ];
    // Total rows contributing to bounceBackByScoreBand across all bands must be 7
    // (8 fixture rows minus the 1 with scoreAtClaim===null).
    const totalScored = aggregates.bounceBackByScoreBand.reduce((n, b) => n + b.taskCount, 0);
    expect(totalScored).toBe(7);
    expect(bandLabels.length).toBeGreaterThan(0);
  });

  it("empty input produces empty/zeroed aggregates, no throw", () => {
    const empty = computeConfidenceTelemetryAggregates([], []);
    expect(empty).toEqual({
      overrideRatePerWeek: [],
      bounceBackByScoreBand: [],
      doneRateByScoreBand: [],
      lowScoreSuccesses: 0,
      highScoreFailures: 0,
    });
  });
});

describe("recordBounceBack / recordTerminalSnapshot — fail-open contract", () => {
  it("recordBounceBack swallows a DB error and logs it, never throws", async () => {
    prismaMocks.auditLogFindFirst.mockRejectedValue(new Error("db unreachable"));
    prismaMocks.confidenceTelemetryUpsert.mockRejectedValue(new Error("db unreachable"));

    await expect(recordBounceBack("task-1", "proj-1")).resolves.toBeUndefined();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ component: "confidence-telemetry", op: "recordBounceBack", taskId: "task-1" }),
      expect.any(String),
    );
  });

  it("recordTerminalSnapshot swallows a DB error and logs it, never throws", async () => {
    prismaMocks.auditLogFindFirst.mockRejectedValue(new Error("db unreachable"));
    prismaMocks.confidenceTelemetryUpsert.mockRejectedValue(new Error("db unreachable"));

    await expect(
      recordTerminalSnapshot({ taskId: "task-2", projectId: "proj-1", finalStatus: "done", taskType: "bugfix" }),
    ).resolves.toBeUndefined();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ component: "confidence-telemetry", op: "recordTerminalSnapshot", taskId: "task-2" }),
      expect.any(String),
    );
  });

  it("recordTerminalSnapshot upserts with the resolved claim snapshot fields on the happy path", async () => {
    prismaMocks.auditLogFindFirst
      .mockResolvedValueOnce({ payload: { score: 72, threshold: 65 } }) // latest claim-snapshot event
      .mockResolvedValueOnce({ id: "audit-override-1" }); // an override event exists
    prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});

    await recordTerminalSnapshot({ taskId: "task-3", projectId: "proj-1", finalStatus: "done", taskType: "feature" });

    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: "task-3" },
        create: expect.objectContaining({
          taskId: "task-3",
          projectId: "proj-1",
          finalStatus: "done",
          taskType: "feature",
          scoreAtClaim: 72,
          effectiveThreshold: 65,
          overrideUsed: true,
        }),
      }),
    );
    expect(loggerMocks.error).not.toHaveBeenCalled();
  });

  it("recordTerminalSnapshot resolves scoreAtClaim/effectiveThreshold to null and overrideUsed to false when no claim audit row exists (human claim / OFF-mode project)", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});

    await recordTerminalSnapshot({ taskId: "task-4", projectId: "proj-1", finalStatus: "done", taskType: null });

    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ scoreAtClaim: null, effectiveThreshold: null, overrideUsed: false }),
      }),
    );
  });
});
