/**
 * End-to-end pin for the gate->evaluator threshold plumbing (task f186b88b
 * review round 1, finding 2): evaluateConfidenceGate must resolve the
 * per-task-type override and hand BOTH the effective threshold and its
 * thresholdSource into the audit payload. The evaluator unit tests only
 * prove the evaluator echoes its input; this test drives the real
 * resolveEffectiveThreshold from a real taskTypeThresholds override, so
 * hardcoding thresholdSource at the gate boundary (the misattribution this
 * feature exists to prevent) turns this red.
 */
import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

const auditMocks = vi.hoisted(() => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: auditMocks.logAuditEvent,
}));

import { evaluateConfidenceGate } from "../../src/services/confidence-gate.js";
import type { Actor } from "../../src/types/auth.js";

const AGENT_ACTOR = {
  type: "agent",
  tokenId: "tok-1",
  teamId: "team-1",
  userId: "user-1",
} as unknown as Actor;

function fakeContext(): Context {
  return {
    req: { query: () => undefined },
    json: (body: unknown, status: number) => ({ body, status }),
  } as unknown as Context;
}

describe("evaluateConfidenceGate audit plumbing", () => {
  it("logs the per-type effective threshold WITH thresholdSource='taskType' when a security override blocks", async () => {
    // Sparse templateData scores far below the 90 override; BLOCK mode so
    // the decision is block_low_readiness and the audit payload is logged.
    const result = await evaluateConfidenceGate(
      fakeContext(),
      {
        id: "task-1",
        projectId: "proj-1",
        title: "x",
        description: null,
        labels: [],
        templateData: { taskType: "security" },
        project: {
          confidenceThreshold: 60,
          taskTemplate: null,
          enforcementMode: "BLOCK",
          taskTypeThresholds: { security: 90 },
          riskModifiers: null,
        },
      },
      AGENT_ACTOR,
      "start",
    );

    expect(result.ok).toBe(false);
    expect(auditMocks.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.claim_blocked_low_readiness",
        payload: expect.objectContaining({
          threshold: 90,
          thresholdSource: "taskType",
        }),
      }),
    );
  });

  it("falls back to thresholdSource='project' for a type without an override", async () => {
    const result = await evaluateConfidenceGate(
      fakeContext(),
      {
        id: "task-2",
        projectId: "proj-1",
        title: "x",
        description: null,
        labels: [],
        templateData: { taskType: "bugfix" },
        project: {
          confidenceThreshold: 95,
          taskTemplate: null,
          enforcementMode: "BLOCK",
          taskTypeThresholds: { security: 90 },
          riskModifiers: null,
        },
      },
      AGENT_ACTOR,
      "start",
    );

    expect(result.ok).toBe(false);
    expect(auditMocks.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          threshold: 95,
          thresholdSource: "project",
        }),
      }),
    );
  });

  // HIGH-1 (batch 18 review, task 698eeb01 fix round): AuditLog.actorId FKs
  // to users(id) (schema.prisma), never to an agent token id. The M5 clean
  // allow branch (nothing would block; see confidence-gate.ts's `case
  // "allow"` with no `decision.audit`) previously wrote `actor.tokenId` as
  // the top-level actorId — logAuditEvent swallows the resulting FK
  // violation (23503) silently, so `task.claim_confidence_recorded` never
  // persisted for a single agent claim in production, and every downstream
  // aggregate resolveClaimSnapshotFields feeds (scoreAtClaim,
  // effectiveThreshold, overrideUsed, and everything
  // computeConfidenceTelemetryAggregates derives from them) would have been
  // empty. This pins the fix: actorId undefined, tokenId preserved in
  // payload.actorTokenId.
  it("clean allow (WARN mode, nothing would block): task.claim_confidence_recorded carries actorId=undefined and the token id in payload.actorTokenId", async () => {
    const result = await evaluateConfidenceGate(
      fakeContext(),
      {
        id: "task-3",
        projectId: "proj-1",
        title: "A well-specified task",
        description:
          "Goal: fix the flaky retry test. Scope: tests/retry.test.ts only. " +
          "Acceptance criteria: the test passes 20/20 runs. Out of scope: prod code changes.",
        labels: [],
        templateData: { taskType: "bugfix" },
        project: {
          confidenceThreshold: 1,
          taskTemplate: null,
          enforcementMode: "WARN",
          taskTypeThresholds: null,
          riskModifiers: null,
        },
      },
      AGENT_ACTOR,
      "start",
    );

    expect(result.ok).toBe(true);
    expect(auditMocks.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.claim_confidence_recorded",
        actorId: undefined,
        payload: expect.objectContaining({ actorTokenId: "tok-1" }),
      }),
    );
  });
});
