import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockCreate, mockFindMany } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({ id: "audit-1" }),
  mockFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: mockCreate, findMany: mockFindMany },
  },
}));

import { logAuditEvent, getAuditLogs } from "../../src/services/audit.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("logAuditEvent", () => {
  it("creates an audit log with action and actorId", async () => {
    await logAuditEvent({ action: "task.created", actorId: "user-1", taskId: "task-1" });

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "task.created",
        actorId: "user-1",
        taskId: "task-1",
      }),
    });
  });

  it("defaults payload to empty object", async () => {
    await logAuditEvent({ action: "project.updated", projectId: "proj-1" });
    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.data.payload).toEqual({});
  });

  it("includes payload when provided", async () => {
    await logAuditEvent({
      action: "task.transitioned",
      taskId: "task-1",
      payload: { from: "open", to: "in_progress" },
    });
    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.data.payload).toEqual({ from: "open", to: "in_progress" });
  });

  it("sets actorId to null when not provided", async () => {
    await logAuditEvent({ action: "project.created" });
    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.data.actorId).toBeNull();
  });
});

describe("getAuditLogs", () => {
  it("queries with projectId filter", async () => {
    await getAuditLogs({ projectId: "proj-1" });
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: "proj-1" }) }),
    );
  });

  it("uses default limit of 50", async () => {
    await getAuditLogs({ projectId: "proj-1" });
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 0 }));
  });

  it("respects custom limit and offset", async () => {
    await getAuditLogs({ taskId: "task-1", limit: 10, offset: 20 });
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10, skip: 20 }));
  });

  it("orders by createdAt descending", async () => {
    await getAuditLogs({});
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
  });
});
