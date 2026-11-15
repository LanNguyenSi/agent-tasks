/**
 * One webhook delivery per fan-out event.
 *
 * An event that notifies several recipients (every eligible reviewer, every
 * claim-eligible agent, every human to tell about a self-merge, ...) writes one
 * durable Signal row per recipient (the pull channel is per row) but must send
 * exactly ONE push delivery, whose payload lists all recipients. These tests
 * drive the real emitters over a mocked prisma and a mocked sender, so they pin
 * the number of deliveries and the recipient list each one carries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/types/auth.js";

const m = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  agentTokenFindMany: vi.fn(),
  agentTokenFindUnique: vi.fn(),
  teamMemberFindMany: vi.fn(),
  taskFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  commentCreate: vi.fn(),
  signalCreate: vi.fn(),
  deliverSignalWebhook: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: m.projectFindUnique },
    agentToken: { findMany: m.agentTokenFindMany, findUnique: m.agentTokenFindUnique },
    teamMember: { findMany: m.teamMemberFindMany },
    task: { findUnique: m.taskFindUnique },
    user: { findUnique: m.userFindUnique },
    comment: { create: m.commentCreate },
    signal: { create: m.signalCreate },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/notification-webhook.js", () => ({
  deliverSignalWebhook: m.deliverSignalWebhook,
}));

import {
  createSignals,
  maybeDeliverSignalWebhooks,
  type CreateSignalInput,
} from "../../src/services/signal.js";
import {
  emitChangesRequestedSignal,
  emitReviewSignal,
  emitTaskApprovedSignal,
} from "../../src/services/review-signal.js";
import { emitTaskAvailableSignal } from "../../src/services/task-signal.js";
import { emitSelfMergeNoticeIfApplicable } from "../../src/services/self-merge-notice.js";
import { emitForceTransitionedSignal } from "../../src/services/force-transition-signal.js";

const HOOK = "https://hooks.example/inbox";

const projectRow = (webhookUrl: string | null) => ({
  teamId: "team-1",
  slug: "agent-tasks",
  notificationWebhookUrl: webhookUrl,
  notificationWebhookSecret: "shhh",
});

const context = {
  taskTitle: "Fix bug",
  taskStatus: "review",
  projectSlug: "agent-tasks",
  projectName: "agent-tasks",
  actor: { type: "agent" as const, name: "Worker" },
};

let rowCounter = 0;

/** Let the voided delivery promises settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deliveries(): Array<Record<string, unknown>> {
  return m.deliverSignalWebhook.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  rowCounter = 0;
  m.projectFindUnique.mockResolvedValue(projectRow(HOOK));
  m.agentTokenFindMany.mockResolvedValue([]);
  m.agentTokenFindUnique.mockResolvedValue({ name: "Worker Bot" });
  m.teamMemberFindMany.mockResolvedValue([]);
  m.userFindUnique.mockResolvedValue({ name: "Lan", login: "lan" });
  m.commentCreate.mockResolvedValue({});
  m.deliverSignalWebhook.mockResolvedValue(undefined);
  m.taskFindUnique.mockResolvedValue({
    id: "task-1",
    title: "Fix bug",
    status: "review",
    projectId: "proj-1",
    branchName: "feat/fix",
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
    claimedByUserId: null,
    claimedByAgentId: null,
    reviewClaimedByUserId: null,
    reviewClaimedByAgentId: null,
    project: { slug: "agent-tasks", name: "agent-tasks", teamId: "team-1" },
  });
  m.signalCreate.mockImplementation((args: { data: Record<string, unknown> }) => {
    rowCounter += 1;
    return Promise.resolve({
      id: `sig-${rowCounter}`,
      ...args.data,
      createdAt: new Date(`2026-05-27T12:00:0${rowCounter}.000Z`),
      acknowledgedAt: null,
    });
  });
});

describe("review_needed fan-out", () => {
  it("N eligible reviewers: N Signal rows, ONE delivery listing every recipient", async () => {
    m.agentTokenFindMany.mockResolvedValue([
      { id: "agent-1", name: "Reviewer A" },
      { id: "agent-2", name: "Reviewer B" },
    ]);
    m.teamMemberFindMany.mockResolvedValue([
      { userId: "user-1", user: { name: "Alice", login: "alice" } },
    ]);

    await emitReviewSignal("task-1", "proj-1", null, "agent-worker");
    await flush();

    // Pull delivery unchanged: one durable row per reviewer.
    expect(m.signalCreate).toHaveBeenCalledTimes(3);
    // Push delivery: one POST for the event.
    expect(m.deliverSignalWebhook).toHaveBeenCalledTimes(1);
    const [payload] = deliveries();
    expect(payload).toMatchObject({
      signalId: "sig-1",
      signalType: "review_needed",
      taskId: "task-1",
      projectId: "proj-1",
      webhookUrl: HOOK,
      webhookSecret: "shhh",
      // Primary recipient: the first row, same meaning as the old single-recipient fields.
      recipientAgentId: "agent-1",
      recipientUserId: null,
      createdAt: new Date("2026-05-27T12:00:01.000Z"),
    });
    expect(payload.recipients).toEqual([
      { signalId: "sig-1", recipientAgentId: "agent-1", recipientUserId: null },
      { signalId: "sig-2", recipientAgentId: "agent-2", recipientUserId: null },
      { signalId: "sig-3", recipientAgentId: null, recipientUserId: "user-1" },
    ]);
  });

  it("one eligible reviewer: one row, one delivery, a one-entry recipient list", async () => {
    m.agentTokenFindMany.mockResolvedValue([{ id: "agent-1", name: "Reviewer A" }]);

    await emitReviewSignal("task-1", "proj-1", null, "agent-worker");
    await flush();

    expect(m.signalCreate).toHaveBeenCalledTimes(1);
    expect(m.deliverSignalWebhook).toHaveBeenCalledTimes(1);
    expect(deliveries()[0]!.recipients).toEqual([
      { signalId: "sig-1", recipientAgentId: "agent-1", recipientUserId: null },
    ]);
  });

  it("no eligible reviewer: no row and no delivery", async () => {
    await emitReviewSignal("task-1", "proj-1", null, "agent-worker");
    await flush();

    expect(m.signalCreate).not.toHaveBeenCalled();
    expect(m.deliverSignalWebhook).not.toHaveBeenCalled();
  });

  it("webhook disabled: the rows are still written, nothing is delivered", async () => {
    m.projectFindUnique.mockResolvedValue(projectRow(null));
    m.agentTokenFindMany.mockResolvedValue([
      { id: "agent-1", name: "Reviewer A" },
      { id: "agent-2", name: "Reviewer B" },
    ]);

    await emitReviewSignal("task-1", "proj-1", null, "agent-worker");
    await flush();

    expect(m.signalCreate).toHaveBeenCalledTimes(2);
    expect(m.deliverSignalWebhook).not.toHaveBeenCalled();
  });
});

describe("signals that do not fan out stay one delivery with one recipient", () => {
  it("changes_requested: one row, one delivery, recipient list of one", async () => {
    await emitChangesRequestedSignal("task-1", "proj-1", null, "agent-worker", "Reviewer", "please fix");
    await flush();

    expect(m.signalCreate).toHaveBeenCalledTimes(1);
    expect(m.deliverSignalWebhook).toHaveBeenCalledTimes(1);
    expect(deliveries()[0]).toMatchObject({
      signalId: "sig-1",
      signalType: "changes_requested",
      recipientAgentId: "agent-worker",
      recipients: [{ signalId: "sig-1", recipientAgentId: "agent-worker", recipientUserId: null }],
    });
  });

  it("task_approved: one row, one delivery", async () => {
    await emitTaskApprovedSignal("task-1", "proj-1", "user-9", null, "Reviewer");
    await flush();

    expect(m.deliverSignalWebhook).toHaveBeenCalledTimes(1);
    expect(deliveries()[0]).toMatchObject({
      signalType: "task_approved",
      recipientUserId: "user-9",
      recipients: [{ signalId: "sig-1", recipientAgentId: null, recipientUserId: "user-9" }],
    });
  });
});

describe("task_available fan-out", () => {
  it("N claim-eligible agents: N rows, ONE delivery", async () => {
    m.agentTokenFindMany.mockResolvedValue([
      { id: "agent-1", name: "W1" },
      { id: "agent-2", name: "W2" },
      { id: "agent-3", name: "W3" },
    ]);

    await emitTaskAvailableSignal("task-1", "proj-1", "human", "Lan");
    await flush();

    expect(m.signalCreate).toHaveBeenCalledTimes(3);
    expect(m.deliverSignalWebhook).toHaveBeenCalledTimes(1);
    expect(deliveries()[0]).toMatchObject({ signalType: "task_available", recipientAgentId: "agent-1" });
    expect((deliveries()[0]!.recipients as unknown[]).length).toBe(3);
  });
});

describe("self_merge_notice fan-out", () => {
  const actor: Actor = { type: "agent", tokenId: "agent-1", teamId: "team-1", scopes: [], userId: "agent-1" };

  it("N humans to notify: N rows, ONE delivery", async () => {
    m.teamMemberFindMany.mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]);

    const n = await emitSelfMergeNoticeIfApplicable({
      taskId: "task-1",
      projectId: "proj-1",
      actor,
      project: { soloMode: false, requireDistinctReviewer: false },
      via: "task_merge",
    });
    await flush();

    expect(n).toBe(2);
    expect(m.signalCreate).toHaveBeenCalledTimes(2);
    expect(m.deliverSignalWebhook).toHaveBeenCalledTimes(1);
    expect(deliveries()[0]!.recipients).toEqual([
      { signalId: "sig-1", recipientAgentId: null, recipientUserId: "u1" },
      { signalId: "sig-2", recipientAgentId: null, recipientUserId: "u2" },
    ]);
  });
});

describe("task_force_transitioned fan-out", () => {
  const input = {
    taskId: "task-1",
    projectId: "proj-1",
    from: "review",
    to: "done",
    forcedRules: ["ciGreen"],
    forcedByUserId: "admin",
  };

  it("claimant and reviewer: 2 rows, ONE delivery", async () => {
    m.taskFindUnique.mockResolvedValue({
      ...(await m.taskFindUnique()),
      claimedByUserId: "alice",
      reviewClaimedByUserId: "bob",
    });

    const written = await emitForceTransitionedSignal(input);
    await flush();

    expect(written).toBe(2);
    expect(m.deliverSignalWebhook).toHaveBeenCalledTimes(1);
    expect((deliveries()[0]!.recipients as unknown[]).length).toBe(2);
  });

  it("a recipient whose row fails is skipped; the written rows still go out as ONE delivery", async () => {
    m.taskFindUnique.mockResolvedValue({
      ...(await m.taskFindUnique()),
      claimedByUserId: "alice",
      reviewClaimedByUserId: "bob",
    });
    m.signalCreate.mockRejectedValueOnce(new Error("db down"));

    const written = await emitForceTransitionedSignal(input);
    await flush();

    expect(written).toBe(1);
    expect(m.deliverSignalWebhook).toHaveBeenCalledTimes(1);
    expect(deliveries()[0]!.recipients).toEqual([
      expect.objectContaining({ recipientUserId: "bob" }),
    ]);
  });

  it("every row fails: nothing is delivered", async () => {
    m.taskFindUnique.mockResolvedValue({
      ...(await m.taskFindUnique()),
      claimedByUserId: "alice",
    });
    m.signalCreate.mockRejectedValue(new Error("db down"));

    const written = await emitForceTransitionedSignal(input);
    await flush();

    expect(written).toBe(0);
    expect(m.deliverSignalWebhook).not.toHaveBeenCalled();
  });
});

describe("createSignals / maybeDeliverSignalWebhooks", () => {
  const input = (agentId: string, overrides: Partial<CreateSignalInput> = {}): CreateSignalInput => ({
    type: "review_needed",
    taskId: "task-1",
    projectId: "proj-1",
    recipientAgentId: agentId,
    context,
    ...overrides,
  });

  it("delivers only after every row exists", async () => {
    const order: string[] = [];
    m.signalCreate.mockImplementation((args: { data: Record<string, unknown> }) => {
      order.push(`create:${String(args.data.recipientAgentId)}`);
      rowCounter += 1;
      return Promise.resolve({ id: `sig-${rowCounter}`, ...args.data, createdAt: new Date(), acknowledgedAt: null });
    });
    m.deliverSignalWebhook.mockImplementation(() => {
      order.push("deliver");
      return Promise.resolve();
    });

    await createSignals([input("a1"), input("a2")]);
    await flush();

    expect(order).toEqual(["create:a1", "create:a2", "deliver"]);
  });

  it("a failing insert delivers the rows already written (once) and rethrows", async () => {
    m.signalCreate.mockImplementationOnce((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "sig-ok", ...args.data, createdAt: new Date(), acknowledgedAt: null }),
    );
    m.signalCreate.mockRejectedValueOnce(new Error("db down"));

    await expect(createSignals([input("a1"), input("a2"), input("a3")])).rejects.toThrow("db down");
    await flush();

    expect(m.deliverSignalWebhook).toHaveBeenCalledTimes(1);
    expect(deliveries()[0]!.recipients).toEqual([
      { signalId: "sig-ok", recipientAgentId: "a1", recipientUserId: null },
    ]);
  });

  it("an empty list delivers nothing and does not even look the project up", async () => {
    await createSignals([]);
    await maybeDeliverSignalWebhooks([]);
    await flush();

    expect(m.projectFindUnique).not.toHaveBeenCalled();
    expect(m.deliverSignalWebhook).not.toHaveBeenCalled();
  });

  it("signals of different events (task or type) get one delivery each, not one merged delivery", async () => {
    const row = (id: string, type: string, taskId: string, agent: string) => ({
      id,
      type,
      taskId,
      projectId: "proj-1",
      recipientAgentId: agent,
      recipientUserId: null,
      context,
      createdAt: new Date("2026-05-27T12:00:00.000Z"),
    });

    await maybeDeliverSignalWebhooks([
      row("s1", "review_needed", "task-1", "a1"),
      row("s2", "task_available", "task-1", "a1"),
      row("s3", "review_needed", "task-2", "a1"),
      row("s4", "review_needed", "task-1", "a2"),
    ]);

    expect(m.deliverSignalWebhook).toHaveBeenCalledTimes(3);
    const byId = new Map(deliveries().map((d) => [d.signalId as string, d]));
    expect((byId.get("s1")!.recipients as unknown[]).length).toBe(2);
    expect((byId.get("s2")!.recipients as unknown[]).length).toBe(1);
    expect((byId.get("s3")!.recipients as unknown[]).length).toBe(1);
  });
});
