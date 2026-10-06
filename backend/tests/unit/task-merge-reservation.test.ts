/**
 * Pure tests for the merge reservation predicates (agent-tasks eb08742f): the
 * lease boundary, the WHERE fragments every claim and status write carries and
 * the retry hint. The DB-backed behavior is in
 * tests/integration/merge-reservation.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  MERGE_RESERVATION_CLEAR,
  MERGE_RESERVATION_TTL_MS,
  isMergeReservationLive,
  mergeReservationAllows,
  mergeReservationLeaseCutoff,
  mergeReservationRetryAfterSeconds,
  noLiveMergeReservation,
} from "../../src/services/task-merge-reservation.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("lease", () => {
  it("is two minutes: far above a GitHub merge call, short enough that a crashed handler frees the task soon", () => {
    expect(MERGE_RESERVATION_TTL_MS).toBe(120_000);
  });

  it("a reservation is live until its lease is exactly TTL old; at TTL it has lapsed", () => {
    expect(isMergeReservationLive({ mergeReservedAt: ago(0) }, NOW)).toBe(true);
    expect(isMergeReservationLive({ mergeReservedAt: ago(MERGE_RESERVATION_TTL_MS - 1) }, NOW)).toBe(true);
    expect(isMergeReservationLive({ mergeReservedAt: ago(MERGE_RESERVATION_TTL_MS) }, NOW)).toBe(false);
    expect(isMergeReservationLive({ mergeReservedAt: ago(MERGE_RESERVATION_TTL_MS + 1) }, NOW)).toBe(false);
  });

  it("no reservation is not a live reservation", () => {
    expect(isMergeReservationLive({ mergeReservedAt: null }, NOW)).toBe(false);
  });

  it("the cutoff the SQL and the JS check share is now minus the TTL", () => {
    expect(mergeReservationLeaseCutoff(NOW).getTime()).toBe(NOW.getTime() - MERGE_RESERVATION_TTL_MS);
  });

  it("the retry hint is the whole seconds left on the lease, at least one", () => {
    expect(mergeReservationRetryAfterSeconds({ mergeReservedAt: ago(0) }, NOW)).toBe(120);
    expect(mergeReservationRetryAfterSeconds({ mergeReservedAt: ago(30_500) }, NOW)).toBe(90);
    expect(mergeReservationRetryAfterSeconds({ mergeReservedAt: ago(MERGE_RESERVATION_TTL_MS - 1) }, NOW)).toBe(1);
    expect(mergeReservationRetryAfterSeconds({ mergeReservedAt: ago(MERGE_RESERVATION_TTL_MS + 5_000) }, NOW)).toBe(1);
  });
});

describe("WHERE fragments", () => {
  it("noLiveMergeReservation matches a row with no reservation or a lapsed one, under AND so it cannot collide with an OR of the same WHERE", () => {
    expect(noLiveMergeReservation(NOW)).toEqual({
      AND: [{ OR: [{ mergeReservedAt: null }, { mergeReservedAt: { lte: ago(MERGE_RESERVATION_TTL_MS) } }] }],
    });
  });

  it("mergeReservationAllows without a reservation is the same refusal as noLiveMergeReservation", () => {
    expect(mergeReservationAllows(undefined, NOW)).toEqual(noLiveMergeReservation(NOW));
    expect(mergeReservationAllows(null, NOW)).toEqual(noLiveMergeReservation(NOW));
  });

  it("mergeReservationAllows lets the holder's own reservation through, matched on lease start and holder", () => {
    const reservation = { at: ago(5_000), byUserId: "u-1", byAgentId: null };
    expect(mergeReservationAllows(reservation, NOW)).toEqual({
      AND: [
        {
          OR: [
            { mergeReservedAt: null },
            { mergeReservedAt: { lte: ago(MERGE_RESERVATION_TTL_MS) } },
            { mergeReservedAt: reservation.at, mergeReservedByUserId: "u-1", mergeReservedByAgentId: null },
          ],
        },
      ],
    });
  });

  it("the clear spread nulls the holder columns and the lease start", () => {
    expect(MERGE_RESERVATION_CLEAR).toEqual({ mergeReservedByUserId: null, mergeReservedByAgentId: null, mergeReservedAt: null });
  });
});
