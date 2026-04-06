import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockProjectFindUnique,
  mockAgentTokenFindMany,
  mockTaskFindUnique,
  mockSignalCreate,
  mockLogAuditEvent,
} = vi.hoisted(() => ({
  mockProjectFindUnique: vi.fn(),
  mockAgentTokenFindMany: vi.fn(),
  mockTaskFindUnique: vi.fn(),
  mockSignalCreate: vi.fn().mockResolvedValue({ id: "sig-1" }),
  mockLogAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: mockProjectFindUnique },
    agentToken: { findMany: mockAgentTokenFindMany },
    task: { findUnique: mockTaskFindUnique },
    signal: { create: mockSignalCreate },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: mockLogAuditEvent,
}));

import { emitTaskAvailableSignal } from "../../src/services/task-signal.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockProjectFindUnique.mockResolvedValue({ teamId: "team-1" });
  mockAgentTokenFindMany.mockResolvedValue([]);
  mockTaskFindUnique.mockResolvedValue({
    id: "task-1", title: "New feature", status: "open", priority: "HIGH",
    branchName: null, prUrl: null, prNumber: null,
    project: { slug: "agent-tasks", name: "agent-tasks" },
  });
});

describe("emitTaskAvailableSignal", () => {
  it("emits signals to all agents with tasks:claim scope", async () => {
    mockAgentTokenFindMany.mockResolvedValue([
      { id: "agent-1", name: "Worker 1" },
      { id: "agent-2", name: "Worker 2" },
    ]);

    await emitTaskAvailableSignal("task-1", "proj-1", "human", "Lan");

    expect(mockSignalCreate).toHaveBeenCalledTimes(2);
    expect(mockSignalCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "task_available",
        taskId: "task-1",
        recipientAgentId: "agent-1",
      }),
    });
    expect(mockSignalCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "task_available",
        recipientAgentId: "agent-2",
      }),
    });
  });

  it("includes task context in signal payload", async () => {
    mockAgentTokenFindMany.mockResolvedValue([{ id: "agent-1", name: "Bot" }]);

    await emitTaskAvailableSignal("task-1", "proj-1", "human", "Lan");

    expect(mockSignalCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        context: expect.objectContaining({
          taskTitle: "New feature",
          taskStatus: "open",
          projectSlug: "agent-tasks",
          actor: { type: "human", name: "Lan" },
        }),
      }),
    });
  });

  it("does nothing if no eligible agents found", async () => {
    mockAgentTokenFindMany.mockResolvedValue([]);

    await emitTaskAvailableSignal("task-1", "proj-1", "human", "Lan");

    expect(mockSignalCreate).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it("does nothing if task not found", async () => {
    mockTaskFindUnique.mockResolvedValue(null);

    await emitTaskAvailableSignal("nonexistent", "proj-1", "human", "Lan");

    expect(mockSignalCreate).not.toHaveBeenCalled();
  });

  it("queries agents with tasks:claim scope", async () => {
    mockAgentTokenFindMany.mockResolvedValue([]);

    await emitTaskAvailableSignal("task-1", "proj-1", "agent", "Bot");

    expect(mockAgentTokenFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scopes: { has: "tasks:claim" },
          revokedAt: null,
        }),
      }),
    );
  });
});
