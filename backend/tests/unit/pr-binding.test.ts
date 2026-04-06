import { describe, expect, it, vi, beforeEach } from "vitest";

const mockTaskFindMany = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findMany: mockTaskFindMany },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn(),
}));

import { findTasksByPr } from "../../src/services/github-webhook.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockTaskFindMany.mockResolvedValue([]);
});

const task1 = { id: "t1", projectId: "p1", status: "review", prNumber: 42, prUrl: "https://pr/42", branchName: "feat/x" };
const task2 = { id: "t2", projectId: "p1", status: "in_progress", prNumber: null, prUrl: null, branchName: "feat/x" };
const task3 = { id: "t3", projectId: "p1", status: "open", prNumber: null, prUrl: null, branchName: null };

describe("findTasksByPr — binding strategy", () => {
  it("matches by prNumber (highest priority)", async () => {
    mockTaskFindMany.mockImplementation((args: { where: Record<string, unknown> } & Record<string, unknown>) => {
      if (args.where.prNumber === 42) return Promise.resolve([task1]);
      return Promise.resolve([]);
    });

    const result = await findTasksByPr("p1", { prNumber: 42 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t1");
  });

  it("matches by prUrl when prNumber yields no results", async () => {
    mockTaskFindMany.mockImplementation((args: { where: Record<string, unknown> } & Record<string, unknown>) => {
      if (args.where.prUrl === "https://pr/42") return Promise.resolve([task1]);
      return Promise.resolve([]);
    });

    const result = await findTasksByPr("p1", { prNumber: 99, prUrl: "https://pr/42" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t1");
  });

  it("matches by branchName when prNumber and prUrl yield no results", async () => {
    mockTaskFindMany.mockImplementation((args: { where: Record<string, unknown> } & Record<string, unknown>) => {
      if (args.where.branchName === "feat/x") return Promise.resolve([task2]);
      return Promise.resolve([]);
    });

    const result = await findTasksByPr("p1", { prNumber: 99, headBranch: "feat/x" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t2");
  });

  it("falls back to title pattern when structured fields yield no results", async () => {
    mockTaskFindMany.mockImplementation((args: { where: Record<string, unknown> } & Record<string, unknown>) => {
      if (args.where.title && typeof args.where.title === "object") return Promise.resolve([task3]);
      return Promise.resolve([]);
    });

    const result = await findTasksByPr("p1", { prNumber: 99 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t3");
  });

  it("deduplicates tasks matched by multiple strategies", async () => {
    // task1 matches by both prNumber and prUrl
    mockTaskFindMany.mockImplementation((args: { where: Record<string, unknown> } & Record<string, unknown>) => {
      if (args.where.prNumber === 42) return Promise.resolve([task1]);
      if (args.where.prUrl === "https://pr/42") return Promise.resolve([task1]);
      return Promise.resolve([]);
    });

    const result = await findTasksByPr("p1", { prNumber: 42, prUrl: "https://pr/42" });
    expect(result).toHaveLength(1);
  });

  it("skips prUrl query when not provided", async () => {
    mockTaskFindMany.mockResolvedValue([]);
    await findTasksByPr("p1", { prNumber: 42 });

    // Should have been called 3 times: prNumber, branchName(skipped→resolved), title
    // prUrl query is skipped (resolves empty), branchName is skipped too
    const calls = mockTaskFindMany.mock.calls;
    // No call should have prUrl in where clause
    const prUrlCalls = calls.filter((c: unknown[]) => (c[0] as { where: Record<string, unknown> }).where.prUrl !== undefined);
    expect(prUrlCalls).toHaveLength(0);
  });

  it("skips branchName query when not provided", async () => {
    mockTaskFindMany.mockResolvedValue([]);
    await findTasksByPr("p1", { prNumber: 42, prUrl: "https://pr/42" });

    const calls = mockTaskFindMany.mock.calls;
    const branchCalls = calls.filter((c: unknown[]) => (c[0] as { where: Record<string, unknown> }).where.branchName !== undefined);
    expect(branchCalls).toHaveLength(0);
  });

  it("returns empty array when no strategies match", async () => {
    mockTaskFindMany.mockResolvedValue([]);
    const result = await findTasksByPr("p1", { prNumber: 999 });
    expect(result).toEqual([]);
  });
});
