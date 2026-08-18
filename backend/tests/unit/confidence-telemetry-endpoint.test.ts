/**
 * Integration test for `GET /api/projects/:id/telemetry/confidence` (M5,
 * task 698eeb01) — the read-only discovery endpoint backing the
 * `overrideRatePerWeek` / `bounceBackByScoreBand` / `doneRateByScoreBand` /
 * `lowScoreSuccesses` / `highScoreFailures` calibration aggregates.
 *
 * Mirrors effective-gates-endpoint.test.ts's mocking pattern: prisma and
 * team-access are mocked, the projectRouter is mounted directly, no DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  teamMemberFindUnique: vi.fn(),
  confidenceTelemetryFindMany: vi.fn(),
  auditLogFindMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: prismaMocks.projectFindUnique },
    teamMember: { findUnique: prismaMocks.teamMemberFindUnique },
    confidenceTelemetry: { findMany: prismaMocks.confidenceTelemetryFindMany },
    auditLog: { findMany: prismaMocks.auditLogFindMany },
  },
}));

const teamAccessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn(),
  getProjectMembership: vi.fn(),
  resolveTeamId: vi.fn(),
}));

vi.mock("../../src/services/team-access.js", () => ({
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  hasProjectAccess: teamAccessMocks.hasProjectAccess,
  getProjectMembership: teamAccessMocks.getProjectMembership,
  resolveTeamId: teamAccessMocks.resolveTeamId,
  resolveTeamIdErrorBody: vi.fn(),
}));

vi.mock("../../src/services/audit.js", () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/board-default.js", () => ({ ensureDefaultBoardForProject: vi.fn().mockResolvedValue(undefined) }));

import { projectRouter } from "../../src/routes/projects.js";

const HUMAN_ACTOR: Actor = { type: "human", userId: "u1" };
const PROJECT_ID = "00000000-0000-0000-0000-000000000001";

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", projectRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.projectFindUnique.mockResolvedValue({ id: PROJECT_ID });
  teamAccessMocks.hasProjectAccess.mockResolvedValue(true);
  prismaMocks.confidenceTelemetryFindMany.mockResolvedValue([]);
  prismaMocks.auditLogFindMany.mockResolvedValue([]);
});

describe("GET /projects/:id/telemetry/confidence", () => {
  it("404s when the project does not exist", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue(null);
    const res = await makeApp(HUMAN_ACTOR).request(`/projects/${PROJECT_ID}/telemetry/confidence`);
    expect(res.status).toBe(404);
  });

  it("403s when the actor lacks project access", async () => {
    teamAccessMocks.hasProjectAccess.mockResolvedValue(false);
    const res = await makeApp(HUMAN_ACTOR).request(`/projects/${PROJECT_ID}/telemetry/confidence`);
    expect(res.status).toBe(403);
  });

  it("defaults period to 30d when omitted", async () => {
    const res = await makeApp(HUMAN_ACTOR).request(`/projects/${PROJECT_ID}/telemetry/confidence`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { period: string };
    expect(body.period).toBe("30d");
  });

  it("rejects an invalid period with 400", async () => {
    const res = await makeApp(HUMAN_ACTOR).request(`/projects/${PROJECT_ID}/telemetry/confidence?period=14d`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("accepts 7d/30d/90d and echoes the requested period", async () => {
    for (const period of ["7d", "30d", "90d"]) {
      const res = await makeApp(HUMAN_ACTOR).request(`/projects/${PROJECT_ID}/telemetry/confidence?period=${period}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { period: string };
      expect(body.period).toBe(period);
    }
  });

  it("scopes both prisma queries to the project id and the period's projectId/date filters", async () => {
    await makeApp(HUMAN_ACTOR).request(`/projects/${PROJECT_ID}/telemetry/confidence?period=7d`);

    expect(prismaMocks.confidenceTelemetryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: PROJECT_ID, updatedAt: expect.objectContaining({ gte: expect.any(Date) }) }),
      }),
    );
    expect(prismaMocks.auditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: PROJECT_ID,
          createdAt: expect.objectContaining({ gte: expect.any(Date) }),
          action: expect.objectContaining({
            in: expect.arrayContaining([
              "task.claim_would_block_shadow",
              "task.claim_blocked_low_readiness",
              "task.claim_override_used",
              "task.claim_confidence_recorded",
            ]),
          }),
        }),
      }),
    );
  });

  // MED-5 (batch 18 review): the previous version of the test above only
  // asserted `gte: expect.any(Date)`, which passes for ANY Date regardless
  // of its value — an off-by-one in CONFIDENCE_TELEMETRY_PERIOD_DAYS (e.g.
  // "7d" resolving to 8 days) survived undetected. This captures the actual
  // Date passed to both prisma calls and checks its distance from
  // Date.now() against the period's real day count, with slack only for the
  // request's own wall-clock round trip.
  it("periodStart is Date.now() minus the period's own day count for 7d and 90d, not an off-by-one", async () => {
    const ROUND_TRIP_SLACK_MS = 5_000;
    const PERIOD_DAYS: Record<string, number> = { "7d": 7, "90d": 90 };

    for (const period of ["7d", "90d"]) {
      prismaMocks.confidenceTelemetryFindMany.mockClear();
      prismaMocks.auditLogFindMany.mockClear();

      const before = Date.now();
      const res = await makeApp(HUMAN_ACTOR).request(`/projects/${PROJECT_ID}/telemetry/confidence?period=${period}`);
      const after = Date.now();
      expect(res.status).toBe(200);

      const expectedMs = PERIOD_DAYS[period]! * 24 * 60 * 60 * 1000;

      const telemetryCall = prismaMocks.confidenceTelemetryFindMany.mock.calls.at(-1)?.[0] as {
        where: { updatedAt: { gte: Date } };
      };
      const auditCall = prismaMocks.auditLogFindMany.mock.calls.at(-1)?.[0] as {
        where: { createdAt: { gte: Date } };
      };
      const telemetryPeriodStartMs = telemetryCall.where.updatedAt.gte.getTime();
      const auditPeriodStartMs = auditCall.where.createdAt.gte.getTime();

      // Both prisma calls must use the SAME periodStart.
      expect(auditPeriodStartMs).toBe(telemetryPeriodStartMs);
      // periodStart must sit within [before, after] minus expectedMs, with
      // slack only for the request's own execution time — an off-by-one day
      // (86_400_000ms) blows straight through a 5s tolerance window.
      expect(before - telemetryPeriodStartMs).toBeGreaterThanOrEqual(expectedMs - ROUND_TRIP_SLACK_MS);
      expect(after - telemetryPeriodStartMs).toBeLessThanOrEqual(expectedMs + ROUND_TRIP_SLACK_MS);
    }
  });

  it("returns fixture-driven aggregates end to end, pinning the score-band boundaries on both sides", async () => {
    prismaMocks.confidenceTelemetryFindMany.mockResolvedValue([
      // HIGH-2 (batch 18 review): "abandoned" exercises a finalStatus
      // production cannot reach today (see services/confidence-telemetry.ts's
      // header comment) — used here to pin the aggregator's non-done branch.
      { scoreAtClaim: 59, finalStatus: "abandoned", bounceBackCount: 0 }, // just below the 60-70 band
      { scoreAtClaim: 60, finalStatus: "done", bounceBackCount: 1 }, // lower edge of 60-70 (inclusive)
      { scoreAtClaim: 69, finalStatus: "done", bounceBackCount: 0 }, // still inside 60-70
      { scoreAtClaim: 70, finalStatus: "done", bounceBackCount: 0 }, // rolled into 70-80 (upper bound exclusive)
    ]);
    prismaMocks.auditLogFindMany.mockResolvedValue([
      { action: "task.claim_confidence_recorded", createdAt: new Date("2026-08-10T00:00:00Z") },
      { action: "task.claim_override_used", createdAt: new Date("2026-08-10T01:00:00Z") },
    ]);

    const res = await makeApp(HUMAN_ACTOR).request(`/projects/${PROJECT_ID}/telemetry/confidence?period=30d`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aggregates: {
        overrideRatePerWeek: Array<{ weekStart: string; overrideCount: number; totalClaims: number; rate: number }>;
        bounceBackByScoreBand: Array<{ band: string; taskCount: number; avgBounceBackCount: number }>;
        doneRateByScoreBand: Array<{ band: string; taskCount: number; doneRate: number }>;
        lowScoreSuccesses: number;
        highScoreFailures: number;
      };
    };

    expect(body.aggregates.overrideRatePerWeek).toEqual([
      { weekStart: "2026-08-10", overrideCount: 1, totalClaims: 2, rate: 0.5 },
    ]);
    expect(body.aggregates.bounceBackByScoreBand).toEqual([
      { band: "50-60", taskCount: 1, avgBounceBackCount: 0 },
      { band: "60-70", taskCount: 2, avgBounceBackCount: 0.5 },
      { band: "70-80", taskCount: 1, avgBounceBackCount: 0 },
    ]);
    expect(body.aggregates.doneRateByScoreBand).toEqual([
      { band: "50-60", taskCount: 1, doneRate: 0 },
      { band: "60-70", taskCount: 2, doneRate: 1 },
      { band: "70-80", taskCount: 1, doneRate: 1 },
    ]);
    expect(body.aggregates.lowScoreSuccesses).toBe(0); // the score=59 row is a failure, not a success
    expect(body.aggregates.highScoreFailures).toBe(0);
  });
});
