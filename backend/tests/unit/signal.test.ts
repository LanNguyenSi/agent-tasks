import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockSignalCreate,
  mockSignalCreateMany,
  mockSignalFindMany,
  mockSignalFindUnique,
  mockSignalUpdate,
} = vi.hoisted(() => ({
  mockSignalCreate: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "sig-1", ...args.data, createdAt: new Date().toISOString(), acknowledgedAt: null }),
  ),
  mockSignalCreateMany: vi.fn().mockResolvedValue({ count: 0 }),
  mockSignalFindMany: vi.fn().mockResolvedValue([]),
  mockSignalFindUnique: vi.fn(),
  mockSignalUpdate: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "sig-1", ...args.data }),
  ),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    signal: {
      create: mockSignalCreate,
      createMany: mockSignalCreateMany,
      findMany: mockSignalFindMany,
      findUnique: mockSignalFindUnique,
      update: mockSignalUpdate,
    },
  },
}));

import { createSignal, createSignals, getAgentSignals, acknowledgeSignal } from "../../src/services/signal.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const baseContext = {
  taskTitle: "Fix bug",
  taskStatus: "review",
  projectSlug: "agent-tasks",
  projectName: "agent-tasks",
  actor: { type: "agent" as const, name: "Worker" },
};

describe("createSignal", () => {
  it("creates a signal with correct fields", async () => {
    await createSignal({
      type: "review_needed",
      taskId: "task-1",
      projectId: "proj-1",
      recipientAgentId: "agent-reviewer",
      context: baseContext,
    });

    expect(mockSignalCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "review_needed",
        taskId: "task-1",
        projectId: "proj-1",
        recipientAgentId: "agent-reviewer",
        recipientUserId: null,
      }),
    });
  });

  it("sets recipientUserId for human recipients", async () => {
    await createSignal({
      type: "review_needed",
      taskId: "task-1",
      projectId: "proj-1",
      recipientUserId: "user-1",
      context: baseContext,
    });

    expect(mockSignalCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientAgentId: null,
        recipientUserId: "user-1",
      }),
    });
  });
});

describe("createSignals (batch)", () => {
  it("creates multiple signals in one call", async () => {
    await createSignals([
      { type: "review_needed", taskId: "t1", projectId: "p1", recipientAgentId: "a1", context: baseContext },
      { type: "review_needed", taskId: "t1", projectId: "p1", recipientAgentId: "a2", context: baseContext },
    ]);

    expect(mockSignalCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ recipientAgentId: "a1" }),
        expect.objectContaining({ recipientAgentId: "a2" }),
      ]),
    });
  });
});

describe("getAgentSignals", () => {
  it("queries unacknowledged signals for agent token", async () => {
    await getAgentSignals("agent-1");

    expect(mockSignalFindMany).toHaveBeenCalledWith({
      where: {
        recipientAgentId: "agent-1",
        acknowledgedAt: null,
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
  });

  it("respects limit parameter", async () => {
    await getAgentSignals("agent-1", { limit: 10 });

    expect(mockSignalFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    );
  });
});

describe("acknowledgeSignal", () => {
  it("acknowledges a signal owned by the agent", async () => {
    mockSignalFindUnique.mockResolvedValue({
      id: "sig-1",
      recipientAgentId: "agent-1",
      recipientUserId: null,
    });

    const result = await acknowledgeSignal("sig-1", "agent-1");

    expect(mockSignalUpdate).toHaveBeenCalledWith({
      where: { id: "sig-1" },
      data: { acknowledgedAt: expect.any(Date) },
    });
    expect(result).toBeTruthy();
  });

  it("returns null if signal does not exist", async () => {
    mockSignalFindUnique.mockResolvedValue(null);

    const result = await acknowledgeSignal("nonexistent", "agent-1");
    expect(result).toBeNull();
  });

  it("returns null if agent does not own the signal", async () => {
    mockSignalFindUnique.mockResolvedValue({
      id: "sig-1",
      recipientAgentId: "agent-other",
      recipientUserId: null,
    });

    const result = await acknowledgeSignal("sig-1", "agent-1");
    expect(result).toBeNull();
    expect(mockSignalUpdate).not.toHaveBeenCalled();
  });

  it("allows human to acknowledge their own signal", async () => {
    mockSignalFindUnique.mockResolvedValue({
      id: "sig-1",
      recipientAgentId: null,
      recipientUserId: "user-1",
    });

    const result = await acknowledgeSignal("sig-1", undefined, "user-1");
    expect(mockSignalUpdate).toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
