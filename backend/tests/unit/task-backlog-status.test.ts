/**
 * v1 backlog status routing: agent-created tasks are hard-routed to
 * `backlog` (unclaimable, no task_available signal) and stay invisible to
 * task_pickup / task_start until an operator promotes them. Human-created
 * tasks are unaffected. Covers:
 *   - POST /projects/:projectId/tasks: agent default + explicit routing
 *     (backlog_routing_enforced on a non-backlog explicit status), human
 *     pass-through, task_available signal suppression for backlog.
 *   - POST /tasks/:id/start: backlog_not_promoted (403) ahead of the
 *     generic bad_state (409) fallback, for an agent caller.
 *   - POST /tasks/pickup: a backlog task is never returned by the work-pool
 *     query even when older/higher priority than a genuinely open task in
 *     the same pool, and a dependent blocked solely by a backlog blocker
 *     stays blocked.
 *   - Regression: a pre-existing (DB-seeded) agent-created `open` task is
 *     unaffected — task_start still claims it normally.
 *
 * Mirrors the mocking setup of task-create-depends-on.test.ts (create) and
 * tasks-v2-routes.test.ts (start/pickup), trimmed to what these paths need.
 * Follows the project memory on the vitest mock-queue leak: no persistent
 * `mockResolvedValueOnce` queues survive `vi.clearAllMocks` across tests, so
 * each test sets up its own queue from a clean slate in `beforeEach`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

const prismaMocks = vi.hoisted(() => ({
  taskCreate: vi.fn(),
  taskFindFirst: vi.fn(),
  taskFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  taskUpdate: vi.fn(),
  taskUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  signalFindFirst: vi.fn(),
  signalUpdate: vi.fn(),
  workflowFindFirst: vi.fn(),
  agentTokenFindUnique: vi.fn().mockResolvedValue({ name: "Agent" }),
  userFindUnique: vi.fn().mockResolvedValue({ name: "Human" }),
  projectFindUnique: vi.fn().mockResolvedValue({ confidenceThreshold: 0, taskTemplate: null }),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      create: prismaMocks.taskCreate,
      findFirst: prismaMocks.taskFindFirst,
      findUnique: prismaMocks.taskFindUnique,
      findMany: prismaMocks.taskFindMany,
      update: prismaMocks.taskUpdate,
      updateMany: prismaMocks.taskUpdateMany,
    },
    signal: {
      findFirst: prismaMocks.signalFindFirst,
      update: prismaMocks.signalUpdate,
    },
    workflow: { findFirst: prismaMocks.workflowFindFirst },
    agentToken: { findUnique: prismaMocks.agentTokenFindUnique },
    user: { findUnique: prismaMocks.userFindUnique },
    project: { findUnique: prismaMocks.projectFindUnique },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
  resolveTeamId: vi.fn().mockResolvedValue({ ok: true, teamId: "team-1" }),
  resolveTeamIdErrorBody: vi.fn(),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);

const signalEmitters = vi.hoisted(() => ({
  emitTaskAvailableSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/task-signal.js", () => ({
  emitTaskAvailableSignal: signalEmitters.emitTaskAvailableSignal,
}));
vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: vi.fn().mockResolvedValue(undefined),
  emitChangesRequestedSignal: vi.fn().mockResolvedValue(undefined),
  emitTaskApprovedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/force-transition-signal.js", () => ({
  emitForceTransitionedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/self-merge-notice.js", () => ({
  emitSelfMergeNoticeIfApplicable: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/github-merge.js", () => ({ performPrMerge: vi.fn() }));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/services/grounding-client.js", () => ({
  getGroundingClient: () => ({
    start: vi.fn().mockResolvedValue(null),
    getLedgerSummary: vi.fn().mockResolvedValue({ entryCount: 0 }),
  }),
  RealGroundingClient: class {},
  NullGroundingClient: class {},
  __resetGroundingClientCacheForTests: () => {},
}));

import { taskRouter } from "../../src/routes/tasks.js";

const AGENT: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  userId: "agent-1",
  scopes: ["tasks:read", "tasks:claim", "tasks:transition", "tasks:create"],
};

const HUMAN: Actor = {
  type: "human",
  userId: "human-1",
  teamId: "team-1",
};

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

async function postCreate(actor: Actor, body: Record<string, unknown>) {
  return makeApp(actor).request(`/projects/${PROJECT_ID}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Base fixture for /tasks/:id/start and /tasks/pickup — mirrors baseTask in
// tasks-v2-routes.test.ts, trimmed to the fields those two routes read.
const baseTask = {
  id: "task-1",
  projectId: PROJECT_ID,
  title: "Some task",
  description: "do the thing",
  priority: "MEDIUM",
  workflowId: null,
  workflow: null,
  templateData: null,
  createdByAgentId: "agent-author",
  createdByUserId: null,
  claimedByAgentId: null,
  claimedByUserId: null,
  claimedAt: null,
  reviewClaimedByAgentId: null,
  reviewClaimedByUserId: null,
  reviewClaimedAt: null,
  branchName: "feat/test-branch",
  prUrl: null,
  prNumber: null,
  result: null,
  autoMergeSha: null,
  labels: [],
  metadata: { debugFlavor: false },
  project: {
    id: PROJECT_ID,
    name: "Agent Tasks",
    slug: "agent-tasks",
    teamId: "team-1",
    githubRepo: "acme/thing",
    confidenceThreshold: 0,
    taskTemplate: null,
    requireDistinctReviewer: false,
    soloMode: false,
    requireGroundingForDebug: false,
  },
  attachments: [],
  comments: [],
  claimedByUser: null,
  claimedByAgent: null,
  blockedBy: [],
  blocks: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);
  prismaMocks.agentTokenFindUnique.mockResolvedValue({ name: "Agent" });
  prismaMocks.userFindUnique.mockResolvedValue({ name: "Human" });
  prismaMocks.projectFindUnique.mockResolvedValue({ confidenceThreshold: 0, taskTemplate: null });
  prismaMocks.taskCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "task-new", ...data, attachments: [], artifacts: [], comments: [] }),
  );
  prismaMocks.taskUpdateMany.mockResolvedValue({ count: 1 });
  // task_start's dependency gate queries blockers via a separate findMany
  // (`{ blocks: { some: { id: task.id } } }`); default to none so tests that
  // don't care about it don't have to stub this every time.
  prismaMocks.taskFindMany.mockResolvedValue([]);
});

// ── AC1 + AC2: create-time backlog routing ──────────────────────────────────

describe("POST /projects/:projectId/tasks — v1 backlog routing (agent-created)", () => {
  it("AC1: agent create without status defaults to backlog, and the response names it", async () => {
    const res = await postCreate(AGENT, { title: "Agent task" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { status: string } };
    expect(body.task.status).toBe("backlog");
    expect(prismaMocks.taskCreate.mock.calls[0]![0].data.status).toBe("backlog");
  });

  it("AC1: human create without status still defaults to open, unchanged", async () => {
    const res = await postCreate(HUMAN, { title: "Human task" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { status: string } };
    expect(body.task.status).toBe("open");
    expect(prismaMocks.taskCreate.mock.calls[0]![0].data.status).toBe("open");
  });

  it("AC2: agent create with explicit status:\"backlog\" is accepted", async () => {
    const res = await postCreate(AGENT, { title: "Agent task", status: "backlog" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { status: string } };
    expect(body.task.status).toBe("backlog");
  });

  it("AC2: agent create with explicit status:\"open\" is rejected with backlog_routing_enforced", async () => {
    const res = await postCreate(AGENT, { title: "Agent task", status: "open" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("backlog_routing_enforced");
    expect(body.message).toMatch(/backlog/i);
    expect(body.message).toMatch(/promot/i);
    expect(prismaMocks.taskCreate).not.toHaveBeenCalled();
  });

  it("AC2: agent create with another explicit non-backlog status (in_progress) is also rejected", async () => {
    const res = await postCreate(AGENT, { title: "Agent task", status: "in_progress" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("backlog_routing_enforced");
    expect(prismaMocks.taskCreate).not.toHaveBeenCalled();
  });

  it("AC2: human create with an explicit status (in_progress) passes through unchanged", async () => {
    const res = await postCreate(HUMAN, { title: "Human task", status: "in_progress" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { status: string } };
    expect(body.task.status).toBe("in_progress");
  });
});

// ── AC3: task_available signal suppression for backlog ──────────────────────

describe("POST /projects/:projectId/tasks — task_available signal (backlog vs open)", () => {
  it("AC3: agent create (routed to backlog) does NOT emit task_available", async () => {
    const res = await postCreate(AGENT, { title: "Agent task" });
    expect(res.status).toBe(201);
    expect(signalEmitters.emitTaskAvailableSignal).not.toHaveBeenCalled();
  });

  it("AC3: human create (defaults to open) still emits task_available", async () => {
    const res = await postCreate(HUMAN, { title: "Human task" });
    expect(res.status).toBe(201);
    expect(signalEmitters.emitTaskAvailableSignal).toHaveBeenCalledTimes(1);
    expect(signalEmitters.emitTaskAvailableSignal).toHaveBeenCalledWith(
      "task-new",
      PROJECT_ID,
      "human",
      "Human",
    );
  });
});

// ── AC6 (create half): dependsOn on a backlog task is allowed at create ────

describe("POST /projects/:projectId/tasks — dependsOn a backlog blocker", () => {
  it("accepts a dependsOn pointing at a task that is itself in backlog status (no validation error)", async () => {
    const BLOCKER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    // The dependsOn existence check only queries id+projectId (see
    // task-create-depends-on.test.ts) — it does not filter by status, so a
    // backlog blocker is indistinguishable from any other status here.
    prismaMocks.taskFindMany.mockResolvedValue([{ id: BLOCKER }]);

    const res = await postCreate(HUMAN, { title: "Dependent", dependsOn: [BLOCKER] });
    expect(res.status).toBe(201);
    const createArg = prismaMocks.taskCreate.mock.calls[0]![0];
    expect(createArg.data.blockedBy).toEqual({ connect: [{ id: BLOCKER }] });
  });
});

// ── AC4: task_start backlog guard ────────────────────────────────────────────

describe("POST /tasks/:id/start — v1 backlog routing (task 'backlog_not_promoted')", () => {
  it("AC4: agent task_start on a backlog task returns 403 backlog_not_promoted, not the generic 409", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({ ...baseTask, status: "backlog" });

    const res = await makeApp(AGENT).request("/tasks/task-1/start", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("backlog_not_promoted");
    expect(body.message).toContain("awaits operator promotion");
    // The claim CAS write must never have been attempted.
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("human task_start on a backlog task does not claim it (falls to the existing error path, not a promote)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValueOnce({ ...baseTask, status: "backlog" });

    const res = await makeApp(HUMAN).request("/tasks/task-1/start", { method: "POST" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });
});

// ── AC7: regression — a pre-existing agent-created open task stays claimable ─

describe("POST /tasks/:id/start — regression: pre-existing agent-created open task", () => {
  it("AC7: a DB-seeded agent-created task in status 'open' is still claimed normally by task_start", async () => {
    prismaMocks.taskFindUnique
      .mockResolvedValueOnce({ ...baseTask, status: "open" }) // initial fetch
      .mockResolvedValueOnce({ ...baseTask, status: "in_progress", claimedByAgentId: "agent-1" }); // post-CAS refetch

    const res = await makeApp(AGENT).request("/tasks/task-1/start", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; task: { status: string } };
    expect(body.kind).toBe("work");
    expect(body.task.status).toBe("in_progress");
    expect(prismaMocks.taskUpdateMany).toHaveBeenCalledTimes(1);
  });
});

// ── AC5 + AC6: task_pickup never surfaces a backlog task ─────────────────────

const RESOLVED_BLOCKER_STATUSES = ["done", "abandoned"];

function matchesWorkPickupWhere(
  task: { status: string; claimedByAgentId: string | null; claimedByUserId: string | null; blockedBy: Array<{ status: string }> },
  where: { status: string },
): boolean {
  if (task.status !== where.status) return false;
  if (task.claimedByAgentId !== null || task.claimedByUserId !== null) return false;
  const hasUnresolvedBlocker = task.blockedBy.some((b) => !RESOLVED_BLOCKER_STATUSES.includes(b.status));
  if (hasUnresolvedBlocker) return false;
  return true;
}

const PRIORITY_RANK: Record<string, number> = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

function pickWorkPickupWinner<
  T extends { status: string; priority: string; createdAt: Date; claimedByAgentId: string | null; claimedByUserId: string | null; blockedBy: Array<{ status: string }> },
>(pool: T[], where: { status: string }): T | null {
  const matches = pool.filter((t) => matchesWorkPickupWhere(t, where));
  matches.sort((a, b) => {
    const prioDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (prioDiff !== 0) return prioDiff;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return matches[0] ?? null;
}

describe("POST /tasks/pickup — work pool excludes backlog (real pickup path)", () => {
  it("AC5: never returns a backlog task, even when it is older and higher-priority than the open task in the same pool", async () => {
    const backlogTask = {
      ...baseTask,
      id: "task-backlog",
      status: "backlog",
      priority: "CRITICAL",
      createdAt: new Date("2020-01-01T00:00:00Z"),
      blockedBy: [],
    };
    const openTask = {
      ...baseTask,
      id: "task-open",
      status: "open",
      priority: "LOW",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      blockedBy: [],
    };

    prismaMocks.taskFindFirst
      .mockResolvedValueOnce(null) // hard-limit ok
      .mockResolvedValueOnce(null) // review pickup miss
      .mockImplementationOnce(({ where }: { where: { status: string } }) =>
        Promise.resolve(pickWorkPickupWinner([backlogTask, openTask], where)),
      );
    prismaMocks.signalFindFirst.mockResolvedValueOnce(null);

    const res = await makeApp(AGENT).request("/tasks/pickup", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; task: { id: string } };
    expect(body.kind).toBe("work");
    expect(body.task.id).toBe("task-open");
  });

  it("AC6: a task blocked solely by a backlog-status blocker is not returned by pickup (blockedBy gate)", async () => {
    const blockedByBacklog = {
      ...baseTask,
      id: "task-dependent",
      status: "open",
      priority: "CRITICAL",
      createdAt: new Date("2020-01-01T00:00:00Z"),
      blockedBy: [{ id: "task-backlog-blocker", status: "backlog" }],
    };
    const genuinelyOpen = {
      ...baseTask,
      id: "task-open",
      status: "open",
      priority: "LOW",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      blockedBy: [],
    };

    prismaMocks.taskFindFirst
      .mockResolvedValueOnce(null) // hard-limit ok
      .mockResolvedValueOnce(null) // review pickup miss
      .mockImplementationOnce(({ where }: { where: { status: string } }) =>
        Promise.resolve(pickWorkPickupWinner([blockedByBacklog, genuinelyOpen], where)),
      );
    prismaMocks.signalFindFirst.mockResolvedValueOnce(null);

    const res = await makeApp(AGENT).request("/tasks/pickup", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; task: { id: string } };
    expect(body.kind).toBe("work");
    // The higher-priority, older task is blocked by an unresolved (backlog)
    // blocker, so the lower-priority, unblocked task wins instead.
    expect(body.task.id).toBe("task-open");
  });
});
