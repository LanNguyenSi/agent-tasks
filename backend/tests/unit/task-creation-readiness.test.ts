/**
 * Unit tests for describeTaskCreation — the per-project task-creation readiness
 * summary surfaced as `taskCreation` on the discovery endpoints.
 */
import { describe, it, expect } from "vitest";
import {
  describeTaskCreation,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from "../../src/lib/task-creation-readiness.js";
import { EnforcementMode } from "../../src/lib/enforcement-mode.js";

describe("describeTaskCreation", () => {
  it("defaults a bare project: WARN, default threshold, template mode off", () => {
    const out = describeTaskCreation({});
    expect(out).toEqual({
      enforcementMode: EnforcementMode.WARN,
      confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
      templateModeEnabled: false,
      requiredFields: [],
    });
  });

  it("treats null taskTemplate / null enforcementMode as defaults", () => {
    const out = describeTaskCreation({
      taskTemplate: null,
      enforcementMode: null,
      confidenceThreshold: 60,
    });
    expect(out.templateModeEnabled).toBe(false);
    expect(out.requiredFields).toEqual([]);
    expect(out.enforcementMode).toBe(EnforcementMode.WARN);
  });

  it("lists only the fields marked required and flags template mode on", () => {
    const out = describeTaskCreation({
      taskTemplate: {
        fields: {
          goal: true,
          acceptanceCriteria: true,
          scope: false,
          risk: false,
        },
      },
    });
    expect(out.templateModeEnabled).toBe(true);
    expect([...out.requiredFields].sort()).toEqual([
      "acceptanceCriteria",
      "goal",
    ]);
  });

  it("template mode stays off when every field is false", () => {
    const out = describeTaskCreation({
      taskTemplate: { fields: { goal: false, acceptanceCriteria: false } },
    });
    expect(out.templateModeEnabled).toBe(false);
    expect(out.requiredFields).toEqual([]);
  });

  it("resolves an explicit BLOCK mode and a custom threshold", () => {
    const out = describeTaskCreation({
      enforcementMode: "BLOCK",
      confidenceThreshold: 75,
      taskTemplate: { fields: { goal: true } },
    });
    expect(out.enforcementMode).toBe(EnforcementMode.BLOCK);
    expect(out.confidenceThreshold).toBe(75);
    expect(out.requiredFields).toEqual(["goal"]);
  });

  it("falls back to the default threshold when the column is unset", () => {
    const out = describeTaskCreation({ enforcementMode: "OFF" });
    expect(out.confidenceThreshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(out.enforcementMode).toBe(EnforcementMode.OFF);
  });
});
