import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockTaskFindMany,
  mockTaskUpdate,
  mockTaskUpdateMany,
  mockTaskFindUnique,
  mockTaskCreate,
  mockProjectFindMany,
  mockCommentCreate,
  mockLogAuditEvent,
  mockSignalUpdateMany,
} = vi.hoisted(() => ({
  mockTaskFindMany: vi.fn(),
  mockTaskUpdate: vi.fn().mockResolvedValue({}),
  mockTaskUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  mockTaskFindUnique: vi.fn(),
  mockTaskCreate: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "new-task-1", ...args.data }),
  ),
  mockProjectFindMany: vi.fn(),
  mockCommentCreate: vi.fn().mockResolvedValue({}),
  mockLogAuditEvent: vi.fn().mockResolvedValue(undefined),
  mockSignalUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findMany: mockTaskFindMany,
      findUnique: mockTaskFindUnique,
      update: mockTaskUpdate,
      updateMany: mockTaskUpdateMany,
      create: mockTaskCreate,
    },
    project: { findMany: mockProjectFindMany },
    comment: { create: mockCommentCreate },
    signal: { updateMany: mockSignalUpdateMany },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: mockLogAuditEvent,
}));

import { handlePullRequestReviewEvent, handlePullRequestEvent, handleIssuesEvent } from "../../src/services/github-webhook.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockProjectFindMany.mockResolvedValue([{ id: "proj-1", soloMode: false }]);
  mockTaskUpdateMany.mockResolvedValue({ count: 1 });
});

function makeTask(overrides = {}) {
  return { id: "task-1", projectId: "proj-1", status: "review", statusVersion: 0, prNumber: 42, prUrl: "https://github.com/test/repo/pull/42", workflowId: null, ...overrides };
}

describe("handlePullRequestReviewEvent", () => {
  const basePayload = {
    repository: { full_name: "test/repo" },
    pull_request: { number: 42, title: "Fix bug", html_url: "https://github.com/test/repo/pull/42" },
  };

  it("adds timeline comment on review approved without transitioning", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask()]);

    await handlePullRequestReviewEvent({
      ...basePayload,
      action: "submitted",
      review: { state: "approved", user: { login: "alice" }, html_url: "https://review" },
    });

    // No status update
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    // Timeline comment added
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: "task-1",
        content: expect.stringContaining("approved by alice"),
      }),
    });
    // Audit event logged
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.reviewed", taskId: "task-1" }),
    );
  });

  it("transitions review → in_progress on changes requested", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "review" })]);

    await handlePullRequestReviewEvent({
      ...basePayload,
      action: "submitted",
      review: { state: "changes_requested", user: { login: "bob" }, html_url: "https://review" },
    });

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "review", statusVersion: 0 },
      data: { status: "in_progress", statusVersion: { increment: 1 } },
    });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: expect.stringContaining("Changes requested by bob"),
      }),
    });
  });

  it("does not transition on changes_requested if task is not in review", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "in_progress" })]);

    await handlePullRequestReviewEvent({
      ...basePayload,
      action: "submitted",
      review: { state: "changes_requested", user: { login: "bob" }, html_url: "https://review" },
    });

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    // But still adds timeline comment
    expect(mockCommentCreate).toHaveBeenCalled();
  });

  it("handles review commented without transition", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask()]);

    await handlePullRequestReviewEvent({
      ...basePayload,
      action: "submitted",
      review: { state: "commented", user: { login: "carol" }, html_url: "https://review" },
    });

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: expect.stringContaining("Review comment by carol"),
      }),
    });
  });

  it("handles review dismissed", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask()]);

    await handlePullRequestReviewEvent({
      ...basePayload,
      action: "dismissed",
      review: { state: "dismissed", user: { login: "dave" }, html_url: "https://review" },
    });

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: expect.stringContaining("dismissed"),
      }),
    });
  });

  it("skips processing if no projects match the repo", async () => {
    mockProjectFindMany.mockResolvedValue([]);

    await handlePullRequestReviewEvent({
      ...basePayload,
      action: "submitted",
      review: { state: "approved", user: { login: "alice" }, html_url: "https://review" },
    });

    expect(mockTaskFindMany).not.toHaveBeenCalled();
    expect(mockCommentCreate).not.toHaveBeenCalled();
  });
});

describe("handlePullRequestEvent", () => {
  const basePrPayload = {
    repository: { full_name: "test/repo" },
    pull_request: {
      number: 42,
      title: "Fix bug",
      body: "Fixes #123",
      html_url: "https://github.com/test/repo/pull/42",
      state: "closed" as const,
      merged: true,
      merged_by: { login: "merger" },
    },
  };

  it("transitions in_progress → review on PR merged (non-solo, default workflow)", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "in_progress" })]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "in_progress", statusVersion: 0 },
      data: { status: "review", statusVersion: { increment: 1 } },
    });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: expect.stringContaining("merged by merger"),
      }),
    });
  });

  it("leaves task in review on PR merged (non-solo — explicit approval still required)", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "review" })]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: expect.stringContaining("merged by merger"),
      }),
    });
  });

  it("transitions task to done on PR merged when project is soloMode", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1", soloMode: true }]);
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "in_progress" })]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "in_progress", statusVersion: 0 },
      data: { status: "done", statusVersion: { increment: 1 } },
    });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    // Pending signals for the task are auto-acked so the pickup queue drops them
    expect(mockSignalUpdateMany).toHaveBeenCalledWith({
      where: { taskId: "task-1", acknowledgedAt: null },
      data: { acknowledgedAt: expect.any(Date) },
    });
  });

  it("does not ack signals when PR-merge transition does not land on done (non-solo review)", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "in_progress" })]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "in_progress", statusVersion: 0 },
      data: { status: "review", statusVersion: { increment: 1 } },
    });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockSignalUpdateMany).not.toHaveBeenCalled();
  });

  it("M3: custom-workflow non-solo project hands off to review (no done carve-out)", async () => {
    // Regression: a custom workflow used to force "done" here, bypassing the
    // review gate that default-workflow non-solo projects get. A confirmation-
    // required project must keep its review gate on a webhook merge regardless
    // of workflow.
    mockTaskFindMany.mockResolvedValue([
      makeTask({ status: "in_progress", workflowId: "workflow-1" }),
    ]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "in_progress", statusVersion: 0 },
      data: { status: "review", statusVersion: { increment: 1 } },
    });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockSignalUpdateMany).not.toHaveBeenCalled();
  });

  it("resolves the target from the governanceMode enum column (AWAITS_CONFIRMATION → review)", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1", governanceMode: "AWAITS_CONFIRMATION" }]);
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "in_progress" })]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "in_progress", statusVersion: 0 },
      data: { status: "review", statusVersion: { increment: 1 } },
    });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
  });

  it("resolves the target from the governanceMode enum column (AUTONOMOUS → done)", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1", governanceMode: "AUTONOMOUS" }]);
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "in_progress" })]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "in_progress", statusVersion: 0 },
      data: { status: "done", statusVersion: { increment: 1 } },
    });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
  });

  it("does not transition already-done task on PR merged (idempotent)", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "done" })]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    // Still adds timeline comment
    expect(mockCommentCreate).toHaveBeenCalled();
  });

  // Backlog-escape fix, defense-in-depth: findTasksByPr's own where clause
  // already excludes status "backlog" (see pr-binding.test.ts), so in
  // production a backlog task is never returned here at all. This test
  // stubs mockTaskFindMany to return one anyway (as if that filter were
  // absent) to pin pickMergeTargetStatus's independent backlog short-circuit
  // as a second, standalone barrier — a backlog task's prNumber/prUrl/
  // branchName binding fields (set via the agent PATCH lane, which stays
  // allowed) must never let a merge event transition it, in ANY governance
  // mode including AUTONOMOUS.
  it("does not transition a backlog task on PR merged, even if it were returned by the query (backlog-escape fix)", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "backlog" })]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(mockSignalUpdateMany).not.toHaveBeenCalled();
  });

  it("does not transition a backlog task on PR merged under AUTONOMOUS governance, even if it were returned by the query (backlog-escape fix)", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1", governanceMode: "AUTONOMOUS" }]);
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "backlog" })]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(mockSignalUpdateMany).not.toHaveBeenCalled();
  });

  it("does not transition on PR closed without merge", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "review" })]);

    await handlePullRequestEvent({
      ...basePrPayload,
      action: "closed",
      pull_request: { ...basePrPayload.pull_request, merged: false },
    });

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: expect.stringContaining("closed without merge"),
      }),
    });
  });

  it("does not create task on PR opened when no existing task", async () => {
    mockTaskFindMany.mockResolvedValue([]);

    await handlePullRequestEvent({
      ...basePrPayload,
      action: "opened",
      pull_request: { ...basePrPayload.pull_request, state: "open", merged: false },
    });

    // No task creation — task creation is a deliberate agent/human action
    expect(mockTaskCreate).not.toHaveBeenCalled();
    // But audit event is logged for the unmatched PR
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ event: "pr_opened_unmatched" }),
      }),
    );
  });

  it("updates existing task metadata on PR opened instead of creating duplicate", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ prNumber: null, prUrl: null })]);

    await handlePullRequestEvent({
      ...basePrPayload,
      action: "opened",
      pull_request: { ...basePrPayload.pull_request, state: "open", merged: false },
    });

    expect(mockTaskCreate).not.toHaveBeenCalled();
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({ prNumber: 42, prUrl: "https://github.com/test/repo/pull/42" }),
    });
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: expect.stringContaining("PR #42 opened"),
      }),
    });
  });
});

describe("handleIssuesEvent", () => {
  const baseIssuePayload = {
    repository: { full_name: "test/repo" },
    issue: {
      number: 7,
      title: "Something",
      body: null,
      html_url: "https://github.com/test/repo/issues/7",
      state: "closed" as const,
    },
  };

  it("acks pending signals when issue.closed transitions a task to done", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);
    mockTaskFindMany.mockResolvedValue([
      { id: "task-1", projectId: "proj-1", title: "[GH #7] Something", status: "in_progress", statusVersion: 0 },
    ]);

    await handleIssuesEvent({ ...baseIssuePayload, action: "closed" });

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "in_progress", statusVersion: 0 },
      data: { status: "done", statusVersion: { increment: 1 } },
    });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockSignalUpdateMany).toHaveBeenCalledWith({
      where: { taskId: "task-1", acknowledgedAt: null },
      data: { acknowledgedAt: expect.any(Date) },
    });
  });

  // Backlog-escape fix: the query's own where clause now excludes status
  // "backlog" (not just "done"), so a backlog task's title matching `[GH
  // #N]` is never returned here and never gets written to "done" by the
  // unconditional update loop below the query. Asserted directly on the
  // where clause so a regression back to `{ not: "done" }` is caught even
  // without a matching row in the mock.
  it("issue.closed query excludes status backlog (not just done)", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);
    mockTaskFindMany.mockResolvedValue([]);

    await handleIssuesEvent({ ...baseIssuePayload, action: "closed" });

    expect(mockTaskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { notIn: ["done", "backlog"] } }),
      }),
    );
  });
});

// A webhook status write is a compare-and-swap on the status and status
// version the handler read. A lost write re-reads the row and re-decides.
describe("webhook status writes lose to a concurrent writer without writing over it", () => {
  const mergedPayload = {
    action: "closed" as const,
    repository: { full_name: "test/repo" },
    pull_request: {
      number: 42,
      title: "Fix bug",
      body: null,
      html_url: "https://github.com/test/repo/pull/42",
      state: "closed" as const,
      merged: true,
      merged_by: { login: "merger" },
    },
  };

  it("PR merged: a lost write re-reads the row and re-decides against it (in_progress -> review, then the row is already review: no second write)", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "in_progress", statusVersion: 4 })]);
    mockTaskUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockTaskFindUnique.mockResolvedValueOnce({ id: "task-1", status: "review", statusVersion: 5 });

    await handlePullRequestEvent(mergedPayload);

    // One attempt against the row as read, nothing against the fresh row.
    expect(mockTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "in_progress", statusVersion: 4 },
      data: { status: "review", statusVersion: { increment: 1 } },
    });
    // The audit event reports the status the decision ended on, not the stale read.
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.transitioned",
        payload: expect.objectContaining({ event: "pr_merged", from: "review", to: "review" }),
      }),
    );
  });

  it("PR merged (solo): a lost write retries against the fresh row's status and version", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1", soloMode: true }]);
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "in_progress", statusVersion: 4 })]);
    mockTaskUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    mockTaskFindUnique.mockResolvedValueOnce({ id: "task-1", status: "review", statusVersion: 6 });

    await handlePullRequestEvent(mergedPayload);

    expect(mockTaskUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockTaskUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "task-1", status: "review", statusVersion: 6 },
      data: { status: "done", statusVersion: { increment: 1 } },
    });
    expect(mockSignalUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("PR merged (solo): the fresh row is already done: no further write, no signal ack", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1", soloMode: true }]);
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "review", statusVersion: 4 })]);
    mockTaskUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockTaskFindUnique.mockResolvedValueOnce({ id: "task-1", status: "done", statusVersion: 5 });

    await handlePullRequestEvent(mergedPayload);

    expect(mockTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockSignalUpdateMany).not.toHaveBeenCalled();
  });

  it("gives up after repeated lost writes: the task is left as the other writer set it, the delivery still comments", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1", soloMode: true }]);
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "in_progress", statusVersion: 0 })]);
    mockTaskUpdateMany.mockResolvedValue({ count: 0 });
    let version = 0;
    mockTaskFindUnique.mockImplementation(async () => ({
      id: "task-1",
      status: version % 2 === 0 ? "review" : "in_progress",
      statusVersion: ++version,
    }));

    await handlePullRequestEvent(mergedPayload);

    expect(mockTaskUpdateMany).toHaveBeenCalledTimes(3);
    expect(mockSignalUpdateMany).not.toHaveBeenCalled();
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ content: expect.stringContaining("merged by merger") }),
    });
  });

  it("changes requested: a lost write on a task that left review meanwhile does not write in_progress over it", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "review", statusVersion: 2 })]);
    mockTaskUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockTaskFindUnique.mockResolvedValueOnce({ id: "task-1", status: "done", statusVersion: 3 });

    await handlePullRequestReviewEvent({
      repository: { full_name: "test/repo" },
      pull_request: { number: 42, title: "Fix bug", html_url: "https://github.com/test/repo/pull/42" },
      action: "submitted",
      review: { state: "changes_requested", user: { login: "bob" }, html_url: "https://review" },
    });

    expect(mockTaskUpdateMany).toHaveBeenCalledTimes(1);
    // No review -> in_progress claim in the audit event: nothing was written.
    const audit = mockLogAuditEvent.mock.calls.find(([event]) => event.payload?.event === "changes_requested")![0];
    expect(audit.payload).not.toHaveProperty("from");
    expect(audit.payload).not.toHaveProperty("to");
  });

  it("issue closed: a lost write on a task another writer already finished writes nothing and acks nothing", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);
    mockTaskFindMany.mockResolvedValue([
      { id: "task-1", projectId: "proj-1", title: "[GH #7] Something", status: "in_progress", statusVersion: 0 },
    ]);
    mockTaskUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockTaskFindUnique.mockResolvedValueOnce({ id: "task-1", status: "done", statusVersion: 1 });

    await handleIssuesEvent({
      action: "closed",
      repository: { full_name: "test/repo" },
      issue: { number: 7, title: "Something", body: null, html_url: "https://github.com/test/repo/issues/7", state: "closed" },
    });

    expect(mockTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockSignalUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });
});
