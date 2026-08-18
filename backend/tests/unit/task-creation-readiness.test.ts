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

// Every taskType resolves to the global default when the project sets
// neither `confidenceThreshold` nor `taskTypeThresholds`.
const ALL_GLOBAL_DEFAULT = {
  bugfix: { effectiveThreshold: DEFAULT_CONFIDENCE_THRESHOLD, thresholdSource: "global" },
  feature: { effectiveThreshold: DEFAULT_CONFIDENCE_THRESHOLD, thresholdSource: "global" },
  refactoring: { effectiveThreshold: DEFAULT_CONFIDENCE_THRESHOLD, thresholdSource: "global" },
  security: { effectiveThreshold: DEFAULT_CONFIDENCE_THRESHOLD, thresholdSource: "global" },
  migration: { effectiveThreshold: DEFAULT_CONFIDENCE_THRESHOLD, thresholdSource: "global" },
  docs: { effectiveThreshold: DEFAULT_CONFIDENCE_THRESHOLD, thresholdSource: "global" },
};

describe("describeTaskCreation", () => {
  it("defaults a bare project: WARN, default threshold, template mode off", () => {
    const out = describeTaskCreation({});
    expect(out).toEqual({
      enforcementMode: EnforcementMode.WARN,
      confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
      templateModeEnabled: false,
      requiredFields: [],
      taskTypeThresholds: ALL_GLOBAL_DEFAULT,
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

  // ── M2 (task f186b88b): taskTypeThresholds discovery ─────────────────────
  // The bug this closes: an agent could only learn a project's per-type
  // override AFTER task_create, by tripping the claim gate. taskTypeThresholds
  // now surfaces the resolved value for every type up front.
  it("taskTypeThresholds: an unset project falls through to the flat confidenceThreshold for every type", () => {
    const out = describeTaskCreation({ confidenceThreshold: 75 });
    for (const taskType of ["bugfix", "feature", "refactoring", "security", "migration", "docs"] as const) {
      expect(out.taskTypeThresholds[taskType]).toEqual({
        effectiveThreshold: 75,
        thresholdSource: "project",
      });
    }
  });

  it("taskTypeThresholds: a per-type override wins for that type only, everything else stays on the project layer", () => {
    const out = describeTaskCreation({
      confidenceThreshold: 60,
      taskTypeThresholds: { security: 90, docs: 50 },
    });
    expect(out.taskTypeThresholds.security).toEqual({
      effectiveThreshold: 90,
      thresholdSource: "taskType",
    });
    expect(out.taskTypeThresholds.docs).toEqual({
      effectiveThreshold: 50,
      thresholdSource: "taskType",
    });
    expect(out.taskTypeThresholds.bugfix).toEqual({
      effectiveThreshold: 60,
      thresholdSource: "project",
    });
    expect(out.taskTypeThresholds.feature).toEqual({
      effectiveThreshold: 60,
      thresholdSource: "project",
    });
  });

  it("taskTypeThresholds: a corrupted override value (out of range) degrades that type to the project layer only, not the whole map", () => {
    const out = describeTaskCreation({
      confidenceThreshold: 65,
      taskTypeThresholds: { security: 999 },
    });
    expect(out.taskTypeThresholds.security).toEqual({
      effectiveThreshold: 65,
      thresholdSource: "project",
    });
  });
});
