/**
 * Unit tests for `checkSelfMergeGate`. This is the rule that prevents an
 * actor from merging a PR on a task it holds the work claim for, when the
 * project opts into `requireDistinctReviewer` and is not in soloMode.
 *
 * The gate is shared by three call sites (the task-scoped `/tasks/:id/merge`
 * verb, the GitHub-keyed `/github/pull-requests/:n/merge` route, and the
 * `autoMerge: true` branches of `task_finish`). Covering the rule here once
 * means the call-site tests can focus on wiring rather than rule semantics.
 */
import { describe, it, expect } from "vitest";
import { checkSelfMergeGate } from "../../src/services/review-gate.js";
import type { Actor } from "../../src/types/auth.js";

const humanActor = (userId: string): Actor => ({
  type: "human",
  userId,
  teamId: "team-1",
});

const agentActor = (tokenId: string): Actor => ({
  type: "agent",
  tokenId,
  teamId: "team-1",
  scopes: [],
});

const task = (
  overrides: Partial<{
    claimedByUserId: string | null;
    claimedByAgentId: string | null;
  }> = {},
) => ({
  claimedByUserId: null,
  claimedByAgentId: null,
  ...overrides,
});

describe("checkSelfMergeGate", () => {
  it("allows the merge when the project has distinct-reviewer off", () => {
    const r = checkSelfMergeGate(
      task({ claimedByAgentId: "agent-1" }),
      agentActor("agent-1"),
      { requireDistinctReviewer: false, soloMode: false },
    );
    expect(r.allowed).toBe(true);
  });

  it("allows the merge in soloMode even when the actor is the claimant", () => {
    // soloMode is the explicit opt-out — single-agent projects deliberately
    // let the author self-merge.
    const r = checkSelfMergeGate(
      task({ claimedByAgentId: "agent-1" }),
      agentActor("agent-1"),
      { requireDistinctReviewer: true, soloMode: true },
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks an agent from merging its own PR when DR is on and not solo", () => {
    const r = checkSelfMergeGate(
      task({ claimedByAgentId: "agent-1" }),
      agentActor("agent-1"),
      { requireDistinctReviewer: true, soloMode: false },
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("self_merge_blocked");
  });

  it("blocks a human from merging their own PR when DR is on and not solo", () => {
    const r = checkSelfMergeGate(
      task({ claimedByUserId: "user-1" }),
      humanActor("user-1"),
      { requireDistinctReviewer: true, soloMode: false },
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("self_merge_blocked");
  });

  it("allows a different agent to merge the PR (distinct reviewer path)", () => {
    const r = checkSelfMergeGate(
      task({ claimedByAgentId: "agent-1" }),
      agentActor("agent-2"),
      { requireDistinctReviewer: true, soloMode: false },
    );
    expect(r.allowed).toBe(true);
  });

  it("allows merge when there is no work claim on the task", () => {
    // Edge case: task created without a claim (e.g. imported from GitHub).
    // The gate is purely about "caller == claimant"; absent a claimant, no
    // one is structurally blocked.
    const r = checkSelfMergeGate(
      task(),
      agentActor("agent-1"),
      { requireDistinctReviewer: true, soloMode: false },
    );
    expect(r.allowed).toBe(true);
  });

  it("does not cross-match agent tokenId against human claimedByUserId", () => {
    // An agent tokenId and a user userId can collide by accident (both are
    // uuids). The gate must compare actor.type-matched fields only.
    const r = checkSelfMergeGate(
      task({ claimedByUserId: "same-uuid", claimedByAgentId: null }),
      agentActor("same-uuid"),
      { requireDistinctReviewer: true, soloMode: false },
    );
    expect(r.allowed).toBe(true);
  });
});
