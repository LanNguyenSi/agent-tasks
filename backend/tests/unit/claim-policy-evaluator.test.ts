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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  claimPolicyEvaluator,
  MIN_FORCE_REASON_LENGTH,
  type ClaimPolicyInput,
  type ConfidenceReport,
} from "../../src/services/claim-policy-evaluator.js";
import { EnforcementMode } from "../../src/lib/enforcement-mode.js";
import { SCOPES } from "../../src/services/scopes.js";
import type { AgentActor } from "../../src/types/auth.js";
import { calculateConfidence, type QualityFinding } from "../../src/lib/confidence.js";

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
    projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60, thresholdSource: "project" },
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
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60, thresholdSource: "project" },
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
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60, thresholdSource: "project" },
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
        thresholdSource: "project",
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
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60, thresholdSource: "project" },
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
        thresholdSource: "project",
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
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60, thresholdSource: "project" },
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
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60, thresholdSource: "project" },
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
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60, thresholdSource: "project" },
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
        projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 60, thresholdSource: "project" },
        actor: makeActor({ scopes: ["tasks:read", "tasks:claim", "tasks:transition"] }),
        force: true,
        forceReason: "x".repeat(MIN_FORCE_REASON_LENGTH - 1),
      }),
    );

    expect(decision.kind).toBe("force_forbidden");
  });

  // M2 (task f186b88b): the WARN-mode shadow audit is the one payload of the
  // three that was never unit-tested for the score/threshold shape at all —
  // pin `thresholdSource` here too, using a distinct "taskType" source value
  // (not the "project" every other test in this file uses). Scope honesty:
  // this exercises the evaluator echoing its INPUT into the payload; the
  // gate->evaluator plumbing itself is pinned end-to-end in
  // confidence-gate.audit.test.ts.
  it("WARN mode: a would-block claim shadow-logs task.claim_would_block_shadow with the resolved thresholdSource", () => {
    const decision = claimPolicyEvaluator.evaluate(
      makeInput({
        report: makeReport({ score: 70, blocking: false }),
        projectPolicy: { mode: EnforcementMode.WARN, threshold: 90, thresholdSource: "taskType" },
        force: false,
      }),
    );

    expect(decision.kind).toBe("allow");
    if (decision.kind === "allow") {
      expect(decision.audit).toBeDefined();
      expect(decision.audit?.action).toBe("task.claim_would_block_shadow");
      expect(decision.audit?.payload).toMatchObject({
        score: 70,
        threshold: 90,
        thresholdSource: "taskType",
        belowThreshold: true,
      });
    }
  });

  // ── Safety pin (task 6b88ec87 review round 1, "missing_tests" finding) ────
  // The M2 required-signal checker's escalation (confidence.ts,
  // calculateConfidence's `requiredSignalFindings` merge) sets a matched
  // finding's `severity` to "blocking" but MUST NEVER set `keystone: true` —
  // `ConfidenceResult.blocking` (the threshold-INDEPENDENT keystone flag
  // this evaluator's `wouldBlock` OR's in) is defined ONLY off
  // `keystone === true && severity === "blocking"`. If a future edit ever
  // makes the required-signal merge (or a new required-signal predicate)
  // start propagating `keystone: true`, EVERY project — including ones on a
  // low or disabled confidenceThreshold — would start hard-blocking claims
  // on required-signal gaps it never opted into, bypassing the threshold
  // entirely. This test pins the coupling from both ends: the real scorer's
  // output shape, and the evaluator's allow/block decision built on it.
  describe("safety pin: required-signal (M2) findings never trip the threshold-independent keystone", () => {
    beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
    afterEach(() => vi.restoreAllMocks());

    it("calculateConfidence: a typed task with required-signal BLOCKING findings and no universal keystone violation reports blocking=false", () => {
      // Migration-typed, AC present (no evals keystone), most migration
      // signals stated in prose but current_state is not — measured via
      // backend/dist (npm run build --workspace=backend) against a scratch
      // script, task 6b88ec87 review round 1.
      const description = [
        "Target state: the users table lives on the new Postgres cluster.",
        "Compatibility: the read API stays backward compatible during the cutover.",
        "Rollback: revert to the legacy cluster if replication lag spikes.",
        "Deployment impact: requires a brief maintenance window.",
        "Operational risk: on-call must watch replication lag; blast radius is the users service only.",
      ].join(" ");
      const report = calculateConfidence({
        title: "Migrate users table storage backend",
        description,
        templateData: {
          acceptanceCriteria: "- users table reads/writes succeed against the new backend",
          taskType: "migration",
        },
        templateFields: null,
      });

      const requiredSignalFinding = report.findings.find((f) => f.code === "missing_current_state");
      expect(requiredSignalFinding?.severity).toBe("blocking");
      expect(requiredSignalFinding?.keystone).toBeUndefined();
      expect(report.blocking).toBe(false);
      expect(report.score).toBeGreaterThanOrEqual(40);
    });

    it("ClaimPolicyEvaluator: that SAME real report, at enforcementMode=BLOCK with threshold <= score, is ALLOWED despite the blocking-severity required-signal finding", () => {
      const description = [
        "Target state: the users table lives on the new Postgres cluster.",
        "Compatibility: the read API stays backward compatible during the cutover.",
        "Rollback: revert to the legacy cluster if replication lag spikes.",
        "Deployment impact: requires a brief maintenance window.",
        "Operational risk: on-call must watch replication lag; blast radius is the users service only.",
      ].join(" ");
      const report = calculateConfidence({
        title: "Migrate users table storage backend",
        description,
        templateData: {
          acceptanceCriteria: "- users table reads/writes succeed against the new backend",
          taskType: "migration",
        },
        templateFields: null,
      });
      // Precondition: the fixture actually carries a blocking-severity
      // required-signal finding and a score at/above the threshold below —
      // otherwise this test would pass for the wrong reason.
      expect(report.findings.some((f) => f.code === "missing_current_state" && f.severity === "blocking")).toBe(true);
      expect(report.blocking).toBe(false);

      const decision = claimPolicyEvaluator.evaluate(
        makeInput({
          report,
          projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 40, thresholdSource: "project" },
          force: false,
        }),
      );

      expect(report.score).toBeGreaterThanOrEqual(40);
      expect(decision.kind).toBe("allow");
    });

    // ── Finding 3 (review round 2): the R1 pin above never actually hit the
    // escalation branch ────────────────────────────────────────────────────
    // The required-signal merge in calculateConfidence (confidence.ts) has
    // TWO branches: a NEW finding is pushed as-is (no `keystone` set), or an
    // EXISTING universal finding is escalated in place via `existing.severity
    // = "blocking"`. missing_current_state (used by the two tests above) has
    // no universal MISS_FINDINGS counterpart — it is a genuinely NEW code —
    // so those two tests only ever exercised the PUSH branch. A mutant adding
    // `existing.keystone = true` right after `existing.severity = "blocking"`
    // in the ESCALATION branch passed the full backend suite (1683/1683)
    // while flipping `report.blocking` from false to true on any typed task
    // missing an ALIASED signal (missing_goal/missing_scope/
    // missing_out_of_scope/missing_risk) — undetected, because nothing
    // exercised that branch with a keystone-purity assertion. This fixture
    // closes the gap: refactoring-typed, every required signal stated EXCEPT
    // outOfScope, so `missing_out_of_scope` (refactoring's own MISS_FINDINGS
    // entry is severity "info") is the one that escalates in place.
    describe("escalation-branch keystone purity (finding 3)", () => {
      const ESCALATION_DESCRIPTION = [
        "Purpose: simplify the internal request parser in src/services/parser.ts for readability.",
        "The refactor is functionally equivalent; there is no behavior change for callers.",
        "The existing test suite covers every branch, and CI must stay green.",
      ].join(" ");
      const ESCALATION_TEMPLATE_DATA = {
        scope: "src/services/parser.ts",
        risk: "Low: internal-only refactor, no public API change",
        acceptanceCriteria: "- existing parser test suite passes unchanged",
        taskType: "refactoring" as const,
        // outOfScope deliberately absent — the one signal this fixture misses.
      };

      it("calculateConfidence: missing_out_of_scope escalates to blocking with keystone left undefined", () => {
        const report = calculateConfidence({
          title: "Simplify the internal request parser",
          description: ESCALATION_DESCRIPTION,
          templateData: ESCALATION_TEMPLATE_DATA,
          templateFields: null,
        });
        const outOfScopeFindings = report.findings.filter((f) => f.code === "missing_out_of_scope");
        // Precondition: exactly one escalated entry, not a duplicate push.
        expect(outOfScopeFindings).toHaveLength(1);
        expect(outOfScopeFindings[0]?.severity).toBe("blocking");
        // The actual pin: escalation must never propagate `keystone`. A
        // mutant adding `existing.keystone = true` to the merge's escalation
        // branch turns this assertion (and the evaluator test below) red.
        expect(outOfScopeFindings[0]?.keystone).toBeUndefined();
        // No other refactoring required-signal code fires (isolation check).
        for (const code of ["missing_purpose", "missing_scope", "missing_behavior_preservation", "missing_regression_strategy", "missing_risk"]) {
          expect(report.findings.find((f) => f.code === code)).toBeUndefined();
        }
        expect(report.blocking).toBe(false);
        expect(report.score).toBeGreaterThanOrEqual(40);
      });

      it("ClaimPolicyEvaluator: that SAME real report, at EnforcementMode.BLOCK with threshold <= score, is ALLOWED despite the blocking-severity escalated finding", () => {
        const report = calculateConfidence({
          title: "Simplify the internal request parser",
          description: ESCALATION_DESCRIPTION,
          templateData: ESCALATION_TEMPLATE_DATA,
          templateFields: null,
        });
        // Precondition, restated so this test is self-contained.
        expect(report.findings.some((f) => f.code === "missing_out_of_scope" && f.severity === "blocking")).toBe(true);
        expect(report.blocking).toBe(false);

        const decision = claimPolicyEvaluator.evaluate(
          makeInput({
            report,
            projectPolicy: { mode: EnforcementMode.BLOCK, threshold: 40, thresholdSource: "project" },
            force: false,
          }),
        );

        // wouldBlock = belowThreshold || report.blocking. score >= 40 and
        // blocking is false, so this must allow. If the merge ever starts
        // setting `keystone: true` on an escalated finding, `report.blocking`
        // flips true and this decision flips to `block_low_readiness` — the
        // gate-level half of the same pin.
        expect(report.score).toBeGreaterThanOrEqual(40);
        expect(decision.kind).toBe("allow");
      });
    });
  });
});
