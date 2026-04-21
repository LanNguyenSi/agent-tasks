import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  teamMemberFindMany: vi.fn(),
  signalCreate: vi.fn().mockResolvedValue({ id: "sig-1" }),
  agentTokenFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findUnique: prismaMocks.taskFindUnique },
    teamMember: { findMany: prismaMocks.teamMemberFindMany },
    signal: { create: prismaMocks.signalCreate, createMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    agentToken: { findUnique: prismaMocks.agentTokenFindUnique },
    user: { findUnique: prismaMocks.userFindUnique },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { emitSelfMergeNoticeIfApplicable } from "../../src/services/self-merge-notice.js";

const agentActor: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  scopes: [],
};
const humanActor: Actor = { type: "human", userId: "user-1" };

const taskRow = {
  id: "task-1",
  title: "Fix the thing",
  branchName: "feat/x",
  prUrl: "https://github.com/owner/repo/pull/42",
  prNumber: 42,
  project: { teamId: "team-1", slug: "demo", name: "Demo" },
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.taskFindUnique.mockResolvedValue(taskRow);
  prismaMocks.agentTokenFindUnique.mockResolvedValue({ name: "Worker" });
  prismaMocks.userFindUnique.mockResolvedValue({ name: "Lan", login: "lan" });
});

describe("emitSelfMergeNoticeIfApplicable", () => {
  it("emits nothing when soloMode is true", async () => {
    prismaMocks.teamMemberFindMany.mockResolvedValue([{ userId: "u2" }]);

    const n = await emitSelfMergeNoticeIfApplicable({
      taskId: "task-1",
      projectId: "proj-1",
      actor: agentActor,
      project: { soloMode: true, requireDistinctReviewer: false },
      via: "task_merge",
    });

    expect(n).toBe(0);
    expect(prismaMocks.signalCreate).not.toHaveBeenCalled();
  });

  it("emits nothing when requireDistinctReviewer is true (upstream gate blocks)", async () => {
    prismaMocks.teamMemberFindMany.mockResolvedValue([{ userId: "u2" }]);

    const n = await emitSelfMergeNoticeIfApplicable({
      taskId: "task-1",
      projectId: "proj-1",
      actor: agentActor,
      project: { soloMode: false, requireDistinctReviewer: true },
      via: "task_merge",
    });

    expect(n).toBe(0);
    expect(prismaMocks.signalCreate).not.toHaveBeenCalled();
  });

  it("emits one signal per human team member in the middle tier (non-solo, DR off)", async () => {
    prismaMocks.teamMemberFindMany.mockResolvedValue([
      { userId: "u-alpha" },
      { userId: "u-beta" },
      { userId: "u-gamma" },
    ]);

    const n = await emitSelfMergeNoticeIfApplicable({
      taskId: "task-1",
      projectId: "proj-1",
      actor: agentActor,
      project: { soloMode: false, requireDistinctReviewer: false },
      mergeSha: "abc123",
      via: "task_merge",
    });

    expect(n).toBe(3);
    expect(prismaMocks.signalCreate).toHaveBeenCalledTimes(3);
    const recipients = prismaMocks.signalCreate.mock.calls.map(
      (c: any) => c[0].data.recipientUserId,
    );
    expect(recipients.sort()).toEqual(["u-alpha", "u-beta", "u-gamma"]);
    for (const call of prismaMocks.signalCreate.mock.calls) {
      expect(call[0].data.type).toBe("self_merge_notice");
    }
  });

  it("excludes the merging human from recipients to avoid self-notification", async () => {
    prismaMocks.teamMemberFindMany.mockImplementation(
      (args: { where: { userId?: { not?: string } } }) => {
        // Mirror the prisma filter behavior so we can assert on the expected
        // exclude-clause being passed through.
        expect(args.where.userId).toEqual({ not: "user-1" });
        return Promise.resolve([{ userId: "u-alpha" }]);
      },
    );

    const n = await emitSelfMergeNoticeIfApplicable({
      taskId: "task-1",
      projectId: "proj-1",
      actor: humanActor,
      project: { soloMode: false, requireDistinctReviewer: false },
      via: "github_pr_merge",
    });

    expect(n).toBe(1);
    expect(prismaMocks.signalCreate).toHaveBeenCalledTimes(1);
    expect(prismaMocks.signalCreate.mock.calls[0][0].data.recipientUserId).toBe(
      "u-alpha",
    );
  });

  it("returns 0 and skips emission when there are no humans on the team", async () => {
    prismaMocks.teamMemberFindMany.mockResolvedValue([]);

    const n = await emitSelfMergeNoticeIfApplicable({
      taskId: "task-1",
      projectId: "proj-1",
      actor: agentActor,
      project: { soloMode: false, requireDistinctReviewer: false },
      via: "task_finish_auto_merge",
    });

    expect(n).toBe(0);
    expect(prismaMocks.signalCreate).not.toHaveBeenCalled();
  });

  it("returns 0 gracefully when the task has been deleted mid-merge", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(null);
    prismaMocks.teamMemberFindMany.mockResolvedValue([{ userId: "u1" }]);

    const n = await emitSelfMergeNoticeIfApplicable({
      taskId: "task-1",
      projectId: "proj-1",
      actor: agentActor,
      project: { soloMode: false, requireDistinctReviewer: false },
      via: "task_merge",
    });

    expect(n).toBe(0);
    expect(prismaMocks.signalCreate).not.toHaveBeenCalled();
  });

  it("is best-effort: swallows internal errors and returns 0 instead of throwing", async () => {
    prismaMocks.teamMemberFindMany.mockRejectedValue(
      new Error("DB connection refused"),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const n = await emitSelfMergeNoticeIfApplicable({
      taskId: "task-1",
      projectId: "proj-1",
      actor: agentActor,
      project: { soloMode: false, requireDistinctReviewer: false },
      via: "task_merge",
    });

    expect(n).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("task task-1"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("signal context carries prUrl, prNumber, actor info, and task metadata", async () => {
    prismaMocks.teamMemberFindMany.mockResolvedValue([{ userId: "u1" }]);

    await emitSelfMergeNoticeIfApplicable({
      taskId: "task-1",
      projectId: "proj-1",
      actor: agentActor,
      project: { soloMode: false, requireDistinctReviewer: false },
      mergeSha: "shashasha",
      via: "task_merge",
    });

    const { data } = prismaMocks.signalCreate.mock.calls[0][0];
    expect(data.context.prUrl).toBe("https://github.com/owner/repo/pull/42");
    expect(data.context.prNumber).toBe(42);
    expect(data.context.actor).toEqual({ type: "agent", name: "Worker" });
    expect(data.context.taskTitle).toBe("Fix the thing");
    expect(data.context.projectSlug).toBe("demo");
    expect(data.context.taskStatus).toBe("done");
  });
});
