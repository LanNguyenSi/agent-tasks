import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockTaskFindMany,
  mockTaskUpdate,
  mockTaskCreate,
  mockProjectFindMany,
  mockCommentCreate,
  mockLogAuditEvent,
} = vi.hoisted(() => ({
  mockTaskFindMany: vi.fn(),
  mockTaskUpdate: vi.fn().mockResolvedValue({}),
  mockTaskCreate: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "new-task-1", ...args.data }),
  ),
  mockProjectFindMany: vi.fn(),
  mockCommentCreate: vi.fn().mockResolvedValue({}),
  mockLogAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findMany: mockTaskFindMany, update: mockTaskUpdate, create: mockTaskCreate },
    project: { findMany: mockProjectFindMany },
    comment: { create: mockCommentCreate },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: mockLogAuditEvent,
}));

import { handlePullRequestReviewEvent, handlePullRequestEvent } from "../../src/services/github-webhook.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);
});

function makeTask(overrides = {}) {
  return { id: "task-1", projectId: "proj-1", status: "review", prNumber: 42, prUrl: "https://github.com/test/repo/pull/42", ...overrides };
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

    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { status: "in_progress" },
    });
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

  it("transitions task to done on PR merged", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "review" })]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { status: "done" },
    });
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: expect.stringContaining("merged by merger"),
      }),
    });
  });

  it("does not transition already-done task on PR merged (idempotent)", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "done" })]);

    await handlePullRequestEvent({ ...basePrPayload, action: "closed" });

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    // Still adds timeline comment
    expect(mockCommentCreate).toHaveBeenCalled();
  });

  it("does not transition on PR closed without merge", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "review" })]);

    await handlePullRequestEvent({
      ...basePrPayload,
      action: "closed",
      pull_request: { ...basePrPayload.pull_request, merged: false },
    });

    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: expect.stringContaining("closed without merge"),
      }),
    });
  });

  it("creates task on PR opened when no existing task", async () => {
    mockTaskFindMany.mockResolvedValue([]);

    await handlePullRequestEvent({
      ...basePrPayload,
      action: "opened",
      pull_request: { ...basePrPayload.pull_request, state: "open", merged: false },
    });

    expect(mockTaskCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "[PR #42] Fix bug",
        status: "review",
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
      }),
    });
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
