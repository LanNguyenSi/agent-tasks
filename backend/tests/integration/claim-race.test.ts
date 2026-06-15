/**
 * Regression test: parallel-claims CAS exclusion.
 *
 * Two agents simultaneously POST /tasks/:id/claim.  The atomic
 * compare-and-swap (updateMany guarded on claimedBy* IS NULL) must allow
 * exactly one winner (200 in_progress) and reject the other (409
 * conflict).  Without the CAS guard both requests would pass the
 * synchronous null-check and produce a double-claim.
 *
 * Prisma is fully mocked (no DB).  Two Hono apps each carry a distinct
 * AgentActor (tokenId "local-1" vs "local-2") so the race is between
 * recognisably different actors.
 *
 * Mock-queue discipline (per project feedback):
 *   - taskFindUnique: two `mockResolvedValueOnce` consumptions for the
 *     parallel initial fetches; a persistent `mockResolvedValue` fallback
 *     for the winner's re-fetch (count===1 path re-fetches after CAS).
 *   - taskUpdateMany: `mockResolvedValueOnce({count:1})` then
 *     `mockResolvedValueOnce({count:0})` — both consumed within this
 *     single test, leaving no residue for a follow-on test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { AgentActor } from "../../src/types/auth.js";

// ── Prisma mock ───────────────────────────────────────────────────────────────

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  taskUpdateMany: vi.fn(),
  workflowFindFirst: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      findMany: prismaMocks.taskFindMany,
      updateMany: prismaMocks.taskUpdateMany,
    },
    workflow: {
      findFirst: prismaMocks.workflowFindFirst,
    },
  },
}));

// ── Access / audit mocks ──────────────────────────────────────────────────────

vi.mock("../../src/services/team-access.js", () => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  resolveTeamId: vi.fn().mockResolvedValue({ ok: true, teamId: "team-x" }),
  resolveTeamIdErrorBody: vi.fn().mockReturnValue({ error: "bad_request" }),
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// ── Signal / side-effect mocks — not called by /claim but imported by tasks.ts

vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: vi.fn().mockResolvedValue(undefined),
  emitChangesRequestedSignal: vi.fn().mockResolvedValue(undefined),
  emitTaskApprovedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/task-signal.js", () => ({
  emitTaskAvailableSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/force-transition-signal.js", () => ({
  emitForceTransitionedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/self-merge-notice.js", () => ({
  emitSelfMergeNoticeIfApplicable: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../src/services/github-merge.js", () => ({
  performPrMerge: vi.fn(),
}));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/services/grounding-client.js", () => ({
  getGroundingClient: () => ({
    start: vi.fn().mockResolvedValue(null),
    getLedgerSummary: vi.fn().mockResolvedValue({ entryCount: 0 }),
  }),
  RealGroundingClient: class {},
  NullGroundingClient: class {},
  __resetGroundingClientCacheForTests: () => {},
}));

// ── Import taskRouter AFTER all vi.mock declarations ─────────────────────────
import { taskRouter } from "../../src/routes/tasks.js";

// ── Actor definitions ─────────────────────────────────────────────────────────
//
// Unit / integration tests: inject the actor shape directly into the Hono
// context using a pre-middleware — no token or DB lookup required.
// For a live backend, obtain tokens via POST /api/agent-tokens (see
// docs/testing/agent-credentials.md for both flavors).

const AGENT_1: AgentActor = {
  type: "agent",
  tokenId: "local-1",
  teamId: "team-x",
  userId: "user-x",
  scopes: ["tasks:read", "tasks:claim", "tasks:transition"],
};

const AGENT_2: AgentActor = {
  type: "agent",
  tokenId: "local-2",
  teamId: "team-x",
  userId: "user-x",
  scopes: ["tasks:read", "tasks:claim", "tasks:transition"],
};

/** Minimal Hono app that bypasses auth by injecting an actor pre-middleware. */
function makeApp(actor: AgentActor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

// ── Task fixture ──────────────────────────────────────────────────────────────

const openTask = {
  id: "task-1",
  projectId: "proj-1",
  title: "Write integration test",
  description: "Prove the CAS exclusion prevents a double-claim.",
  status: "open",
  priority: "MEDIUM",
  workflowId: null,
  workflow: null,
  templateData: null,
  createdByAgentId: null,
  createdByUserId: "user-x",
  claimedByAgentId: null,
  claimedByUserId: null,
  claimedAt: null,
  reviewClaimedByAgentId: null,
  reviewClaimedByUserId: null,
  reviewClaimedAt: null,
  branchName: null,
  prUrl: null,
  prNumber: null,
  result: null,
  autoMergeSha: null,
  project: {
    id: "proj-1",
    teamId: "team-x",
    githubRepo: null,
    confidenceThreshold: 0,
    taskTemplate: null,
    enforcementMode: null, // resolves to WARN → gate always passes
  },
  attachments: [],
  comments: [],
  claimedByUser: null,
  claimedByAgent: null,
  blockedBy: [],
  blocks: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /tasks/:id/claim — parallel-claims CAS exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Initial fetches (both requests): unclaimed open task.
    // Persistent fallback (mockResolvedValue) serves the winner's re-fetch
    // after the successful CAS; we override the first two calls with
    // mockResolvedValueOnce so the re-fetch can return the claimed row.
    prismaMocks.taskFindUnique
      .mockResolvedValueOnce(openTask) // initial fetch for request A
      .mockResolvedValueOnce(openTask) // initial fetch for request B
      .mockResolvedValue({ ...openTask, status: "in_progress", claimedByAgentId: "local-x" });

    // No blocking dependencies.
    prismaMocks.taskFindMany.mockResolvedValue([]);

    // No project-default workflow — falls through to the built-in definition.
    // The default open→in_progress transition has no `requires` rules, so
    // evaluateTransitionRules returns immediately with no failures.
    prismaMocks.workflowFindFirst.mockResolvedValue(null);

    // CAS result: first caller wins the lock, second sees count:0 and gets 409.
    // Both mockResolvedValueOnce entries are fully consumed within this test.
    prismaMocks.taskUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
  });

  it("exactly one 200 (in_progress) and one 409 (conflict) when two agents claim simultaneously", async () => {
    const appA = makeApp(AGENT_1);
    const appB = makeApp(AGENT_2);

    const [resA, resB] = await Promise.all([
      appA.request("/tasks/task-1/claim", { method: "POST" }),
      appB.request("/tasks/task-1/claim", { method: "POST" }),
    ]);

    // Exactly one success, one rejection — the CAS guarantee.
    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    // Identify winner and loser.
    const winner = resA.status === 200 ? resA : resB;
    const loser = resA.status === 409 ? resA : resB;

    // Winner: response shape has the task in in_progress state.
    const winBody = (await winner.json()) as { task: { status: string } };
    expect(winBody.task.status).toBe("in_progress");

    // Loser: error field matches the value produced by conflict() in
    // backend/src/middleware/error.ts → errorResponse(c, 409, "conflict", ...).
    const loseBody = (await loser.json()) as { error: string; message: string };
    expect(loseBody.error).toBe("conflict");
    expect(typeof loseBody.message).toBe("string");

    // Both requests reached the atomic write — the CAS guard fired twice.
    expect(prismaMocks.taskUpdateMany).toHaveBeenCalledTimes(2);

    // Both calls used the unclaimed-row guard so a real DB could enforce
    // the exclusion as a WHERE predicate (the CAS contract).
    for (const call of prismaMocks.taskUpdateMany.mock.calls) {
      expect(call[0].where).toMatchObject({
        id: "task-1",
        claimedByUserId: null,
        claimedByAgentId: null,
      });
    }
  });
});
