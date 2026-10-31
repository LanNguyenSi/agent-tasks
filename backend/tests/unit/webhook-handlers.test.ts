import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
  mockWorkflowFindFirst,
  mockWorkflowFindUnique,
  mockWorkflowFindMany,
  mockEmitTaskAvailable,
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
  mockWorkflowFindFirst: vi.fn().mockResolvedValue(null),
  mockWorkflowFindUnique: vi.fn().mockResolvedValue(null),
  mockWorkflowFindMany: vi.fn().mockResolvedValue([]),
  mockEmitTaskAvailable: vi.fn().mockResolvedValue(undefined),
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
    workflow: { findFirst: mockWorkflowFindFirst, findUnique: mockWorkflowFindUnique, findMany: mockWorkflowFindMany },
  },
}));

vi.mock("../../src/services/task-signal.js", () => ({
  emitTaskAvailableSignal: mockEmitTaskAvailable,
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: mockLogAuditEvent,
}));

import { handlePullRequestReviewEvent, handlePullRequestEvent, handleIssuesEvent } from "../../src/services/github-webhook.js";
import { logger } from "../../src/lib/logger.js";
import { CUSTOM_VOCABULARY_DEFINITION, OPEN_TO_REVIEW_DEFINITION, TWO_REVIEW_DEFINITION } from "../helpers/custom-vocabulary-workflow.js";

/** A webhook write into a terminal state also clears the work claim and the review claim. */
const CLEARED_CLAIMS = {
  claimedByUserId: null,
  claimedByAgentId: null,
  claimedAt: null,
  reviewClaimedByUserId: null,
  reviewClaimedByAgentId: null,
  reviewClaimedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockProjectFindMany.mockResolvedValue([{ id: "proj-1", soloMode: false }]);
  mockTaskUpdateMany.mockResolvedValue({ count: 1 });
  // No custom workflow by default: every task resolves to the built-in one.
  mockWorkflowFindFirst.mockResolvedValue(null);
  mockWorkflowFindUnique.mockResolvedValue(null);
  // The status filters read the project's workflow rows in one call; the
  // query result itself is mocked, so no rows are needed here.
  mockWorkflowFindMany.mockResolvedValue([]);
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
      data: { status: "done", statusVersion: { increment: 1 }, ...CLEARED_CLAIMS },
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

  it("custom-workflow non-solo project hands off to review (no done carve-out)", async () => {
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
      data: { status: "done", statusVersion: { increment: 1 }, ...CLEARED_CLAIMS },
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

describe("handlePullRequestEvent: merged delivery that matches no project or no task", () => {
  const delivery = (action: "closed" | "opened", merged: boolean, fullName = "test/repo", number = 42) => ({
    action,
    repository: { full_name: fullName },
    pull_request: {
      number,
      title: "Fix bug",
      body: null,
      html_url: `https://github.com/${fullName}/pull/${number}`,
      state: action === "closed" ? ("closed" as const) : ("open" as const),
      merged,
      merged_by: { login: "merger" },
      head: { ref: "fix/bug" },
    },
  });
  const unmatchedAudit = () =>
    mockLogAuditEvent.mock.calls.filter(([arg]) => (arg as { payload?: { event?: string } }).payload?.event === "pr_merged_unmatched");
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    warn.mockRestore();
    mockTaskFindMany.mockReset();
  });

  it("repo bound to no project: warns with repo and PR number and writes an audit row without a project", async () => {
    mockProjectFindMany.mockResolvedValue([]);

    await handlePullRequestEvent(delivery("closed", true, "acme/unbound", 77));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ repo: "acme/unbound", prNumber: 77, reason: "no_project", event: "pr_merged_unmatched" });
    expect(unmatchedAudit()).toEqual([
      [{ action: "task.reviewed", payload: { source: "github_webhook", event: "pr_merged_unmatched", pr_number: 77, repo: "acme/unbound", reason: "no_project" } }],
    ]);
    expect(mockTaskFindMany).not.toHaveBeenCalled();
    expect(mockCommentCreate).not.toHaveBeenCalled();
  });

  it("repo bound to a project, no task carries the PR: warns and audits on that project", async () => {
    mockTaskFindMany.mockResolvedValue([]);

    await handlePullRequestEvent(delivery("closed", true));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ repo: "test/repo", prNumber: 42, reason: "no_task", projectId: "proj-1" });
    expect(unmatchedAudit()).toEqual([
      [{ action: "task.reviewed", projectId: "proj-1", payload: { source: "github_webhook", event: "pr_merged_unmatched", pr_number: 42, repo: "test/repo", reason: "no_task" } }],
    ]);
    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("two bound projects, only one has the task: the audit row is written for the project without it", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1", soloMode: false }, { id: "proj-2", soloMode: false }]);
    mockTaskFindMany.mockImplementation(async (args: { where: { projectId: string } }) =>
      args.where.projectId === "proj-1" ? [makeTask({ status: "in_progress" })] : [],
    );

    await handlePullRequestEvent(delivery("closed", true));

    expect(unmatchedAudit().map(([arg]) => (arg as { projectId?: string }).projectId)).toEqual(["proj-2"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ projectId: "proj-2", reason: "no_task" });
    expect(mockCommentCreate).toHaveBeenCalledTimes(1);
  });

  it("a matching open task: no unmatched warn and no unmatched audit row", async () => {
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "in_progress" })]);

    await handlePullRequestEvent(delivery("closed", true));

    expect(warn).not.toHaveBeenCalled();
    expect(unmatchedAudit()).toHaveLength(0);
  });

  it("a task bound to the PR that is already terminal or backlog is the echo of an earlier merge: no warn, no audit row", async () => {
    // The open-task lookups come back empty; the unfiltered lookup (an OR over the same bindings) finds the done task.
    mockTaskFindMany.mockImplementation(async (args: { where: { OR?: unknown } }) => (args.where.OR ? [{ id: "task-1" }] : []));

    await handlePullRequestEvent(delivery("closed", true));

    expect(warn).not.toHaveBeenCalled();
    expect(unmatchedAudit()).toHaveLength(0);
  });

  it("the unfiltered lookup covers every binding the open lookup uses (prNumber, prUrl, branch, title)", async () => {
    mockTaskFindMany.mockResolvedValue([]);

    await handlePullRequestEvent(delivery("closed", true));

    const orCall = mockTaskFindMany.mock.calls.map(([arg]) => arg as { where: { OR?: unknown[] }; take?: number }).find((arg) => arg.where.OR);
    expect(orCall?.where).toMatchObject({
      projectId: "proj-1",
      OR: [
        { prNumber: 42 },
        { prUrl: "https://github.com/test/repo/pull/42" },
        { branchName: "fix/bug" },
        { title: { contains: "[PR #42]" } },
      ],
    });
    expect(orCall?.take).toBe(1);
  });

  it.each([
    ["closed without merge, no project", "closed", false, []],
    ["closed without merge, no task", "closed", false, [{ id: "proj-1", soloMode: false }]],
    ["opened, no project", "opened", false, []],
  ] as const)("%s: no unmatched-merge diagnostics", async (_name, action, merged, projects) => {
    mockProjectFindMany.mockResolvedValue([...projects]);
    mockTaskFindMany.mockResolvedValue([]);

    await handlePullRequestEvent(delivery(action, merged));

    expect(warn).not.toHaveBeenCalled();
    expect(unmatchedAudit()).toHaveLength(0);
  });

  // The payload shape of the depsight repo's merges, with fields the handler ignores left in.
  const depsightMerge = {
    ...delivery("closed", true, "LanNguyenSi/depsight", 214),
    number: 214,
    sender: { login: "LanNguyenSi" },
  };
  it.each(["review", "in_progress"])("AUTONOMOUS project: a %s task with a work claim goes to done, both claims are cleared, and a [webhook] comment is written", async (status) => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1", governanceMode: "AUTONOMOUS", soloMode: true }]);
    mockTaskFindMany.mockResolvedValue([
      makeTask({ status, prNumber: 214, prUrl: "https://github.com/LanNguyenSi/depsight/pull/214", claimedByUserId: "user-1", claimedAt: new Date() }),
    ]);

    await handlePullRequestEvent(depsightMerge);

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status, statusVersion: 0 },
      data: { status: "done", statusVersion: { increment: 1 }, ...CLEARED_CLAIMS },
    });
    expect(mockCommentCreate).toHaveBeenCalledWith({ data: { taskId: "task-1", content: "[webhook] PR #214 merged by merger" } });
    expect(mockSignalUpdateMany).toHaveBeenCalledWith({ where: { taskId: "task-1", acknowledgedAt: null }, data: { acknowledgedAt: expect.any(Date) } });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("handleIssuesEvent: issue opened", () => {
  const openedPayload = {
    action: "opened" as const,
    repository: { full_name: "test/repo" },
    issue: { number: 7, title: "Something", body: "Details", html_url: "https://github.com/test/repo/issues/7", state: "open" as const },
  };
  const queuedDefinition = {
    initialState: "queued",
    states: [
      { name: "queued", label: "Queued", terminal: false },
      { name: "working", label: "Working", terminal: false },
      { name: "shipped", label: "Shipped", terminal: true },
    ],
    transitions: [{ from: "queued", to: "working" }, { from: "working", to: "shipped" }],
  };

  it("creates the task as open in a project without a stored workflow and signals it", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);

    await handleIssuesEvent(openedPayload);

    expect(mockTaskCreate).toHaveBeenCalledWith({
      data: { projectId: "proj-1", title: "[GH #7] Something", description: "Details", status: "open" },
    });
    expect(mockEmitTaskAvailable).toHaveBeenCalledWith("new-task-1", "proj-1", "webhook", "GitHub");
  });

  it("creates the task in the initial state of the project's stored default workflow", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);
    mockWorkflowFindFirst.mockResolvedValue({ definition: queuedDefinition });

    await handleIssuesEvent(openedPayload);

    expect(mockTaskCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "queued" }) });
    expect(mockEmitTaskAvailable).toHaveBeenCalledWith("new-task-1", "proj-1", "webhook", "GitHub");
  });

  it("falls back to the built-in initial state when the stored definition cannot be read", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);
    mockWorkflowFindFirst.mockResolvedValue({ definition: { unreadable: true } });

    await handleIssuesEvent(openedPayload);

    expect(mockTaskCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "open" }) });
  });

  it("resolves the initial state per linked project", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-a" }, { id: "proj-b" }]);
    mockWorkflowFindFirst.mockImplementation(({ where }: { where: { projectId: string } }) =>
      Promise.resolve(where.projectId === "proj-a" ? { definition: queuedDefinition } : null),
    );

    await handleIssuesEvent(openedPayload);

    expect(mockTaskCreate).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ projectId: "proj-a", status: "queued" }) });
    expect(mockTaskCreate).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ projectId: "proj-b", status: "open" }) });
    expect(mockEmitTaskAvailable).toHaveBeenCalledTimes(2);
  });

  it("a failed task_available signal does not stop the other linked projects", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-a" }, { id: "proj-b" }]);
    mockEmitTaskAvailable.mockRejectedValueOnce(new Error("signal store down"));

    await handleIssuesEvent(openedPayload);

    expect(mockTaskCreate).toHaveBeenCalledTimes(2);
    expect(mockEmitTaskAvailable).toHaveBeenCalledTimes(2);
  });

  it("does not signal for an issue event that is not an opened one", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);
    mockTaskFindMany.mockResolvedValue([]);

    await handleIssuesEvent({ ...openedPayload, action: "closed" });

    expect(mockTaskCreate).not.toHaveBeenCalled();
    expect(mockEmitTaskAvailable).not.toHaveBeenCalled();
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
      data: { status: "done", statusVersion: { increment: 1 }, ...CLEARED_CLAIMS },
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
        where: expect.objectContaining({
          status: { not: "backlog" },
          // No workflow row: every task resolves to the built-in workflow, whose terminal state is `done`.
          AND: [{ OR: [{ workflowId: null, status: { notIn: ["done"] } }] }],
        }),
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
      data: { status: "done", statusVersion: { increment: 1 }, ...CLEARED_CLAIMS },
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

// The decisions read review and terminal semantics from the task's effective
// workflow definition, so a workflow with its own state names is moved between
// its own states and never to a literal review/done.
describe("webhook handlers on a custom state vocabulary", () => {
  const prPayload = {
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
  const reviewPayload = (state: "changes_requested") => ({
    action: "submitted" as const,
    repository: { full_name: "test/repo" },
    pull_request: { number: 42, title: "Fix bug", html_url: "https://github.com/test/repo/pull/42" },
    review: { state, user: { login: "bob" }, html_url: "https://review" },
  });
  const issuePayload = {
    action: "closed" as const,
    repository: { full_name: "test/repo" },
    issue: { number: 7, title: "Something", body: null, html_url: "https://github.com/test/repo/issues/7", state: "closed" as const },
  };
  const customTask = (status: string) => makeTask({ status, workflowId: "wf-custom" });

  beforeEach(() => {
    mockWorkflowFindUnique.mockResolvedValue({ definition: CUSTOM_VOCABULARY_DEFINITION });
  });

  it("changes requested: moves the review-like state to the request-changes target", async () => {
    mockTaskFindMany.mockResolvedValue([customTask("qa")]);

    await handlePullRequestReviewEvent(reviewPayload("changes_requested"));

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "qa", statusVersion: 0 },
      data: { status: "build", statusVersion: { increment: 1 } },
    });
    const audit = mockLogAuditEvent.mock.calls.find(([event]) => event.payload?.event === "changes_requested")![0];
    expect(audit.payload).toMatchObject({ from: "qa", to: "build" });
  });

  it("changes requested: leaves a task that is not in a review-like state alone", async () => {
    mockTaskFindMany.mockResolvedValue([customTask("build")]);

    await handlePullRequestReviewEvent(reviewPayload("changes_requested"));

    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    const audit = mockLogAuditEvent.mock.calls.find(([event]) => event.payload?.event === "changes_requested")![0];
    expect(audit.payload).not.toHaveProperty("from");
  });

  it("issue closed: moves a working task to the workflow's terminal state and reports it", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);
    mockTaskFindMany.mockResolvedValue([customTask("build")]);

    await handleIssuesEvent(issuePayload);

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "build", statusVersion: 0 },
      data: { status: "shipped", statusVersion: { increment: 1 }, ...CLEARED_CLAIMS },
    });
    expect(mockSignalUpdateMany).toHaveBeenCalled();
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.transitioned",
        payload: expect.objectContaining({ to: "shipped" }),
      }),
    );
  });

  it("issue closed: leaves a task already in the terminal state alone", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);
    mockTaskFindMany.mockResolvedValue([customTask("shipped")]);

    await handleIssuesEvent(issuePayload);

    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(mockSignalUpdateMany).not.toHaveBeenCalled();
  });

  it("issue closed: leaves a task in any terminal state alone, not only the first one", async () => {
    mockWorkflowFindUnique.mockResolvedValue({
      definition: {
        initialState: "open",
        states: [
          { name: "open", label: "Open", terminal: false },
          { name: "work", label: "Work", terminal: false },
          { name: "released", label: "Released", terminal: true },
          { name: "cancelled", label: "Cancelled", terminal: true },
        ],
        transitions: [
          { from: "open", to: "work" },
          { from: "work", to: "released" },
          { from: "work", to: "cancelled" },
        ],
      },
    });
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);
    mockTaskFindMany.mockResolvedValue([customTask("cancelled")]);

    await handleIssuesEvent(issuePayload);

    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(mockSignalUpdateMany).not.toHaveBeenCalled();
  });

  it("issue closed: leaves a backlog task alone even if the query returned it", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1" }]);
    mockTaskFindMany.mockResolvedValue([customTask("backlog")]);

    await handleIssuesEvent(issuePayload);

    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("PR merged (confirmation required): hands a working task to the review-like state, without acking signals", async () => {
    mockTaskFindMany.mockResolvedValue([customTask("build")]);

    await handlePullRequestEvent(prPayload);

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "build", statusVersion: 0 },
      data: { status: "qa", statusVersion: { increment: 1 } },
    });
    expect(mockSignalUpdateMany).not.toHaveBeenCalled();
  });

  it("PR merged (confirmation required): leaves a task in the review-like state for explicit approval", async () => {
    mockTaskFindMany.mockResolvedValue([customTask("qa")]);

    await handlePullRequestEvent(prPayload);

    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("PR merged (solo): moves the task to the terminal state and acks its signals", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1", soloMode: true }]);
    mockTaskFindMany.mockResolvedValue([customTask("build")]);

    await handlePullRequestEvent(prPayload);

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "build", statusVersion: 0 },
      data: { status: "shipped", statusVersion: { increment: 1 }, ...CLEARED_CLAIMS },
    });
    expect(mockSignalUpdateMany).toHaveBeenCalledWith({
      where: { taskId: "task-1", acknowledgedAt: null },
      data: { acknowledgedAt: expect.any(Date) },
    });
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ event: "pr_merged", from: "build", to: "shipped" }),
      }),
    );
  });

  it("resolves the project default workflow for a task without its own workflow", async () => {
    mockWorkflowFindFirst.mockResolvedValue({ definition: CUSTOM_VOCABULARY_DEFINITION });
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "qa", workflowId: null })]);

    await handlePullRequestReviewEvent(reviewPayload("changes_requested"));

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "qa", statusVersion: 0 },
      data: { status: "build", statusVersion: { increment: 1 } },
    });
  });
});

describe("webhook handlers on a four-state workflow with a free open -> review edge", () => {
  it("changes requested: a review task is not review-like in this graph, so it is left alone", async () => {
    mockWorkflowFindUnique.mockResolvedValue({ definition: OPEN_TO_REVIEW_DEFINITION });
    mockTaskFindMany.mockResolvedValue([makeTask({ status: "review", workflowId: "wf-open-review" })]);

    await handlePullRequestReviewEvent({
      action: "submitted",
      repository: { full_name: "test/repo" },
      pull_request: { number: 42, title: "Fix bug", html_url: "https://github.com/test/repo/pull/42" },
      review: { state: "changes_requested", user: { login: "bob" }, html_url: "https://review" },
    });

    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    const audit = mockLogAuditEvent.mock.calls.find(([event]) => event.payload?.event === "changes_requested")![0];
    expect(audit.payload).not.toHaveProperty("from");
  });
});

// Handler level: a merged PR hands a task to the review-like state its current
// state has an edge to (the state a task_finish from there would target), and
// the compare-and-swap write and the audit payload carry that state.
describe("webhook PR merge on a workflow with several review-like states", () => {
  const prPayload = {
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
  const twoReviewTask = (status: string) => makeTask({ status, workflowId: "wf-two-review" });

  beforeEach(() => {
    mockWorkflowFindUnique.mockResolvedValue({ definition: TWO_REVIEW_DEFINITION });
  });

  it.each([
    ["a", "r1"],
    ["b", "r2"],
    ["open", "r1"],
  ])("a task in %s is handed to %s: CAS write and audit payload agree", async (from, to) => {
    mockTaskFindMany.mockResolvedValue([twoReviewTask(from)]);

    await handlePullRequestEvent(prPayload);

    expect(mockTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: from, statusVersion: 0 },
      data: { status: to, statusVersion: { increment: 1 } },
    });
    expect(mockSignalUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.transitioned",
        payload: expect.objectContaining({ event: "pr_merged", from, to }),
      }),
    );
  });

  it("a task already in a review-like state of the workflow is left alone", async () => {
    mockTaskFindMany.mockResolvedValue([twoReviewTask("r2")]);

    await handlePullRequestEvent(prPayload);

    expect(mockTaskUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ event: "pr_merged", from: "r2", to: "r2" }) }),
    );
  });

  it("solo project (AUTONOMOUS): the terminal state wins over the reachable review state", async () => {
    mockProjectFindMany.mockResolvedValue([{ id: "proj-1", soloMode: true }]);
    mockTaskFindMany.mockResolvedValue([twoReviewTask("b")]);

    await handlePullRequestEvent(prPayload);

    expect(mockTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "b", statusVersion: 0 },
      data: { status: "shipped", statusVersion: { increment: 1 }, ...CLEARED_CLAIMS },
    });
  });
});
