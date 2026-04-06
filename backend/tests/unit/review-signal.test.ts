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
    mockAgentTokenFindMany.mockResolvedValue([]);
    mockTeamMemberFindMany.mockResolvedValue([]);

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
