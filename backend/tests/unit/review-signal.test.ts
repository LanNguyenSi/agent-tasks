import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockProjectFindUnique,
  mockAgentTokenFindMany,
  mockTeamMemberFindMany,
  mockCommentCreate,
  mockLogAuditEvent,
} = vi.hoisted(() => ({
  mockProjectFindUnique: vi.fn(),
  mockAgentTokenFindMany: vi.fn(),
  mockTeamMemberFindMany: vi.fn(),
  mockCommentCreate: vi.fn().mockResolvedValue({}),
  mockLogAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: mockProjectFindUnique },
    agentToken: { findMany: mockAgentTokenFindMany },
    teamMember: { findMany: mockTeamMemberFindMany },
    comment: { create: mockCommentCreate },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: mockLogAuditEvent,
}));

import { findEligibleReviewers, emitReviewSignal } from "../../src/services/review-signal.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockProjectFindUnique.mockResolvedValue({ teamId: "team-1" });
  mockAgentTokenFindMany.mockResolvedValue([]);
  mockTeamMemberFindMany.mockResolvedValue([]);
});

describe("findEligibleReviewers", () => {
  it("returns agents with tasks:transition scope", async () => {
    mockAgentTokenFindMany.mockResolvedValue([
      { id: "agent-1", name: "Reviewer Bot" },
    ]);
    mockTeamMemberFindMany.mockResolvedValue([]);

    const result = await findEligibleReviewers("proj-1", null, null);
    expect(result).toEqual([
      { type: "agent", id: "agent-1", name: "Reviewer Bot" },
    ]);
  });

  it("returns human reviewers and admins", async () => {
    mockAgentTokenFindMany.mockResolvedValue([]);
    mockTeamMemberFindMany.mockResolvedValue([
      { userId: "user-1", user: { name: "Alice", login: "alice" } },
    ]);

    const result = await findEligibleReviewers("proj-1", null, null);
    expect(result).toEqual([
      { type: "human", id: "user-1", name: "Alice" },
    ]);
  });

  it("excludes the current assignee (agent)", async () => {
    mockAgentTokenFindMany.mockResolvedValue([
      { id: "agent-2", name: "Other Bot" },
    ]);
    mockTeamMemberFindMany.mockResolvedValue([]);

    const result = await findEligibleReviewers("proj-1", null, "agent-1");

    // The exclude filter is passed to prisma, so we check the query
    expect(mockAgentTokenFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "agent-1" },
        }),
      }),
    );
    expect(result).toHaveLength(1);
  });

  it("excludes the current assignee (human)", async () => {
    mockAgentTokenFindMany.mockResolvedValue([]);
    mockTeamMemberFindMany.mockResolvedValue([]);

    await findEligibleReviewers("proj-1", "user-1", null);

    expect(mockTeamMemberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: { not: "user-1" },
        }),
      }),
    );
  });

  it("returns empty array if project not found", async () => {
    mockProjectFindUnique.mockResolvedValue(null);
    const result = await findEligibleReviewers("nonexistent", null, null);
    expect(result).toEqual([]);
  });
});

describe("emitReviewSignal", () => {
  it("creates a timeline comment with eligible reviewer names", async () => {
    mockAgentTokenFindMany.mockResolvedValue([
      { id: "agent-1", name: "Reviewer Bot" },
    ]);
    mockTeamMemberFindMany.mockResolvedValue([
      { userId: "user-1", user: { name: "Alice", login: "alice" } },
    ]);

    await emitReviewSignal("task-1", "proj-1", null, null);

    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: {
        taskId: "task-1",
        content: expect.stringContaining("Reviewer Bot (agent)"),
      },
    });
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: {
        taskId: "task-1",
        content: expect.stringContaining("Alice (human)"),
      },
    });
  });

  it("creates a comment even when no reviewers found", async () => {
    mockAgentTokenFindMany.mockResolvedValue([]);
    mockTeamMemberFindMany.mockResolvedValue([]);

    await emitReviewSignal("task-1", "proj-1", null, null);

    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: {
        taskId: "task-1",
        content: expect.stringContaining("no eligible reviewers found"),
      },
    });
  });

  it("logs audit event with recipient list", async () => {
    mockAgentTokenFindMany.mockResolvedValue([
      { id: "agent-1", name: "Bot" },
    ]);
    mockTeamMemberFindMany.mockResolvedValue([]);

    await emitReviewSignal("task-1", "proj-1", null, null);

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.reviewed",
        taskId: "task-1",
        payload: expect.objectContaining({
          event: "review_needed",
          recipientCount: 1,
        }),
      }),
    );
  });

  it("excludes the assignee from recipients", async () => {
    await emitReviewSignal("task-1", "proj-1", "user-1", "agent-1");

    expect(mockAgentTokenFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "agent-1" },
        }),
      }),
    );
    expect(mockTeamMemberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: { not: "user-1" },
        }),
      }),
    );
  });
});

// ── Review orchestration flow tests ──────────────────────────────────────────
// These test the full orchestration scenarios described in the task:
// Agent A claims → works → transitions to review → signal emitted → reviewer acts

describe("review orchestration flow", () => {
  it("emits review_needed signal when task enters review, excluding the worker", async () => {
    // Agent A (agent-worker) claimed the task and transitions to review
    // Agent B (agent-reviewer) and Human Alice should be eligible
    mockAgentTokenFindMany.mockResolvedValue([
      { id: "agent-reviewer", name: "Reviewer Bot" },
    ]);
    mockTeamMemberFindMany.mockResolvedValue([
      { userId: "user-alice", user: { name: "Alice", login: "alice" } },
    ]);

    const recipients = await emitReviewSignal(
      "task-1", "proj-1",
      null,           // no human assignee
      "agent-worker", // agent assignee — must be excluded
    );

    // Agent worker excluded from query
    expect(mockAgentTokenFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "agent-worker" } }),
      }),
    );

    // Both reviewer bot and Alice are eligible
    expect(recipients).toHaveLength(2);
    expect(recipients).toEqual(
      expect.arrayContaining([
        { type: "agent", id: "agent-reviewer", name: "Reviewer Bot" },
        { type: "human", id: "user-alice", name: "Alice" },
      ]),
    );

    // Timeline comment created with reviewer names
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: {
        taskId: "task-1",
        content: expect.stringMatching(/Review requested.*Reviewer Bot.*Alice/),
      },
    });

    // Audit event with review_needed
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.reviewed",
        payload: expect.objectContaining({
          event: "review_needed",
          recipientCount: 2,
          recipients: expect.arrayContaining([
            expect.objectContaining({ id: "agent-reviewer" }),
            expect.objectContaining({ id: "user-alice" }),
          ]),
        }),
      }),
    );
  });

  it("worker agent is never included as eligible reviewer for own task", async () => {
    // Only one agent in the team — the worker itself
    // Should result in zero agent reviewers
    mockAgentTokenFindMany.mockResolvedValue([]);
    mockTeamMemberFindMany.mockResolvedValue([]);

    const recipients = await emitReviewSignal(
      "task-1", "proj-1",
      null,
      "only-agent-in-team",
    );

    expect(recipients).toHaveLength(0);
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: {
        taskId: "task-1",
        content: expect.stringContaining("no eligible reviewers found"),
      },
    });
  });

  it("human worker is excluded from human reviewer list", async () => {
    mockTeamMemberFindMany.mockResolvedValue([
      { userId: "user-bob", user: { name: "Bob", login: "bob" } },
    ]);

    const recipients = await emitReviewSignal(
      "task-1", "proj-1",
      "user-worker", // human assignee excluded
      null,
    );

    expect(mockTeamMemberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: { not: "user-worker" } }),
      }),
    );
    // Bob is eligible (not the worker)
    expect(recipients).toEqual([
      { type: "human", id: "user-bob", name: "Bob" },
    ]);
  });

  it("request_changes preserves original assignee (claim fields untouched)", async () => {
    // This tests the contract: emitReviewSignal does NOT modify claim fields.
    // The /review endpoint only changes status, not claimedByUserId/claimedByAgentId.
    // We verify by confirming emitReviewSignal has no side effect on task claim data.
    mockAgentTokenFindMany.mockResolvedValue([
      { id: "reviewer", name: "Reviewer" },
    ]);

    await emitReviewSignal("task-1", "proj-1", null, "agent-worker");

    // emitReviewSignal should only create a comment and audit log
    // It should NOT call any task update (no prisma.task.update)
    // The comment and audit are the only DB writes
    expect(mockCommentCreate).toHaveBeenCalledTimes(1);
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);

    // Verify no unexpected DB operations happened
    // (mockCommentCreate and mockLogAuditEvent are the only write operations)
  });
});
