/**
 * Direct unit tests for `ClaimPolicyEvaluator` (ADR-0011, extracted from
 * `confidence-gate.ts` in PR #399). This is the pure decision core: no
 * `Context`, no DB, no HTTP. It is exercised end-to-end via HTTP in
 * `tasks-v2-routes.test.ts`; this file calls `claimPolicyEvaluator.evaluate`
 * directly so the decision matrix has one unit test that does not require
 * standing up the route/app plumbing.
 *
 * Covers the six outcome cells, plus a precedence guard (cell 7):
 *   1. allow            — score >= threshold, not blocking
 *   2. block_low_readiness — score < threshold (or report.blocking)
 *   3. force override   — BLOCK state, sufficient scope + valid reason
 *   4. force no-op      — force supplied but nothing would block
 *   5. force_forbidden  — force without the ConfidenceOverride scope
 *   6. force_reason_too_short — force with a too-short reason
 *   7. scope-before-reason precedence — no scope AND short reason -> force_forbidden
 */
import { describe, it, expect } from "vitest";
import {
  claimPolicyEvaluator,
  MIN_FORCE_REASON_LENGTH,
  type ClaimPolicyInput,
  type ConfidenceReport,
} from "../../src/services/claim-policy-evaluator.js";
import { EnforcementMode } from "../../src/lib/enforcement-mode.js";
import { SCOPES } from "../../src/services/scopes.js";
import type { AgentActor } from "../../src/types/auth.js";
import type { QualityFinding } from "../../src/lib/confidence.js";

function finding(overrides: Partial<QualityFinding> = {}): QualityFinding {
  return {
    code: "missing_or_thin_description",
    severity: "blocking",
    dimension: "completeness",
    message: "description is thin",
    suggestion: "Add more detail to the description",
    ...overrides,
  };
}

function makeReport(overrides: Partial<ConfidenceReport> = {}): ConfidenceReport {
  return {
    score: 80,
    missing: [],
    subscores: {
      completeness: 0,
      concreteness: 0,
      testability: 0,
      scopeClarity: 0,
      contextQuality: 0,
      structure: 0,
      ambiguityRisk: 0,
    },
    findings: [],
    blocking: false,
    ...overrides,
  };
}

function makeActor(overrides: Partial<AgentActor> = {}): AgentActor {
  return {
    type: "agent",
    tokenId: "agent-1",
    teamId: "team-1",
    userId: "user-1",
    scopes: [SCOPES.ConfidenceOverride],
    ...overrides,
  };
}

function makeInput(overrides: Partial<ClaimPolicyInput> = {}): ClaimPolicyInput {
  return {
    task: { id: "task-1", projectId: "proj-1" },
    report: makeReport(),
    projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60 },
    actor: makeActor(),
    force: false,
    forceReason: "",
    route: "claim",
    ...overrides,
  };
}

describe("ClaimPolicyEvaluator.evaluate", () => {
  it("cell 1 — allow: score >= threshold and not blocking, no force", () => {
    const decision = claimPolicyEvaluator.evaluate(
      makeInput({
        report: makeReport({ score: 80, blocking: false }),
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60 },
        force: false,
      }),
    );

    expect(decision.kind).toBe("allow");
    if (decision.kind === "allow") {
      expect(decision.audit).toBeUndefined();
    }
  });

  it("cell 2 — block_low_readiness: score < threshold, no force", () => {
    const findings = [finding()];
    const decision = claimPolicyEvaluator.evaluate(
      makeInput({
        report: makeReport({ score: 10, blocking: false, missing: ["acceptanceCriteria"], findings }),
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60 },
        force: false,
      }),
    );

    expect(decision.kind).toBe("block_low_readiness");
    if (decision.kind === "block_low_readiness") {
      expect(decision.audit.action).toBe("task.claim_blocked_low_readiness");
      expect(decision.audit.actorId).toBe("agent-1");
      expect(decision.audit.taskId).toBe("task-1");
      expect(decision.audit.projectId).toBe("proj-1");
      expect(decision.audit.payload).toMatchObject({
        score: 10,
        threshold: 60,
        keystoneBlocked: false,
        missing: ["acceptanceCriteria"],
        findings,
        route: "claim",
        actorType: "agent",
      });
      expect(decision.nextActions.length).toBeGreaterThan(0);
    }
  });

  it("cell 3 — force override in a BLOCK state with sufficient scope + valid reason", () => {
    const reason = "spike-investigation-on-flaky-CI";
    expect(reason.length).toBeGreaterThanOrEqual(MIN_FORCE_REASON_LENGTH);

    const decision = claimPolicyEvaluator.evaluate(
      makeInput({
        report: makeReport({ score: 10, blocking: true }),
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60 },
        actor: makeActor({ scopes: [SCOPES.ConfidenceOverride], userId: "operator-1" }),
        force: true,
        forceReason: reason,
        route: "start",
      }),
    );

    expect(decision.kind).toBe("allow");
    if (decision.kind === "allow") {
      expect(decision.audit).toBeDefined();
      expect(decision.audit?.action).toBe("task.claim_override_used");
      expect(decision.audit?.actorId).toBe("agent-1");
      expect(decision.audit?.taskId).toBe("task-1");
      expect(decision.audit?.projectId).toBe("proj-1");
      expect(decision.audit?.payload).toMatchObject({
        score: 10,
        threshold: 60,
        forceReason: reason,
        keystoneBlocked: true,
        operatorUserId: "operator-1",
        route: "start",
        actorType: "agent",
      });
    }
  });

  it("cell 4 — force no-op: force supplied but nothing would block (allow state) — no override audit", () => {
    const decision = claimPolicyEvaluator.evaluate(
      makeInput({
        report: makeReport({ score: 80, blocking: false }),
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60 },
        actor: makeActor({ scopes: [SCOPES.ConfidenceOverride] }),
        force: true,
        forceReason: "harmless-explicit-force",
      }),
    );

    expect(decision.kind).toBe("allow");
    if (decision.kind === "allow") {
      // Nothing would block, so force is a no-op: no override (or any) audit.
      expect(decision.audit).toBeUndefined();
    }
  });

  it("cell 5 — force_forbidden: force requested without the ConfidenceOverride scope", () => {
    const decision = claimPolicyEvaluator.evaluate(
      makeInput({
        report: makeReport({ score: 10, blocking: false }),
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60 },
        actor: makeActor({ scopes: ["tasks:read", "tasks:claim", "tasks:transition"] }),
        force: true,
        forceReason: "trying-to-self-exempt",
      }),
    );

    expect(decision.kind).toBe("force_forbidden");
    if (decision.kind === "force_forbidden") {
      expect(decision.message).toContain(SCOPES.ConfidenceOverride);
    }
  });

  it("cell 6 — force_reason_too_short: force with a reason under MIN_FORCE_REASON_LENGTH", () => {
    const shortReason = "x".repeat(MIN_FORCE_REASON_LENGTH - 1);
    const decision = claimPolicyEvaluator.evaluate(
      makeInput({
        report: makeReport({ score: 10, blocking: false }),
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60 },
        actor: makeActor({ scopes: [SCOPES.ConfidenceOverride] }),
        force: true,
        forceReason: shortReason,
      }),
    );

    expect(decision.kind).toBe("force_reason_too_short");
    if (decision.kind === "force_reason_too_short") {
      expect(decision.message).toContain(`at least ${MIN_FORCE_REASON_LENGTH} characters`);
    }
  });

  it("cell 7 — scope check precedes reason check: no scope AND short reason -> force_forbidden", () => {
    // The ONLY input where the order of the two force guards is observable:
    // missing ConfidenceOverride scope AND a too-short reason. The evaluator
    // checks scope BEFORE reason on purpose — an unauthorized actor must get a
    // 403 force_forbidden, not a 400 that implies "just lengthen the reason and
    // retry". A swap of the two guards turns this cell red.
    const decision = claimPolicyEvaluator.evaluate(
      makeInput({
        report: makeReport({ score: 10, blocking: false }),
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60 },
        actor: makeActor({ scopes: ["tasks:read", "tasks:claim", "tasks:transition"] }),
        force: true,
        forceReason: "x".repeat(MIN_FORCE_REASON_LENGTH - 1),
      }),
    );

    expect(decision.kind).toBe("force_forbidden");
  });
});
