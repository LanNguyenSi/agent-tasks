/**
 * Pure unit tests for `evaluateGroundingGate`.
 *
 * The gate is a Phase 3 addition to the grounding-hint integration: when
 * a project opts in via `requireGroundingForDebug`, finishing a debug-
 * flavored task is gated on (a) a session, (b) ledger entries, and (c)
 * advancement past `claim-evaluation`. The function under test is pure
 * (no DB, no module loads, no I/O), so the suite stays fast and the
 * cascading-missing-fields semantics are easy to verify.
 *
 * Cross-cutting route behavior (audit log, 409 body, project select) is
 * covered in tasks-v2-routes.test.ts; here we only assert the gate's
 * decision table.
 */
import { describe, it, expect } from "vitest";
import { advancePhase, initSession } from "@lannguyensi/grounding-wrapper";
import {
  evaluateGroundingGate,
  CLAIM_EVALUATION_PHASE,
  PHASES_AT_OR_PAST_CLAIM_EVAL,
} from "../../src/services/gates/grounding-gate.js";

describe("evaluateGroundingGate", () => {
  it("allows when the project has not opted in (default)", () => {
    const result = evaluateGroundingGate({
      metadata: { debugFlavor: true },
      project: { requireGroundingForDebug: false },
      ledgerSummary: { entryCount: 0 },
      currentPhase: null,
    });
    expect(result).toEqual({
      allowed: true,
      missing: [],
      sessionId: null,
      currentPhase: null,
      entryCount: 0,
    });
  });

  it("allows when the task is not debug-flavored, even with the gate enabled", () => {
    const result = evaluateGroundingGate({
      metadata: { debugFlavor: false },
      project: { requireGroundingForDebug: true },
      ledgerSummary: { entryCount: 0 },
      currentPhase: null,
    });
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("allows when debugFlavor is undefined (un-classified task)", () => {
    // Defensive: a task that hasn't been classified yet should not be
    // blocked by the gate. The classifier runs on pickup/start, so a
    // `debugFlavor === undefined` row at finish time means classification
    // never happened, so bypass it for safety.
    const result = evaluateGroundingGate({
      metadata: {},
      project: { requireGroundingForDebug: true },
      ledgerSummary: { entryCount: 0 },
      currentPhase: null,
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks with all three missing markers when no session was started", () => {
    const result = evaluateGroundingGate({
      metadata: { debugFlavor: true },
      project: { requireGroundingForDebug: true },
      ledgerSummary: { entryCount: 0 },
      currentPhase: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual([
      "sessionStarted",
      "ledgerEntries",
      "claimEvaluationPhase",
    ]);
    expect(result.sessionId).toBeNull();
    expect(result.entryCount).toBe(0);
  });

  it("blocks with ledgerEntries+claimEvaluationPhase when session exists but no entries", () => {
    const result = evaluateGroundingGate({
      metadata: {
        debugFlavor: true,
        groundingSessionId: "sess-abc",
      },
      project: { requireGroundingForDebug: true },
      ledgerSummary: { entryCount: 0 },
      currentPhase: "scope-resolution",
    });
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual(["ledgerEntries", "claimEvaluationPhase"]);
    expect(result.sessionId).toBe("sess-abc");
    expect(result.currentPhase).toBe("scope-resolution");
  });

  it("blocks on claimEvaluationPhase only, when entries are present but phase is too early", () => {
    const result = evaluateGroundingGate({
      metadata: {
        debugFlavor: true,
        groundingSessionId: "sess-abc",
      },
      project: { requireGroundingForDebug: true },
      ledgerSummary: { entryCount: 3 },
      currentPhase: "scope-resolution",
    });
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual(["claimEvaluationPhase"]);
  });

  it("allows when at exactly claim-evaluation with at least one entry", () => {
    const result = evaluateGroundingGate({
      metadata: {
        debugFlavor: true,
        groundingSessionId: "sess-abc",
      },
      project: { requireGroundingForDebug: true },
      ledgerSummary: { entryCount: 3 },
      currentPhase: CLAIM_EVALUATION_PHASE,
    });
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.sessionId).toBe("sess-abc");
    expect(result.currentPhase).toBe(CLAIM_EVALUATION_PHASE);
    expect(result.entryCount).toBe(3);
  });

  it("allows the pinned wrapper's terminal complete phase", () => {
    const result = evaluateGroundingGate({
      metadata: {
        debugFlavor: true,
        groundingSessionId: "sess-abc",
      },
      project: { requireGroundingForDebug: true },
      ledgerSummary: { entryCount: 5 },
      currentPhase: "complete",
    });
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("uses the real pinned wrapper progression and rejects every earlier or foreign phase", () => {
    const session = initSession({ keyword: "agent service", problem: "Test compatibility" });
    const phases = [session.current_phase];
    while (session.current_phase !== "complete") phases.push(advancePhase(session).current_phase);

    expect(phases).toEqual([
      "scope-resolution",
      "doc-reading",
      "playbook-loading",
      "runtime-inspection",
      "evidence-collection",
      "claim-evaluation",
      "complete",
    ]);
    for (const phase of phases.slice(0, -2)) {
      expect(evaluateGroundingGate({
        metadata: { debugFlavor: true, groundingSessionId: session.id },
        project: { requireGroundingForDebug: true },
        ledgerSummary: { entryCount: 1 },
        currentPhase: phase,
      })).toMatchObject({ allowed: false, missing: ["claimEvaluationPhase"] });
    }
    for (const phase of ["post-incident-review", "unknown-phase"]) {
      expect(evaluateGroundingGate({
        metadata: { debugFlavor: true, groundingSessionId: session.id },
        project: { requireGroundingForDebug: true },
        ledgerSummary: { entryCount: 1 },
        currentPhase: phase,
      })).toMatchObject({ allowed: false, missing: ["claimEvaluationPhase"] });
    }
  });

  it("PHASES_AT_OR_PAST_CLAIM_EVAL is a stable legacy compatibility allowlist", () => {
    expect(PHASES_AT_OR_PAST_CLAIM_EVAL).toEqual([
      "claim-evaluation",
      "complete",
    ]);
    expect(PHASES_AT_OR_PAST_CLAIM_EVAL).toContain(CLAIM_EVALUATION_PHASE);
  });
});
