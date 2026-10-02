/**
 * PATCH /tasks/:id { status: "backlog" } — the human-only "demote" special case
 * (agent-tasks task 7c64e80c): an OPEN task with no work or review claim goes
 * back to backlog, behind a compare-and-swap, with its own audit action and
 * its pending signals acknowledged.
 *
 * The taskRouter is mounted on a throw-away Hono app. Prisma is replaced by a
 * tiny in-memory task row whose `updateMany` evaluates the `where` clause it
 * is given (status plus the four claim columns) the way Postgres would, so a
 * CAS that drops a condition really does write the row in these tests instead
 * of merely looking different. `mutateGroundingRouteContext` is replaced by a
 * stand-in that runs the route's own `revalidate` then `mutate` against the
 * row's current state, with injectable hooks that let a test change the row
 * (a concurrent task_start) at the two points where a race can land.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

type Row = Record<string, unknown> & {
  id: string;
  status: string;
  claimedByUserId: string | null;
  claimedByAgentId: string | null;
  reviewClaimedByUserId: string | null;
  reviewClaimedByAgentId: string | null;
};

const store = vi.hoisted(() => ({
  row: null as unknown as Row,
  // Runs after the handler's first read, before the route's transaction opens.
  beforeTransaction: null as (() => void) | null,
  // Runs inside the stand-in transaction, after `revalidate` and before `mutate`.
  afterRevalidate: null as (() => void) | null,
  transactionOpened: 0,
}));

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn(),
  taskUpdateMany: vi.fn(),
  signalUpdateMany: vi.fn(),
  workflowFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      update: prismaMocks.taskUpdate,
      updateMany: prismaMocks.taskUpdateMany,
    },
    signal: { updateMany: prismaMocks.signalUpdateMany },
    workflow: { findFirst: prismaMocks.workflowFindFirst },
    user: { findUnique: prismaMocks.userFindUnique },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn(),
  hasProjectRole: vi.fn(),
  isProjectAdmin: vi.fn(),
  requireProjectWrite: vi.fn(),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);

const emitters = vi.hoisted(() => ({
  emitTaskAvailableSignal: vi.fn().mockResolvedValue(undefined),
  emitReviewSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/task-signal.js", () => ({
  emitTaskAvailableSignal: emitters.emitTaskAvailableSignal,
}));
vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: emitters.emitReviewSignal,
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

vi.mock("../../src/services/grounding-route-context.js", () => ({
  mutateGroundingRouteContext: async (
    _client: unknown,
    input: {
      revalidate: (db: unknown, task: never) => Promise<void>;
      mutate: (
        db: { task: { updateMany: typeof prismaMocks.taskUpdateMany } },
        task: never,
      ) => Promise<{ value: unknown; changed: boolean }>;
    },
  ) => {
    store.transactionOpened += 1;
    const db = { task: { updateMany: prismaMocks.taskUpdateMany } };
    await input.revalidate(db, { ...store.row } as never);
    store.afterRevalidate?.();
    return input.mutate(db, { ...store.row } as never);
  },
  presentGroundingRouteContext: async (_client: unknown, input: { present: (task: never, context: { mode: "UNPROVISIONED" }) => Promise<unknown> }) => ({
    task: {} as never,
    context: { mode: "UNPROVISIONED" },
    value: await input.present({} as never, { mode: "UNPROVISIONED" }),
  }),
  buildExternalGroundingHint: (taskId: string) => ({ taskId, kind: "external_grounding_v1" }),
  selectGroundingRouteContext: vi.fn().mockResolvedValue({ mode: "UNPROVISIONED" }),
}));

import { taskRouter } from "../../src/routes/tasks.js";
import { logAuditEvent } from "../../src/services/audit.js";

const HUMAN: Actor = { type: "human", userId: "user-1", teamId: "team-1" };
const AGENT_WITH_UPDATE: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  userId: "user-1",
  scopes: ["tasks:read", "tasks:claim", "tasks:transition", "tasks:update"],
};

function openRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Promoted by mistake",
    description: "d",
    status: "open",
    priority: "MEDIUM",
    workflowId: null,
    workflow: null,
    templateData: null,
    labels: [],
    deliverableRepo: null,
    createdByAgentId: "agent-author",
    createdByUserId: null,
    claimedByAgentId: null,
    claimedByUserId: null,
    claimedAt: null,
    reviewClaimedByAgentId: null,
    reviewClaimedByUserId: null,
    reviewClaimedAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    project: {
      id: "proj-1",
      teamId: "team-1",
      githubRepo: "acme/thing",
      requireDistinctReviewer: false,
      soloMode: false,
      governanceMode: "AUTONOMOUS",
    },
    ...overrides,
  };
}

function makeApp(actor: Actor = HUMAN) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

function patchStatus(app: Hono<{ Variables: AppVariables }>, status: string, extra: Record<string, unknown> = {}) {
  return app.request("/tasks/task-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, ...extra }),
  });
}

/** What Postgres does with the CAS `where`: every listed column must match. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => row[key] === expected);
}

const CLAIM_COLUMNS = [
  "claimedByUserId",
  "claimedByAgentId",
  "reviewClaimedByUserId",
  "reviewClaimedByAgentId",
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  store.row = openRow();
  store.beforeTransaction = null;
  store.afterRevalidate = null;
  store.transactionOpened = 0;
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);
  prismaMocks.workflowFindFirst.mockResolvedValue(null);
  prismaMocks.userFindUnique.mockResolvedValue({ name: "Human" });
  prismaMocks.signalUpdateMany.mockResolvedValue({ count: 2 });
  prismaMocks.taskFindUnique.mockImplementation(async () => {
    const snapshot = { ...store.row };
    // The first read hands the handler a snapshot; the hook then lets a test
    // change the stored row, exactly like a task_start landing right after it.
    if (store.beforeTransaction) {
      const hook = store.beforeTransaction;
      store.beforeTransaction = null;
      queueMicrotask(hook);
    }
    return snapshot;
  });
  prismaMocks.taskUpdate.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ ...store.row, ...data }),
  );
  prismaMocks.taskUpdateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!matches(store.row, where)) return { count: 0 };
      store.row = { ...store.row, ...data };
      return { count: 1 };
    },
  );
});

describe("PATCH /tasks/:id { status: 'backlog' }: demote an open, unclaimed task", () => {
  it("write-access human demotes open->backlog (200), audits task.backlog_demoted, acknowledges the task's signals", async () => {
    const res = await patchStatus(makeApp(), "backlog");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { status: string } };
    expect(body.task.status).toBe("backlog");
    expect(store.row.status).toBe("backlog");

    // The write is the CAS: status open and all four claim columns null.
    expect(prismaMocks.taskUpdateMany).toHaveBeenCalledTimes(1);
    const cas = prismaMocks.taskUpdateMany.mock.calls[0]![0];
    expect(cas.where).toEqual({
      id: "task-1",
      status: "open",
      claimedByUserId: null,
      claimedByAgentId: null,
      reviewClaimedByUserId: null,
      reviewClaimedByAgentId: null,
    });
    expect(cas.data.status).toBe("backlog");
    // Never the unconditional single-row write.
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();

    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.backlog_demoted",
        actorId: "user-1",
        taskId: "task-1",
        projectId: "proj-1",
        payload: expect.objectContaining({ from: "open", to: "backlog", actorType: "human", via: "patch" }),
      }),
    );

    // Pending signals for exactly this task are acknowledged, once.
    expect(prismaMocks.signalUpdateMany).toHaveBeenCalledTimes(1);
    const ack = prismaMocks.signalUpdateMany.mock.calls[0]![0];
    expect(ack.where).toEqual({ taskId: "task-1", acknowledgedAt: null });
    expect(ack.data.acknowledgedAt).toBeInstanceOf(Date);

    // Demote announces nothing: no task_available fan-out, no review signal.
    expect(emitters.emitTaskAvailableSignal).not.toHaveBeenCalled();
    expect(emitters.emitReviewSignal).not.toHaveBeenCalled();
  });

  it("the demote check needs write access only, not project admin", async () => {
    const res = await patchStatus(makeApp(), "backlog");
    expect(res.status).toBe(200);
    expect(accessMocks.isProjectAdmin).not.toHaveBeenCalled();
    expect(accessMocks.hasProjectRole).not.toHaveBeenCalled();
  });

  it("a no-op status (backlog task patched with backlog) is not a demote: 200, no audit, no CAS, no ack", async () => {
    store.row = openRow({ status: "backlog" });
    const res = await patchStatus(makeApp(), "backlog");
    expect(res.status).toBe(200);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(prismaMocks.signalUpdateMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /tasks/:id { status: 'backlog' }: rejections", () => {
  it("agent caller is rejected by the status field lock (403), nothing is written", async () => {
    const res = await patchStatus(makeApp(AGENT_WITH_UPDATE), "backlog");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("Agents cannot update: status");
    expect(store.transactionOpened).toBe(0);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(prismaMocks.signalUpdateMany).not.toHaveBeenCalled();
  });

  it("human without project write access gets 403 and nothing is written", async () => {
    accessMocks.requireProjectWrite.mockResolvedValue(false);
    const res = await patchStatus(makeApp(), "backlog");
    expect(res.status).toBe(403);
    expect(store.transactionOpened).toBe(0);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(store.row.status).toBe("open");
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(prismaMocks.signalUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["work claim by a user", { claimedByUserId: "user-2" }],
    ["work claim by an agent", { claimedByAgentId: "agent-2" }],
    ["review claim by a user", { reviewClaimedByUserId: "user-3" }],
    ["review claim by an agent", { reviewClaimedByAgentId: "agent-3" }],
  ])("open task with a %s is refused with 409 before any write transaction opens", async (_label, claim) => {
    store.row = openRow(claim as Partial<Row>);
    const before = { ...store.row };

    const res = await patchStatus(makeApp(), "backlog");

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("conflict");
    expect(body.message).toContain("no work or review claim");
    // Rejected on the fast path: the route never even opened its transaction.
    expect(store.transactionOpened).toBe(0);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(store.row).toEqual(before);
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(prismaMocks.signalUpdateMany).not.toHaveBeenCalled();
  });

  it.each(["in_progress", "review", "done", "abandoned"])(
    "%s -> backlog is rejected (400), unclaimed rows included: only open can be demoted",
    async (fromStatus) => {
      store.row = openRow({ status: fromStatus });

      const res = await patchStatus(makeApp(), "backlog");

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("bad_request");
      expect(store.transactionOpened).toBe(0);
      expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
      expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
      expect(store.row.status).toBe(fromStatus);
      expect(logAuditEvent).not.toHaveBeenCalled();
      expect(prismaMocks.signalUpdateMany).not.toHaveBeenCalled();
    },
  );

  it("an unknown status value is still a schema 400", async () => {
    const res = await patchStatus(makeApp(), "icebox");
    expect(res.status).toBe(400);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /tasks/:id { status: 'backlog' }: race with a concurrent claim", () => {
  const claimNow = () => {
    store.row = { ...store.row, status: "in_progress", claimedByAgentId: "agent-racer" };
  };

  it("claim lands before the locked re-check: 409, the CAS write is never attempted", async () => {
    store.beforeTransaction = claimNow;

    const res = await patchStatus(makeApp(), "backlog");

    expect(res.status).toBe(409);
    expect(store.transactionOpened).toBe(1);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(store.row.status).toBe("in_progress");
    expect(store.row.claimedByAgentId).toBe("agent-racer");
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(prismaMocks.signalUpdateMany).not.toHaveBeenCalled();
  });

  it.each(CLAIM_COLUMNS)(
    "a %s claim that lands before the locked re-check (status still open): 409, the CAS write is never attempted",
    async (column) => {
      store.beforeTransaction = () => {
        store.row = { ...store.row, [column]: "racer" };
      };

      const res = await patchStatus(makeApp(), "backlog");

      expect(res.status).toBe(409);
      expect(store.transactionOpened).toBe(1);
      expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
      expect(store.row.status).toBe("open");
      expect(store.row[column]).toBe("racer");
      expect(logAuditEvent).not.toHaveBeenCalled();
      expect(prismaMocks.signalUpdateMany).not.toHaveBeenCalled();
    },
  );

  it("claim lands between the re-check and the write: the CAS matches zero rows (409), the claim survives, no backlog task with a claim", async () => {
    store.afterRevalidate = () => {
      store.row = { ...store.row, claimedByAgentId: "agent-racer" };
    };

    const res = await patchStatus(makeApp(), "backlog");

    expect(res.status).toBe(409);
    expect(prismaMocks.taskUpdateMany).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("open");
    expect(store.row.claimedByAgentId).toBe("agent-racer");
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(prismaMocks.signalUpdateMany).not.toHaveBeenCalled();
  });

  it.each(CLAIM_COLUMNS)(
    "a %s claim that lands between the re-check and the write is not overwritten",
    async (column) => {
      store.afterRevalidate = () => {
        store.row = { ...store.row, [column]: "racer" };
      };

      const res = await patchStatus(makeApp(), "backlog");

      expect(res.status).toBe(409);
      expect(store.row.status).toBe("open");
      expect(store.row[column]).toBe("racer");
      expect(logAuditEvent).not.toHaveBeenCalled();
    },
  );

  it("status changes under the lock without any claim (open -> review): the locked re-check refuses, nothing is written", async () => {
    store.beforeTransaction = () => {
      store.row = { ...store.row, status: "review" };
    };

    const res = await patchStatus(makeApp(), "backlog");

    expect(res.status).toBe(409);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(store.row.status).toBe("review");
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("status changes between the re-check and the write (no claim): the CAS matches zero rows (409)", async () => {
    store.afterRevalidate = () => {
      store.row = { ...store.row, status: "review" };
    };

    const res = await patchStatus(makeApp(), "backlog");

    expect(res.status).toBe(409);
    expect(prismaMocks.taskUpdateMany).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("review");
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(prismaMocks.signalUpdateMany).not.toHaveBeenCalled();
  });

  it("write access revoked between the first check and the locked re-check: 403, nothing is written", async () => {
    // Fast path (route-level check) passes, the transaction-level check fails.
    accessMocks.requireProjectWrite.mockResolvedValueOnce(true).mockResolvedValue(false);

    const res = await patchStatus(makeApp(), "backlog");

    expect(res.status).toBe(403);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(store.row.status).toBe("open");
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});

describe("other paths to backlog and the sibling special cases stay as they were", () => {
  it("promote (backlog -> open) still writes through the plain update, audits task.backlog_promoted, acknowledges nothing", async () => {
    store.row = openRow({ status: "backlog" });
    const res = await patchStatus(makeApp(), "open");
    expect(res.status).toBe(200);
    expect(prismaMocks.taskUpdate).toHaveBeenCalledTimes(1);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "task.backlog_promoted" }));
    expect(prismaMocks.signalUpdateMany).not.toHaveBeenCalled();
  });

  it("discard (backlog -> abandoned) still audits task.backlog_discarded and never touches the demote CAS", async () => {
    store.row = openRow({ status: "backlog" });
    const res = await patchStatus(makeApp(), "abandoned");
    expect(res.status).toBe(200);
    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "task.backlog_discarded" }));
    expect(prismaMocks.signalUpdateMany).not.toHaveBeenCalled();
  });
});
