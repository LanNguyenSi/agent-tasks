/**
 * Drift guard for GET /projects/:id/telemetry/confidence (M5, task
 * 698eeb01). Mirrors the sibling openapi-*-parity tests: diff the hand-written
 * OpenAPI schema in docs.ts against what `computeConfidenceTelemetryAggregates`
 * (the single function backing the endpoint's `aggregates` field, imported
 * directly rather than re-derived) actually produces for a fixture, so a field
 * added to (or removed from) one side without the other turns this red.
 */
import { describe, it, expect } from "vitest";
import { openApiSpec } from "../../src/routes/docs.js";
import {
  computeConfidenceTelemetryAggregates,
  type ConfidenceTelemetryRow,
  type ClaimEventRow,
} from "../../src/services/confidence-telemetry.js";

describe("OpenAPI ConfidenceTelemetryAggregates schema <-> real aggregator parity", () => {
  const rows: ConfidenceTelemetryRow[] = [{ scoreAtClaim: 65, finalStatus: "done", bounceBackCount: 1 }];
  const claimEvents: ClaimEventRow[] = [
    { action: "task.claim_override_used", createdAt: new Date("2026-08-10T00:00:00Z") },
  ];
  const assembled = computeConfidenceTelemetryAggregates(rows, claimEvents);

  const aggregatesSchema = openApiSpec.components.schemas.ConfidenceTelemetryAggregates;
  const weekBucketSchema = openApiSpec.components.schemas.ConfidenceTelemetryWeekBucket;
  const bounceBandSchema = openApiSpec.components.schemas.ConfidenceTelemetryScoreBandBounceBack;
  const doneBandSchema = openApiSpec.components.schemas.ConfidenceTelemetryScoreBandDoneRate;

  it("documents exactly the top-level keys computeConfidenceTelemetryAggregates returns", () => {
    expect(Object.keys(aggregatesSchema.properties).sort()).toEqual(Object.keys(assembled).sort());
  });

  it("required lists every top-level field (all five are always populated, even if empty/zero)", () => {
    expect([...aggregatesSchema.required].sort()).toEqual(
      [
        "overrideRatePerWeek",
        "bounceBackByScoreBand",
        "doneRateByScoreBand",
        "lowScoreSuccesses",
        "highScoreFailures",
      ].sort(),
    );
  });

  it("ConfidenceTelemetryWeekBucket documents exactly the keys one overrideRatePerWeek entry has", () => {
    expect(assembled.overrideRatePerWeek.length).toBeGreaterThan(0);
    expect(Object.keys(weekBucketSchema.properties).sort()).toEqual(
      Object.keys(assembled.overrideRatePerWeek[0]!).sort(),
    );
  });

  it("ConfidenceTelemetryScoreBandBounceBack documents exactly the keys one bounceBackByScoreBand entry has", () => {
    expect(assembled.bounceBackByScoreBand.length).toBeGreaterThan(0);
    expect(Object.keys(bounceBandSchema.properties).sort()).toEqual(
      Object.keys(assembled.bounceBackByScoreBand[0]!).sort(),
    );
  });

  it("ConfidenceTelemetryScoreBandDoneRate documents exactly the keys one doneRateByScoreBand entry has", () => {
    expect(assembled.doneRateByScoreBand.length).toBeGreaterThan(0);
    expect(Object.keys(doneBandSchema.properties).sort()).toEqual(
      Object.keys(assembled.doneRateByScoreBand[0]!).sort(),
    );
  });

  it("the GET /projects/{id}/telemetry/confidence response schema wraps aggregates under period/periodStart/aggregates", () => {
    const responseSchema =
      openApiSpec.paths["/api/projects/{id}/telemetry/confidence"].get.responses["200"].content[
        "application/json"
      ].schema;
    expect(Object.keys(responseSchema.properties).sort()).toEqual(["aggregates", "period", "periodStart"].sort());
    expect([...responseSchema.required].sort()).toEqual(["aggregates", "period", "periodStart"].sort());
  });
});
