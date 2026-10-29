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
 *   - The "done" disposition for custom terminal states: one case per input
 *     combination of (pinned workflow, project default, built-in, unreadable
 *     definition, abandon) and the read-side bands for such an outcome.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const prismaMocks = vi.hoisted(() => ({
  confidenceTelemetryUpsert: vi.fn(),
  confidenceTelemetryUpdateMany: vi.fn(),
  auditLogFindFirst: vi.fn(),
  taskFindUnique: vi.fn(),
  workflowFindUnique: vi.fn(),
  workflowFindFirst: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    confidenceTelemetry: {
      upsert: prismaMocks.confidenceTelemetryUpsert,
      updateMany: prismaMocks.confidenceTelemetryUpdateMany,
    },
    auditLog: { findFirst: prismaMocks.auditLogFindFirst },
    task: { findUnique: prismaMocks.taskFindUnique },
    workflow: { findUnique: prismaMocks.workflowFindUnique, findFirst: prismaMocks.workflowFindFirst },
  },
}));

const loggerMocks = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({ logger: { error: loggerMocks.error, warn: loggerMocks.warn } }));

import {
  scoreBand,
  computeConfidenceTelemetryAggregates,
  recordBounceBack,
  recordClarification,
  recordTerminalSnapshot,
  recordAbandonDisposition,
  clearDisposition,
  LOW_SCORE_MAX,
  HIGH_SCORE_MIN,
  DONE_STATUS,
  type ConfidenceTelemetryRow,
  type ClaimEventRow,
} from "../../src/services/confidence-telemetry.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: an unpinned task in a project without a custom default workflow,
  // i.e. the built-in definition (done is its only terminal state).
  prismaMocks.taskFindUnique.mockResolvedValue({ workflowId: null, projectId: "proj-1" });
  prismaMocks.workflowFindUnique.mockResolvedValue(null);
  prismaMocks.workflowFindFirst.mockResolvedValue(null);
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
  //
  // The "abandoned" rows below carry a non-done finalStatus, which production
  // no longer writes (a creator-abandon sets finalDisposition instead). They
  // still pin the aggregator's finalStatus fallback for rows without a
  // finalDisposition; the disposition-driven cases are in their own describe.
  const rows: ConfidenceTelemetryRow[] = [
    // low band (< LOW_SCORE_MAX=60): one success (counts toward lowScoreSuccesses), one failure
    { scoreAtClaim: 55, finalStatus: DONE_STATUS, bounceBackCount: 2, clarificationCount: 4 },
    { scoreAtClaim: 58, finalStatus: "abandoned", bounceBackCount: 0, clarificationCount: 0 },
    // mid band 60-70
    { scoreAtClaim: 65, finalStatus: DONE_STATUS, bounceBackCount: 1, clarificationCount: 1 },
    { scoreAtClaim: 69, finalStatus: DONE_STATUS, bounceBackCount: 3, clarificationCount: 2 },
    // mid band 70-80, one still in flight (no verdict yet)
    { scoreAtClaim: 72, finalStatus: null, bounceBackCount: 1, clarificationCount: 5 },
    // high band (>= HIGH_SCORE_MIN=90): one success, one failure (counts toward highScoreFailures)
    { scoreAtClaim: 95, finalStatus: DONE_STATUS, bounceBackCount: 0, clarificationCount: 0 },
    { scoreAtClaim: 92, finalStatus: "abandoned", bounceBackCount: 0, clarificationCount: 3 },
    // human claim / OFF-mode project — no scoreAtClaim on record, must be excluded entirely
    { scoreAtClaim: null, finalStatus: DONE_STATUS, bounceBackCount: 0, clarificationCount: 9 },
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

  it("clarificationByScoreBand groups by band, excludes the row without scoreAtClaim (its count of 9 must not leak in), sorted ascending", () => {
    expect(aggregates.clarificationByScoreBand).toEqual([
      { band: "50-60", taskCount: 2, avgClarificationCount: 2 }, // (4+0)/2
      { band: "60-70", taskCount: 2, avgClarificationCount: 1.5 }, // (1+2)/2
      { band: "70-80", taskCount: 1, avgClarificationCount: 5 },
      { band: "90-100", taskCount: 2, avgClarificationCount: 1.5 }, // (0+3)/2
    ]);
  });

  it("clarificationByScoreBand is empty when no row has a scoreAtClaim", () => {
    const empty = computeConfidenceTelemetryAggregates(
      [{ scoreAtClaim: null, finalStatus: null, bounceBackCount: 0, clarificationCount: 3 }],
      [],
    );
    expect(empty.clarificationByScoreBand).toEqual([]);
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
      clarificationByScoreBand: [],
      doneRateByScoreBand: [],
      lowScoreSuccesses: 0,
      highScoreFailures: 0,
    });
  });
});

// MED-4 (batch 18 review): the fixture-driven suite above never placed a
// row at the EXACT classification boundary (score === HIGH_SCORE_MIN=90, or
// score === LOW_SCORE_MAX=60), so a `>=` -> `>` mutant on the highScoreFailures
// filter (or a `<` -> `<=` mutant on the lowScoreSuccesses filter) survived —
// 92/58 sit strictly inside their bands either way the comparison operator
// reads. Isolated fixtures below pin both operators directly at the boundary.
describe("computeConfidenceTelemetryAggregates — score classification boundary pins (MED-4)", () => {
  // The "abandoned" finalStatus below is used purely to pin the aggregator's
  // own boundary comparison through the finalStatus fallback.
  it("HIGH_SCORE_MIN (90) is an INCLUSIVE lower bound: exactly 90 + non-done counts as a high-score failure, exactly 90 + done does not", () => {
    const rows: ConfidenceTelemetryRow[] = [
      { scoreAtClaim: 90, finalStatus: "abandoned", bounceBackCount: 0, clarificationCount: 0 },
      { scoreAtClaim: 90, finalStatus: DONE_STATUS, bounceBackCount: 0, clarificationCount: 0 },
    ];
    const aggregates = computeConfidenceTelemetryAggregates(rows, []);
    expect(aggregates.highScoreFailures).toBe(1);
    // Both rows land in the "90-100" band (never "80-90") — a scoreBand
    // boundary mutant that misassigns 90 would surface here as a wrong band
    // label or a taskCount split across two bands.
    expect(aggregates.doneRateByScoreBand).toEqual([{ band: "90-100", taskCount: 2, doneRate: 0.5 }]);
  });

  it("LOW_SCORE_MAX (60) is an EXCLUSIVE upper bound: 59 + done counts as a low-score success, exactly 60 + done does not", () => {
    const rows: ConfidenceTelemetryRow[] = [
      { scoreAtClaim: 59, finalStatus: DONE_STATUS, bounceBackCount: 0, clarificationCount: 0 },
      { scoreAtClaim: 60, finalStatus: DONE_STATUS, bounceBackCount: 0, clarificationCount: 0 },
    ];
    const aggregates = computeConfidenceTelemetryAggregates(rows, []);
    expect(aggregates.lowScoreSuccesses).toBe(1);
  });
});

describe("recordClarification", () => {
  it("upserts once per call: create starts the count at 1 with the claim snapshot, update increments by 1", async () => {
    prismaMocks.auditLogFindFirst
      .mockResolvedValueOnce({ payload: { score: 72, threshold: 65 } })
      .mockResolvedValueOnce(null);
    prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});

    await recordClarification("task-c1", "proj-1");

    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledTimes(1);
    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledWith({
      where: { taskId: "task-c1" },
      create: {
        taskId: "task-c1",
        projectId: "proj-1",
        clarificationCount: 1,
        scoreAtClaim: 72,
        effectiveThreshold: 65,
        overrideUsed: false,
      },
      update: { clarificationCount: { increment: 1 } },
    });
    expect(loggerMocks.error).not.toHaveBeenCalled();
  });

  it("swallows an upsert error and logs it, never throws", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValue(null);
    prismaMocks.confidenceTelemetryUpsert.mockRejectedValue(new Error("db unreachable"));

    await expect(recordClarification("task-c2", "proj-1")).resolves.toBeUndefined();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ component: "confidence-telemetry", op: "recordClarification", taskId: "task-c2" }),
      expect.any(String),
    );
  });

  it("swallows a snapshot-lookup error and logs it, never throws", async () => {
    prismaMocks.auditLogFindFirst.mockRejectedValue(new Error("audit lookup failed"));

    await expect(recordClarification("task-c3", "proj-1")).resolves.toBeUndefined();
    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ op: "recordClarification", taskId: "task-c3" }),
      expect.any(String),
    );
  });

  it("retries once on a P2002 unique-constraint race and then takes the update branch", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValue(null);
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
    prismaMocks.confidenceTelemetryUpsert.mockRejectedValueOnce(p2002).mockResolvedValueOnce({});

    await recordClarification("task-c4", "proj-1");

    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledTimes(2);
    expect(loggerMocks.error).not.toHaveBeenCalled();
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

  // ── LOW-8 (batch 18 review) ────────────────────────────────────────────
  it("recordTerminalSnapshot's update path OMITS scoreAtClaim/effectiveThreshold (does not null-clobber) when this call's resolve finds no claim-snapshot row", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});

    await recordTerminalSnapshot({ taskId: "task-6", projectId: "proj-1", finalStatus: "done", taskType: "bugfix" });

    const call = prismaMocks.confidenceTelemetryUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    // The field must be ABSENT from the update payload, not present-as-null:
    // Prisma only clobbers a column when the key is present. A `create` still
    // sets these to null (a fresh row has nothing to clobber) — see the test
    // above.
    expect(call.update).not.toHaveProperty("scoreAtClaim");
    expect(call.update).not.toHaveProperty("effectiveThreshold");
    expect(call.update).toMatchObject({ finalStatus: "done", taskType: "bugfix", overrideUsed: false });
  });

  it("recordTerminalSnapshot's update path DOES include scoreAtClaim/effectiveThreshold when the resolve finds a claim snapshot", async () => {
    prismaMocks.auditLogFindFirst
      .mockResolvedValueOnce({ payload: { score: 80, threshold: 60 } })
      .mockResolvedValueOnce(null);
    prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});

    await recordTerminalSnapshot({ taskId: "task-7", projectId: "proj-1", finalStatus: "done", taskType: null });

    const call = prismaMocks.confidenceTelemetryUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(call.update).toMatchObject({ scoreAtClaim: 80, effectiveThreshold: 60, overrideUsed: false });
  });

  it("recordBounceBack retries the upsert once on a P2002 race and succeeds without logging an error", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValue(null);
    prismaMocks.confidenceTelemetryUpsert
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`taskId`)", {
          code: "P2002",
          clientVersion: "test",
        }),
      )
      .mockResolvedValueOnce({});

    await recordBounceBack("task-8", "proj-1");

    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledTimes(2);
    expect(loggerMocks.error).not.toHaveBeenCalled();
  });

  it("recordTerminalSnapshot retries the upsert once on a P2002 race and succeeds without logging an error", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    prismaMocks.confidenceTelemetryUpsert
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`taskId`)", {
          code: "P2002",
          clientVersion: "test",
        }),
      )
      .mockResolvedValueOnce({});

    await recordTerminalSnapshot({ taskId: "task-9", projectId: "proj-1", finalStatus: "done", taskType: null });

    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledTimes(2);
    expect(loggerMocks.error).not.toHaveBeenCalled();
  });

  it("a non-P2002 upsert error is NOT retried — it goes straight to the fail-open swallow after exactly one attempt", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValue(null);
    prismaMocks.confidenceTelemetryUpsert.mockRejectedValueOnce(new Error("db unreachable"));

    await recordBounceBack("task-10", "proj-1");

    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledTimes(1);
    expect(loggerMocks.error).toHaveBeenCalledTimes(1);
  });
});

describe("recordTerminalSnapshot - finalDisposition", () => {
  it("writes finalDisposition done in BOTH the create and the update argument when finalStatus is done", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValue(null);
    prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});

    await recordTerminalSnapshot({ taskId: "task-d1", projectId: "proj-1", finalStatus: "done", taskType: null });

    const arg = prismaMocks.confidenceTelemetryUpsert.mock.calls[0]![0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.create.finalDisposition).toBe("done");
    expect(arg.update.finalDisposition).toBe("done");
  });

  it("does not write finalDisposition for a non-done finalStatus", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValue(null);
    prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});

    await recordTerminalSnapshot({ taskId: "task-d2", projectId: "proj-1", finalStatus: "abandoned", taskType: null });

    const arg = prismaMocks.confidenceTelemetryUpsert.mock.calls[0]![0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect("finalDisposition" in arg.create).toBe(false);
    expect("finalDisposition" in arg.update).toBe(false);
  });
});

describe("recordAbandonDisposition", () => {
  it("with a scored claim snapshot: upserts, create and update both carry the claim snapshot and abandoned", async () => {
    prismaMocks.auditLogFindFirst
      .mockResolvedValueOnce({ payload: { score: 95, threshold: 70 } })
      .mockResolvedValueOnce(null);
    prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});

    await recordAbandonDisposition("task-a1", "proj-1");

    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledTimes(1);
    expect(prismaMocks.confidenceTelemetryUpsert).toHaveBeenCalledWith({
      where: { taskId: "task-a1" },
      create: {
        taskId: "task-a1",
        projectId: "proj-1",
        finalDisposition: "abandoned",
        scoreAtClaim: 95,
        effectiveThreshold: 70,
        overrideUsed: false,
      },
      update: { finalDisposition: "abandoned", scoreAtClaim: 95, effectiveThreshold: 70, overrideUsed: false },
    });
    expect(prismaMocks.confidenceTelemetryUpdateMany).not.toHaveBeenCalled();
    expect(loggerMocks.error).not.toHaveBeenCalled();
  });

  it("update refreshes the claim snapshot incl. overrideUsed so an existing unscored row gets the score", async () => {
    prismaMocks.auditLogFindFirst
      .mockResolvedValueOnce({ payload: { score: 88, threshold: 70 } })
      .mockResolvedValueOnce({ id: "override-event" });
    prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});

    await recordAbandonDisposition("task-a5", "proj-1");

    const arg = prismaMocks.confidenceTelemetryUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(arg.update).toEqual({
      finalDisposition: "abandoned",
      scoreAtClaim: 88,
      effectiveThreshold: 70,
      overrideUsed: true,
    });
  });

  it("without a scored claim snapshot: updates an existing row only and never creates one", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValue(null);
    prismaMocks.confidenceTelemetryUpdateMany.mockResolvedValue({ count: 0 });

    await recordAbandonDisposition("task-a2", "proj-1");

    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
    expect(prismaMocks.confidenceTelemetryUpdateMany).toHaveBeenCalledWith({
      where: { taskId: "task-a2" },
      data: { finalDisposition: "abandoned" },
    });
  });

  it("swallows an upsert error and logs it, never throws", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValue({ payload: { score: 95, threshold: 70 } });
    prismaMocks.confidenceTelemetryUpsert.mockRejectedValue(new Error("db down"));

    await expect(recordAbandonDisposition("task-a3", "proj-1")).resolves.toBeUndefined();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ op: "recordAbandonDisposition", taskId: "task-a3" }),
      expect.any(String),
    );
  });

  it("swallows an updateMany error and logs it, never throws", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValue(null);
    prismaMocks.confidenceTelemetryUpdateMany.mockRejectedValue(new Error("db down"));

    await expect(recordAbandonDisposition("task-a4", "proj-1")).resolves.toBeUndefined();
    expect(loggerMocks.error).toHaveBeenCalledTimes(1);
  });
});

describe("clearDisposition", () => {
  it("nulls finalDisposition via updateMany and never upserts", async () => {
    prismaMocks.confidenceTelemetryUpdateMany.mockResolvedValue({ count: 1 });

    await clearDisposition("task-c9");

    expect(prismaMocks.confidenceTelemetryUpdateMany).toHaveBeenCalledWith({
      where: { taskId: "task-c9" },
      data: { finalDisposition: null },
    });
    expect(prismaMocks.confidenceTelemetryUpsert).not.toHaveBeenCalled();
  });

  it("swallows an updateMany error and logs it, never throws", async () => {
    prismaMocks.confidenceTelemetryUpdateMany.mockRejectedValue(new Error("db down"));

    await expect(clearDisposition("task-c10")).resolves.toBeUndefined();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ op: "clearDisposition", taskId: "task-c10" }),
      expect.any(String),
    );
  });
});

describe("finalDisposition sequence", () => {
  it("abandon, then clear, then a done terminal snapshot ends with finalDisposition done in the last upsert update", async () => {
    prismaMocks.auditLogFindFirst.mockResolvedValue({ payload: { score: 95, threshold: 70 } });
    prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});
    prismaMocks.confidenceTelemetryUpdateMany.mockResolvedValue({ count: 1 });

    await recordAbandonDisposition("task-s1", "proj-1");
    await clearDisposition("task-s1");
    await recordTerminalSnapshot({ taskId: "task-s1", projectId: "proj-1", finalStatus: "done", taskType: null });

    const upserts = prismaMocks.confidenceTelemetryUpsert.mock.calls;
    expect(upserts).toHaveLength(2);
    expect((upserts[0]![0] as { update: Record<string, unknown> }).update.finalDisposition).toBe("abandoned");
    expect(prismaMocks.confidenceTelemetryUpdateMany).toHaveBeenCalledWith({
      where: { taskId: "task-s1" },
      data: { finalDisposition: null },
    });
    expect((upserts[1]![0] as { update: Record<string, unknown> }).update.finalDisposition).toBe("done");
  });
});

/** A workflow definition whose only terminal state is `terminal` (any name but open). */
function definitionEndingIn(terminal: string, extra: { name: string; terminal: boolean }[] = []) {
  return {
    initialState: "open",
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "review", label: "Review", terminal: false },
      { name: terminal, label: terminal, terminal: true },
      ...extra.map((e) => ({ ...e, label: e.name })),
    ],
    transitions: [
      { from: "open", to: "review" },
      { from: "review", to: terminal },
    ],
  };
}

type UpsertArg = { create: Record<string, unknown>; update: Record<string, unknown> };
const lastUpsert = () =>
  prismaMocks.confidenceTelemetryUpsert.mock.calls.at(-1)![0] as UpsertArg;

describe("recordTerminalSnapshot - done disposition follows the task's effective workflow", () => {
  beforeEach(() => {
    prismaMocks.auditLogFindFirst.mockResolvedValue({ payload: { score: 95, threshold: 70 } });
    prismaMocks.confidenceTelemetryUpsert.mockResolvedValue({});
  });

  it("built-in workflow (unpinned, no project default): done is terminal and writes the done disposition; no workflow row is read beyond the default lookup", async () => {
    await recordTerminalSnapshot({ taskId: "t-b1", projectId: "proj-1", finalStatus: "done", taskType: null });
    expect(lastUpsert().create.finalDisposition).toBe("done");
    expect(lastUpsert().update.finalDisposition).toBe("done");
    expect(prismaMocks.workflowFindUnique).not.toHaveBeenCalled();
    expect(prismaMocks.workflowFindFirst).toHaveBeenCalledTimes(1);
  });

  it("built-in workflow: a non-terminal status (review) writes no disposition, and shipped is not a state of it", async () => {
    await recordTerminalSnapshot({ taskId: "t-b2", projectId: "proj-1", finalStatus: "review", taskType: null });
    expect("finalDisposition" in lastUpsert().create).toBe(false);
    expect("finalDisposition" in lastUpsert().update).toBe(false);
    await recordTerminalSnapshot({ taskId: "t-b3", projectId: "proj-1", finalStatus: "shipped", taskType: null });
    expect("finalDisposition" in lastUpsert().create).toBe(false);
  });

  it("pinned workflow with a custom terminal state: shipped writes done in create and update, finalStatus keeps the state name", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ workflowId: "wf-1", projectId: "proj-1" });
    prismaMocks.workflowFindUnique.mockResolvedValue({ definition: definitionEndingIn("shipped") });

    await recordTerminalSnapshot({ taskId: "t-p1", projectId: "proj-1", finalStatus: "shipped", taskType: null });

    expect(prismaMocks.workflowFindUnique).toHaveBeenCalledWith({ where: { id: "wf-1" } });
    expect(lastUpsert().create).toMatchObject({ finalStatus: "shipped", finalDisposition: "done" });
    expect(lastUpsert().update).toMatchObject({ finalStatus: "shipped", finalDisposition: "done" });
  });

  it("pinned workflow wins over the project default: pinned says shipped is terminal, the default does not", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ workflowId: "wf-1", projectId: "proj-1" });
    prismaMocks.workflowFindUnique.mockResolvedValue({ definition: definitionEndingIn("shipped") });
    prismaMocks.workflowFindFirst.mockResolvedValue({ definition: definitionEndingIn("done", [{ name: "shipped", terminal: false }]) });

    await recordTerminalSnapshot({ taskId: "t-p2", projectId: "proj-1", finalStatus: "shipped", taskType: null });
    expect(lastUpsert().create.finalDisposition).toBe("done");
  });

  it("pinned workflow wins over the project default: pinned says shipped is not terminal, the default does", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({ workflowId: "wf-1", projectId: "proj-1" });
    prismaMocks.workflowFindUnique.mockResolvedValue({ definition: definitionEndingIn("done", [{ name: "shipped", terminal: false }]) });
    prismaMocks.workflowFindFirst.mockResolvedValue({ definition: definitionEndingIn("shipped") });

    await recordTerminalSnapshot({ taskId: "t-p3", projectId: "proj-1", finalStatus: "shipped", taskType: null });
    expect("finalDisposition" in lastUpsert().create).toBe(false);
  });

  it("project default workflow (unpinned task): a custom terminal state writes done, looked up for the task's project as the default row", async () => {
    prismaMocks.workflowFindFirst.mockResolvedValue({ definition: definitionEndingIn("shipped") });

    await recordTerminalSnapshot({ taskId: "t-d1", projectId: "proj-1", finalStatus: "shipped", taskType: null });

    expect(prismaMocks.workflowFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "proj-1", isDefault: true } }),
    );
    expect(lastUpsert().create).toMatchObject({ finalStatus: "shipped", finalDisposition: "done" });
  });

  it("the verdict comes from the definition, not the name: with a custom default that does not end in done, done is no success", async () => {
    prismaMocks.workflowFindFirst.mockResolvedValue({ definition: definitionEndingIn("shipped", [{ name: "done", terminal: false }]) });

    await recordTerminalSnapshot({ taskId: "t-d2", projectId: "proj-1", finalStatus: "done", taskType: null });
    expect("finalDisposition" in lastUpsert().create).toBe(false);
    expect("finalDisposition" in lastUpsert().update).toBe(false);
  });

  it("a definition with several terminal states: each of them is a success end", async () => {
    prismaMocks.workflowFindFirst.mockResolvedValue({
      definition: definitionEndingIn("shipped", [{ name: "released", terminal: true }]),
    });
    await recordTerminalSnapshot({ taskId: "t-d3", projectId: "proj-1", finalStatus: "released", taskType: null });
    expect(lastUpsert().create.finalDisposition).toBe("done");
    await recordTerminalSnapshot({ taskId: "t-d4", projectId: "proj-1", finalStatus: "shipped", taskType: null });
    expect(lastUpsert().create.finalDisposition).toBe("done");
  });

  describe("unreadable definition falls back to the literal built-in terminal status", () => {
    it("the workflow lookup throws: done still writes done, shipped writes nothing, and a warning is logged", async () => {
      prismaMocks.workflowFindFirst.mockRejectedValue(new Error("workflow table unreachable"));

      await recordTerminalSnapshot({ taskId: "t-u1", projectId: "proj-1", finalStatus: "done", taskType: null });
      expect(lastUpsert().create.finalDisposition).toBe("done");
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        expect.objectContaining({ op: "endedInSuccessState", taskId: "t-u1" }),
        expect.any(String),
      );

      await recordTerminalSnapshot({ taskId: "t-u2", projectId: "proj-1", finalStatus: "shipped", taskType: null });
      expect("finalDisposition" in lastUpsert().create).toBe(false);
      // the snapshot itself still lands (fail-open on the lookup, not on the write)
      expect(lastUpsert().create).toMatchObject({ finalStatus: "shipped" });
      expect(loggerMocks.error).not.toHaveBeenCalled();
    });

    it("the stored definition has no states array: same fallback for a pinned row", async () => {
      prismaMocks.taskFindUnique.mockResolvedValue({ workflowId: "wf-bad", projectId: "proj-1" });
      prismaMocks.workflowFindUnique.mockResolvedValue({ definition: { initialState: "open" } });

      await recordTerminalSnapshot({ taskId: "t-u3", projectId: "proj-1", finalStatus: "done", taskType: null });
      expect(lastUpsert().create.finalDisposition).toBe("done");
      await recordTerminalSnapshot({ taskId: "t-u4", projectId: "proj-1", finalStatus: "shipped", taskType: null });
      expect("finalDisposition" in lastUpsert().create).toBe(false);
      expect(loggerMocks.warn).toHaveBeenCalledTimes(2);
    });

    it("the stored definition is null: same fallback for the project default", async () => {
      prismaMocks.workflowFindFirst.mockResolvedValue({ definition: null });

      await recordTerminalSnapshot({ taskId: "t-u5", projectId: "proj-1", finalStatus: "done", taskType: null });
      expect(lastUpsert().create.finalDisposition).toBe("done");
    });

    it("the task row is gone: same fallback, no workflow read", async () => {
      prismaMocks.taskFindUnique.mockResolvedValue(null);

      await recordTerminalSnapshot({ taskId: "t-u6", projectId: "proj-1", finalStatus: "done", taskType: null });
      expect(lastUpsert().create.finalDisposition).toBe("done");
      await recordTerminalSnapshot({ taskId: "t-u7", projectId: "proj-1", finalStatus: "shipped", taskType: null });
      expect("finalDisposition" in lastUpsert().create).toBe(false);
      expect(prismaMocks.workflowFindFirst).not.toHaveBeenCalled();
      expect(prismaMocks.workflowFindUnique).not.toHaveBeenCalled();
    });
  });

  it("abandon: recordAbandonDisposition writes abandoned without consulting any workflow, and a later shipped snapshot overwrites it with done", async () => {
    prismaMocks.workflowFindFirst.mockResolvedValue({ definition: definitionEndingIn("shipped") });

    await recordAbandonDisposition("t-a1", "proj-1");
    expect(lastUpsert().update.finalDisposition).toBe("abandoned");
    expect(prismaMocks.taskFindUnique).not.toHaveBeenCalled();
    expect(prismaMocks.workflowFindFirst).not.toHaveBeenCalled();

    await recordTerminalSnapshot({ taskId: "t-a1", projectId: "proj-1", finalStatus: "shipped", taskType: null });
    expect(lastUpsert().update.finalDisposition).toBe("done");
  });

  it("write and read agree: the row a shipped snapshot writes counts as a success in every score-vs-outcome aggregate", async () => {
    prismaMocks.workflowFindFirst.mockResolvedValue({ definition: definitionEndingIn("shipped") });
    prismaMocks.auditLogFindFirst.mockResolvedValue({ payload: { score: 95, threshold: 70 } });

    await recordTerminalSnapshot({ taskId: "t-w1", projectId: "proj-1", finalStatus: "shipped", taskType: null });
    const written = lastUpsert().create;
    const aggregates = computeConfidenceTelemetryAggregates(
      [
        {
          scoreAtClaim: written.scoreAtClaim as number,
          finalStatus: written.finalStatus as string,
          finalDisposition: written.finalDisposition as string,
          bounceBackCount: 0,
          clarificationCount: 0,
        },
      ],
      [],
    );
    expect(aggregates.highScoreFailures).toBe(0);
    expect(aggregates.doneRateByScoreBand).toEqual([{ band: "90-100", taskCount: 1, doneRate: 1 }]);
  });
});

describe("computeConfidenceTelemetryAggregates - custom terminal outcome", () => {
  it("a shipped status with the done disposition is a success: low-score success, no high-score failure, doneRate 1", () => {
    const rows: ConfidenceTelemetryRow[] = [
      { scoreAtClaim: 55, finalStatus: "shipped", finalDisposition: DONE_STATUS, bounceBackCount: 0, clarificationCount: 0 },
      { scoreAtClaim: 95, finalStatus: "shipped", finalDisposition: DONE_STATUS, bounceBackCount: 0, clarificationCount: 0 },
    ];
    const aggregates = computeConfidenceTelemetryAggregates(rows, []);
    expect(aggregates.lowScoreSuccesses).toBe(1);
    expect(aggregates.highScoreFailures).toBe(0);
    expect(aggregates.doneRateByScoreBand).toEqual([
      { band: "50-60", taskCount: 1, doneRate: 1 },
      { band: "90-100", taskCount: 1, doneRate: 1 },
    ]);
  });

  it("a shipped status with the abandoned disposition is still a failure (disposition wins)", () => {
    const rows: ConfidenceTelemetryRow[] = [
      { scoreAtClaim: 95, finalStatus: "shipped", finalDisposition: "abandoned", bounceBackCount: 0, clarificationCount: 0 },
      { scoreAtClaim: 96, finalStatus: "shipped", finalDisposition: DONE_STATUS, bounceBackCount: 0, clarificationCount: 0 },
    ];
    const aggregates = computeConfidenceTelemetryAggregates(rows, []);
    expect(aggregates.highScoreFailures).toBe(1);
    expect(aggregates.doneRateByScoreBand).toEqual([{ band: "90-100", taskCount: 2, doneRate: 0.5 }]);
  });
});

describe("computeConfidenceTelemetryAggregates - finalDisposition outcome", () => {
  it("an abandoned-disposition row with no finalStatus is a high-score failure and pulls the band doneRate below 1", () => {
    const rows: ConfidenceTelemetryRow[] = [
      { scoreAtClaim: 95, finalStatus: null, finalDisposition: "abandoned", bounceBackCount: 0, clarificationCount: 0 },
      { scoreAtClaim: 91, finalStatus: DONE_STATUS, finalDisposition: DONE_STATUS, bounceBackCount: 0, clarificationCount: 0 },
    ];
    const aggregates = computeConfidenceTelemetryAggregates(rows, []);
    expect(aggregates.highScoreFailures).toBe(1);
    expect(aggregates.doneRateByScoreBand).toEqual([{ band: "90-100", taskCount: 2, doneRate: 0.5 }]);
  });

  it("finalDisposition takes precedence over finalStatus: a done status with an abandoned disposition is a failure", () => {
    const rows: ConfidenceTelemetryRow[] = [
      { scoreAtClaim: 95, finalStatus: DONE_STATUS, finalDisposition: "abandoned", bounceBackCount: 0, clarificationCount: 0 },
    ];
    const aggregates = computeConfidenceTelemetryAggregates(rows, []);
    expect(aggregates.highScoreFailures).toBe(1);
    expect(aggregates.doneRateByScoreBand).toEqual([{ band: "90-100", taskCount: 1, doneRate: 0 }]);
  });

  it("a legacy row (finalStatus done, finalDisposition null) still counts as done", () => {
    const rows: ConfidenceTelemetryRow[] = [
      { scoreAtClaim: 55, finalStatus: DONE_STATUS, finalDisposition: null, bounceBackCount: 0, clarificationCount: 0 },
      { scoreAtClaim: 95, finalStatus: DONE_STATUS, finalDisposition: null, bounceBackCount: 0, clarificationCount: 0 },
    ];
    const aggregates = computeConfidenceTelemetryAggregates(rows, []);
    expect(aggregates.lowScoreSuccesses).toBe(1);
    expect(aggregates.highScoreFailures).toBe(0);
    expect(aggregates.doneRateByScoreBand).toEqual([
      { band: "50-60", taskCount: 1, doneRate: 1 },
      { band: "90-100", taskCount: 1, doneRate: 1 },
    ]);
  });

  it("a row with both finalStatus and finalDisposition null is not terminal", () => {
    const rows: ConfidenceTelemetryRow[] = [
      { scoreAtClaim: 95, finalStatus: null, finalDisposition: null, bounceBackCount: 2, clarificationCount: 0 },
    ];
    const aggregates = computeConfidenceTelemetryAggregates(rows, []);
    expect(aggregates.doneRateByScoreBand).toEqual([]);
    expect(aggregates.highScoreFailures).toBe(0);
    expect(aggregates.bounceBackByScoreBand).toEqual([{ band: "90-100", taskCount: 1, avgBounceBackCount: 2 }]);
  });
});
