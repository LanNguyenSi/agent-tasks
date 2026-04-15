/**
 * Unit tests for emitForceTransitionedSignal.
 *
 * Mocks prisma at the module boundary so no DB is required. The service
 * under test is small; the tests pin the observable contracts (recipient
 * computation, self-exclusion, context shape, error containment) so a
 * regression would require a conscious change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the prisma module BEFORE importing the service under test.
const findUniqueTaskMock = vi.fn();
const findUniqueUserMock = vi.fn();
const createSignalMock = vi.fn();

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findUnique: (...args: unknown[]) => findUniqueTaskMock(...args) },
    user: { findUnique: (...args: unknown[]) => findUniqueUserMock(...args) },
    signal: { create: (...args: unknown[]) => createSignalMock(...args) },
  },
}));

// Import AFTER the mock so the service picks up the mocked prisma.
const { emitForceTransitionedSignal } = await import(
  "../../src/services/force-transition-signal.js"
);

function fakeTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "task-1",
    title: "Ship the thing",
    status: "done",
    projectId: "proj-1",
    project: { slug: "alpha", name: "Alpha" },
    branchName: "feat/x",
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
    claimedByUserId: null as string | null,
    claimedByAgentId: null as string | null,
    reviewClaimedByUserId: null as string | null,
    reviewClaimedByAgentId: null as string | null,
    ...overrides,
  };
}

describe("emitForceTransitionedSignal", () => {
  beforeEach(() => {
    findUniqueTaskMock.mockReset();
    findUniqueUserMock.mockReset();
    createSignalMock.mockReset();
    findUniqueUserMock.mockResolvedValue({ login: "admin-user", name: "Admin User" });
    createSignalMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one signal per distinct recipient (claimant + reviewer)", async () => {
    findUniqueTaskMock.mockResolvedValue(
      fakeTask({ claimedByUserId: "alice", reviewClaimedByUserId: "bob" }),
    );
    const count = await emitForceTransitionedSignal({
      taskId: "task-1",
      projectId: "proj-1",
      from: "review",
      to: "done",
      forcedRules: ["ciGreen"],
      forcedByUserId: "admin-1",
    });
    expect(count).toBe(2);
    expect(createSignalMock).toHaveBeenCalledTimes(2);
  });

  it("excludes the forcing admin from their own signal", async () => {
    findUniqueTaskMock.mockResolvedValue(
      fakeTask({ claimedByUserId: "alice", reviewClaimedByUserId: "admin-1" }),
    );
    const count = await emitForceTransitionedSignal({
      taskId: "task-1",
      projectId: "proj-1",
      from: "review",
      to: "done",
      forcedRules: ["prMerged"],
      forcedByUserId: "admin-1",
    });
    expect(count).toBe(1);
    const recipients = createSignalMock.mock.calls.map(
      (call) => (call[0] as { data: { recipientUserId: string } }).data.recipientUserId,
    );
    expect(recipients).toEqual(["alice"]);
  });

  it("notifies both user and agent when task has mixed claimants", async () => {
    findUniqueTaskMock.mockResolvedValue(
      fakeTask({ claimedByUserId: "alice", reviewClaimedByAgentId: "agent-token-1" }),
    );
    const count = await emitForceTransitionedSignal({
      taskId: "task-1",
      projectId: "proj-1",
      from: "review",
      to: "done",
      forcedRules: ["ciGreen"],
      forcedByUserId: "admin-1",
    });
    expect(count).toBe(2);
    const calls = createSignalMock.mock.calls.map(
      (call) =>
        (call[0] as { data: { recipientUserId: string | null; recipientAgentId: string | null } })
          .data,
    );
    expect(calls.some((d) => d.recipientUserId === "alice")).toBe(true);
    expect(calls.some((d) => d.recipientAgentId === "agent-token-1")).toBe(true);
  });

  it("emits zero signals when task has neither claimant nor reviewer", async () => {
    findUniqueTaskMock.mockResolvedValue(fakeTask());
    const count = await emitForceTransitionedSignal({
      taskId: "task-1",
      projectId: "proj-1",
      from: "review",
      to: "done",
      forcedRules: ["ciGreen"],
      forcedByUserId: "admin-1",
    });
    expect(count).toBe(0);
    expect(createSignalMock).not.toHaveBeenCalled();
  });

  it("deduplicates when the same user is both claimant and reviewer", async () => {
    findUniqueTaskMock.mockResolvedValue(
      fakeTask({ claimedByUserId: "alice", reviewClaimedByUserId: "alice" }),
    );
    const count = await emitForceTransitionedSignal({
      taskId: "task-1",
      projectId: "proj-1",
      from: "review",
      to: "done",
      forcedRules: ["ciGreen"],
      forcedByUserId: "admin-1",
    });
    expect(count).toBe(1);
  });

  it("includes forceReason and forcedRules in the signal context", async () => {
    findUniqueTaskMock.mockResolvedValue(fakeTask({ claimedByUserId: "alice" }));
    await emitForceTransitionedSignal({
      taskId: "task-1",
      projectId: "proj-1",
      from: "review",
      to: "done",
      forcedRules: ["ciGreen", "prMerged"],
      forceReason: "hot-fix: CI flake on unrelated infra",
      forcedByUserId: "admin-1",
    });
    const call = createSignalMock.mock.calls[0]?.[0] as {
      data: {
        type: string;
        context: {
          forceTransition: {
            forcedRules: string[];
            forceReason: string;
            from: string;
            to: string;
          };
        };
      };
    };
    expect(call.data.type).toBe("task_force_transitioned");
    expect(call.data.context.forceTransition).toEqual({
      from: "review",
      to: "done",
      forcedRules: ["ciGreen", "prMerged"],
      forceReason: "hot-fix: CI flake on unrelated infra",
    });
  });

  it("returns 0 and does not throw when the task lookup fails", async () => {
    findUniqueTaskMock.mockRejectedValue(new Error("db down"));
    const count = await emitForceTransitionedSignal({
      taskId: "task-1",
      projectId: "proj-1",
      from: "review",
      to: "done",
      forcedRules: ["ciGreen"],
      forcedByUserId: "admin-1",
    });
    expect(count).toBe(0);
  });

  it("returns count of successful writes when one recipient fails mid-loop", async () => {
    findUniqueTaskMock.mockResolvedValue(
      fakeTask({ claimedByUserId: "alice", reviewClaimedByUserId: "bob" }),
    );
    createSignalMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("unique constraint violation"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const count = await emitForceTransitionedSignal({
      taskId: "task-1",
      projectId: "proj-1",
      from: "review",
      to: "done",
      forcedRules: ["ciGreen"],
      forcedByUserId: "admin-1",
    });
    expect(count).toBe(1);
    expect(createSignalMock).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logLine = String(errSpy.mock.calls[0]?.[0] ?? "");
    expect(logLine).toContain("[force-signal] failed for task=task-1 recipient=");
    errSpy.mockRestore();
  });

  it("returns 0 and logs per recipient when all signal writes fail", async () => {
    findUniqueTaskMock.mockResolvedValue(
      fakeTask({ claimedByUserId: "alice", reviewClaimedByUserId: "bob" }),
    );
    createSignalMock.mockRejectedValue(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const count = await emitForceTransitionedSignal({
      taskId: "task-1",
      projectId: "proj-1",
      from: "review",
      to: "done",
      forcedRules: ["ciGreen"],
      forcedByUserId: "admin-1",
    });
    expect(count).toBe(0);
    expect(createSignalMock).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });

  it("returns 0 when task is not found", async () => {
    findUniqueTaskMock.mockResolvedValue(null);
    const count = await emitForceTransitionedSignal({
      taskId: "missing",
      projectId: "proj-1",
      from: "review",
      to: "done",
      forcedRules: ["ciGreen"],
      forcedByUserId: "admin-1",
    });
    expect(count).toBe(0);
    expect(createSignalMock).not.toHaveBeenCalled();
  });
});
