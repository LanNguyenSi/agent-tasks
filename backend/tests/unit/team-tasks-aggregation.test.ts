/**
 * Coverage for `GET /teams/:teamId/tasks` — the aggregation endpoint that
 * collapsed the home-page fan-out (one HTTP per project) into a single
 * server-resolved query. Mock-Prisma based; verifies project resolution,
 * filter translation, default + max limit, and the projects metadata
 * returned alongside the tasks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { AgentActor, HumanActor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  projectFindMany: vi.fn(),
  taskGroupBy: vi.fn(),
  taskCount: vi.fn(),
  workflowFindMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findMany: prismaMocks.taskFindMany,
      groupBy: prismaMocks.taskGroupBy,
      count: prismaMocks.taskCount,
    },
    project: { findMany: prismaMocks.projectFindMany },
    workflow: { findMany: prismaMocks.workflowFindMany },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
  resolveTeamId: vi.fn().mockResolvedValue({ ok: true, teamId: "team-A" }),
  resolveTeamIdErrorBody: vi.fn().mockReturnValue({ error: "x" }),
}));

vi.mock("../../src/services/team-access.js", () => accessMocks);

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: vi.fn().mockResolvedValue(undefined),
  emitChangesRequestedSignal: vi.fn().mockResolvedValue(undefined),
  emitTaskApprovedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/task-signal.js", () => ({
  emitTaskAvailableSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/force-transition-signal.js", () => ({
  emitForceTransitionedSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/self-merge-notice.js", () => ({
  emitSelfMergeNoticeIfApplicable: vi.fn().mockResolvedValue(0),
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

import { taskRouter, ID_FRAGMENT_GATE, normalizeIdQuery } from "../../src/routes/tasks.js";

const AGENT: AgentActor = {
  type: "agent",
  tokenId: "agent-tok",
  teamId: "team-A",
  scopes: ["tasks:read"],
  userId: "agent-owner",
};

const HUMAN: HumanActor = {
  type: "human",
  userId: "u-1",
};

function makeApp(actor: AgentActor | HumanActor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // No workflow rows: every task resolves to the built-in workflow.
  prismaMocks.workflowFindMany.mockResolvedValue([]);
  accessMocks.resolveTeamId.mockResolvedValue({ ok: true, teamId: "team-A" });
  prismaMocks.projectFindMany.mockResolvedValue([
    { id: "p-1", teamId: "team-A", name: "Owned", slug: "owned" },
    { id: "p-2", teamId: "team-A", name: "Owned 2", slug: "owned-2" },
  ]);
  prismaMocks.taskFindMany.mockResolvedValue([
    { id: "t-1", projectId: "p-1", title: "Task 1", status: "open", priority: "HIGH", labels: [], updatedAt: new Date() },
    { id: "t-2", projectId: "p-2", title: "Task 2", status: "review", priority: "LOW", labels: [], updatedAt: new Date() },
  ]);
  // Default count-stack: groupBy returns one row per status; count() is
  // invoked six times, in this order: filteredTotal, priority, mine,
  // doneRecent, doneOlder, active. Tests that need other shapes call
  // .mockReset() and re-prime explicitly.
  prismaMocks.taskGroupBy.mockResolvedValue([
    { status: "open", _count: { _all: 70 } },
    { status: "in_progress", _count: { _all: 5 } },
    { status: "review", _count: { _all: 1 } },
    { status: "done", _count: { _all: 778 } },
  ]);
  prismaMocks.taskCount
    .mockResolvedValueOnce(2) // filteredTotal
    .mockResolvedValueOnce(12) // priority
    .mockResolvedValueOnce(3) // mine
    .mockResolvedValueOnce(100) // doneRecent
    .mockResolvedValueOnce(678) // doneOlder
    .mockResolvedValueOnce(42); // active (counts.open)
});

describe("GET /teams/:teamId/tasks (aggregation)", () => {
  it("returns the union of tasks across team-accessible projects in one roundtrip", async () => {
    const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string }[]; projects: { id: string }[] };
    expect(body.tasks.map((t) => t.id).sort()).toEqual(["t-1", "t-2"]);
    expect(body.projects.map((p) => p.id).sort()).toEqual(["p-1", "p-2"]);
  });

  it("for humans, projectFindMany expands to OR(team-owned, projectMembers.some)", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks");
    const where = prismaMocks.projectFindMany.mock.calls[0]![0]!.where;
    expect(where).toEqual({
      OR: [
        { teamId: "team-A" },
        { projectMembers: { some: { userId: "u-1" } } },
      ],
    });
  });

  it("for agents, projectFindMany stays team-only", async () => {
    await makeApp(AGENT).request("/teams/team-A/tasks");
    const where = prismaMocks.projectFindMany.mock.calls[0]![0]!.where;
    expect(where).toEqual({ teamId: "team-A" });
  });

  it("scopes the task query to projectId IN (resolvedProjectIds)", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks");
    const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
    expect(where.projectId).toEqual({ in: ["p-1", "p-2"] });
  });

  it("translates ?status=open,in_progress into a status IN clause", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks?status=open,in_progress");
    const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
    expect(where.status).toEqual({ in: ["open", "in_progress"] });
  });

  it("translates ?priority=HIGH,CRITICAL into a priority IN clause (case-normalised)", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks?priority=high,critical");
    const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
    expect(where.priority).toEqual({ in: ["HIGH", "CRITICAL"] });
  });

  it("translates ?labels=foo,bar into a labels hasSome clause", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks?labels=foo,bar");
    const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
    expect(where.labels).toEqual({ hasSome: ["foo", "bar"] });
  });

  it("defaults limit to 500 when not specified", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks");
    const args = prismaMocks.taskFindMany.mock.calls[0]![0]!;
    expect(args.take).toBe(500);
  });

  it("respects ?limit=N up to a hard cap of 1000", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks?limit=50");
    expect(prismaMocks.taskFindMany.mock.calls[0]![0]!.take).toBe(50);
    prismaMocks.taskFindMany.mockClear();
    await makeApp(HUMAN).request("/teams/team-A/tasks?limit=99999");
    expect(prismaMocks.taskFindMany.mock.calls[0]![0]!.take).toBe(1000);
  });

  it("returns empty arrays without hitting Task.findMany when the user has no projects", async () => {
    prismaMocks.projectFindMany.mockResolvedValueOnce([]);
    const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: unknown[];
      projects: unknown[];
      counts: { total: number; done: number };
    };
    expect(body.tasks).toEqual([]);
    expect(body.projects).toEqual([]);
    expect(body.counts).toEqual({ open: 0, review: 0, done: 0, doneRecent: 0, doneOlder: 0, priority: 0, mine: 0, backlog: 0, total: 0 });
    expect(prismaMocks.taskFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.taskGroupBy).not.toHaveBeenCalled();
    expect(prismaMocks.taskCount).not.toHaveBeenCalled();
  });

  it("annotates shared projects with accessSource:'project' for humans", async () => {
    prismaMocks.projectFindMany.mockResolvedValueOnce([
      { id: "p-team", teamId: "team-A", name: "Owned", slug: "owned" },
      { id: "p-shared", teamId: "team-OTHER", name: "Shared", slug: "shared" },
    ]);
    const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
    const body = (await res.json()) as { projects: Array<{ id: string; accessSource: string }> };
    expect(body.projects.find((p) => p.id === "p-team")?.accessSource).toBe("team");
    expect(body.projects.find((p) => p.id === "p-shared")?.accessSource).toBe("project");
  });

  it("propagates 403 from resolveTeamId when the actor cannot access the team", async () => {
    accessMocks.resolveTeamId.mockResolvedValueOnce({
      ok: false,
      status: 403,
      code: "forbidden",
      message: "Access denied",
    });
    accessMocks.resolveTeamIdErrorBody.mockReturnValueOnce({
      error: "forbidden",
      message: "Access denied",
    });
    const res = await makeApp(HUMAN).request("/teams/team-X/tasks");
    expect(res.status).toBe(403);
    expect(prismaMocks.projectFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.taskFindMany).not.toHaveBeenCalled();
  });

  it("orders tasks by updatedAt desc", async () => {
    await makeApp(HUMAN).request("/teams/team-A/tasks");
    const args = prismaMocks.taskFindMany.mock.calls[0]![0]!;
    expect(args.orderBy).toEqual({ updatedAt: "desc" });
  });

  describe("counts block", () => {
    it("returns per-bucket counts derived from groupBy + targeted counts", async () => {
      const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
      const body = (await res.json()) as {
        counts: {
          open: number;
          review: number;
          done: number;
          priority: number;
          mine: number;
          total: number;
        };
      };
      // open (the active tile) is the workflow-derived active count(), not a
      // groupBy bucket sum (see the active count tests below).
      expect(body.counts.open).toBe(42);
      expect(body.counts.review).toBe(1);
      expect(body.counts.done).toBe(778);
      // priority + mine come from the two count() calls (12 then 3)
      expect(body.counts.priority).toBe(12);
      expect(body.counts.mine).toBe(3);
      // total is the sum of every status bucket from groupBy
      expect(body.counts.total).toBe(70 + 5 + 1 + 778);
    });

    it("counts query is unaffected by ?status / ?priority / ?labels filters (badges show team-wide totals)", async () => {
      await makeApp(HUMAN).request(
        "/teams/team-A/tasks?status=open&priority=high&labels=foo",
      );
      const groupByWhere = prismaMocks.taskGroupBy.mock.calls[0]![0]!.where;
      // No status / priority / labels narrowing on the count base —
      // only the projectId scope.
      expect(groupByWhere).toEqual({ projectId: { in: ["p-1", "p-2"] } });
    });

    it("priority count is HIGH|CRITICAL on actionable statuses only (no done, abandoned or backlog)", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks");
      // calls[0] is the filteredTotal count; priority is the second count.
      // Kept in sync with the frontend's isPriorityTask (home/widgetFilters.ts)
      // and the /tasks scope=priority preset: a done, abandoned or backlog
      // HIGH/CRITICAL task must not inflate the badge over the widget rows.
      const priorityWhere = prismaMocks.taskCount.mock.calls[1]![0]!.where;
      expect(priorityWhere).toEqual({
        projectId: { in: ["p-1", "p-2"] },
        priority: { in: ["HIGH", "CRITICAL"] },
        status: { notIn: ["backlog", "abandoned"] },
        // "Actionable" excludes the terminal state of each task's own
        // workflow; with no workflow rows that is the built-in `done`.
        AND: [{ OR: [{ workflowId: null, status: { notIn: ["done"] } }] }],
      });
    });

    it("mine count is scoped to actor.userId AND status != done", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks");
      const mineWhere = prismaMocks.taskCount.mock.calls[2]![0]!.where;
      // "Not done" is the terminal state of each task's own workflow; with no
      // workflow rows every task is judged by the built-in one (`done`).
      expect(mineWhere).toEqual({
        projectId: { in: ["p-1", "p-2"] },
        claimedByUserId: "u-1",
        AND: [{ OR: [{ workflowId: null, status: { notIn: ["done"] } }] }],
      });
    });

    it("mine count uses the agent actor's userId for agent callers", async () => {
      await makeApp(AGENT).request("/teams/team-A/tasks");
      const mineWhere = prismaMocks.taskCount.mock.calls[2]![0]!.where;
      expect(mineWhere).toMatchObject({ claimedByUserId: "agent-owner" });
    });

    it("falls back to zero buckets when groupBy returns no rows", async () => {
      prismaMocks.taskGroupBy.mockReset();
      prismaMocks.taskGroupBy.mockResolvedValue([]);
      prismaMocks.taskCount.mockReset();
      prismaMocks.taskCount.mockResolvedValue(0);
      const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
      const body = (await res.json()) as { counts: Record<string, number> };
      expect(body.counts).toEqual({
        open: 0,
        review: 0,
        done: 0,
        doneRecent: 0,
        doneOlder: 0,
        priority: 0,
        mine: 0,
        backlog: 0,
        total: 0,
      });
    });

    it("backlog count is read from the groupBy bucket (agent-created, awaiting promotion)", async () => {
      prismaMocks.taskGroupBy.mockResolvedValueOnce([
        { status: "open", _count: { _all: 70 } },
        { status: "in_progress", _count: { _all: 5 } },
        { status: "review", _count: { _all: 1 } },
        { status: "done", _count: { _all: 778 } },
        { status: "backlog", _count: { _all: 9 } },
      ]);
      const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
      const body = (await res.json()) as { counts: { backlog: number; total: number } };
      expect(body.counts.backlog).toBe(9);
      // total sums every status bucket from groupBy, backlog included.
      expect(body.counts.total).toBe(70 + 5 + 1 + 778 + 9);
    });

    // counts.open is the team-wide active count: a state of the task's own
    // effective workflow that is neither terminal nor review-like, and never
    // a backlog draft or abandoned (see the "active" kind in
    // services/workflow-status-filter.ts). Kept in sync with the frontend's
    // isActiveTask/activeStatusParam (home/widgetFilters.ts). The count is
    // the sixth taskCount() call; the workflow rows come from the same
    // workflowFindMany read priorityCount uses.
    const CUSTOM_WF = {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "plan", label: "Plan", terminal: false },
        { name: "build", label: "Build", terminal: false },
        { name: "qa", label: "QA", terminal: false },
        { name: "shipped", label: "Shipped", terminal: true },
      ],
      transitions: [
        { from: "open", to: "plan" },
        { from: "plan", to: "build" },
        { from: "build", to: "qa" },
        { from: "qa", to: "shipped" },
        { from: "qa", to: "build" },
      ],
    };
    const FOUR_STATE_WF = {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "in_progress", label: "In progress", terminal: false },
        { name: "review", label: "Review", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [
        { from: "open", to: "in_progress" },
        { from: "in_progress", to: "review" },
        { from: "review", to: "done" },
        { from: "review", to: "in_progress" },
      ],
    };

    it("active count with no stored workflows asks for the built-in active states only", async () => {
      const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
      const body = (await res.json()) as { counts: { open: number } };
      expect(body.counts.open).toBe(42); // the sixth count() in the beforeEach stack
      const activeWhere = prismaMocks.taskCount.mock.calls[5]![0]!.where;
      expect(activeWhere).toEqual({
        projectId: { in: ["p-1", "p-2"] },
        AND: [{ OR: [{ workflowId: null, status: { in: ["in_progress", "open"] } }] }],
      });
    });

    it("active count follows a project's custom workflow: plan and build count, qa and shipped do not", async () => {
      // p-1 gets the custom default (open, plan, build, qa, shipped; qa is
      // review-like, shipped terminal), p-2 keeps the built-in workflow.
      prismaMocks.workflowFindMany.mockResolvedValueOnce([
        { id: "w-4", projectId: "p-1", isDefault: true, definition: CUSTOM_WF },
      ]);
      const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
      const body = (await res.json()) as { counts: { open: number } };
      expect(body.counts.open).toBe(42);
      const activeWhere = prismaMocks.taskCount.mock.calls[5]![0]!.where;
      expect(activeWhere).toEqual({
        projectId: { in: ["p-1", "p-2"] },
        AND: [
          {
            OR: [
              // Tasks pinned to the custom workflow: its non-terminal,
              // non-review-like states only (build and plan are in; qa,
              // shipped and any name outside the workflow are not).
              { workflowId: { in: ["w-4"] }, status: { in: ["build", "open", "plan"] } },
              // Unpinned p-1 tasks resolve to the same row as project default.
              { workflowId: null, projectId: { in: ["p-1"] }, status: { in: ["build", "open", "plan"] } },
              // Everything else reads as the built-in workflow.
              { workflowId: null, projectId: { notIn: ["p-1"] }, status: { in: ["in_progress", "open"] } },
            ],
          },
        ],
      });
    });

    it("active count for four-state projects is exactly open + in_progress (today's numbers)", async () => {
      prismaMocks.workflowFindMany.mockResolvedValueOnce([
        { id: "w-1", projectId: "p-1", isDefault: true, definition: FOUR_STATE_WF },
        { id: "w-2", projectId: "p-2", isDefault: true, definition: FOUR_STATE_WF },
      ]);
      await makeApp(HUMAN).request("/teams/team-A/tasks");
      const activeWhere = prismaMocks.taskCount.mock.calls[5]![0]!.where;
      expect(activeWhere).toEqual({
        projectId: { in: ["p-1", "p-2"] },
        AND: [
          {
            OR: [
              { workflowId: { in: ["w-1", "w-2"] }, status: { in: ["in_progress", "open"] } },
              { workflowId: null, projectId: { in: ["p-1", "p-2"] }, status: { in: ["in_progress", "open"] } },
              { workflowId: null, projectId: { notIn: ["p-1", "p-2"] }, status: { in: ["in_progress", "open"] } },
            ],
          },
        ],
      });
    });
  });

  describe("search (?q=)", () => {
    it("translates ?q=foo into an OR across title/description/externalRef/labels (no id branch)", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks?q=foo");
      const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
      expect(where.OR).toEqual([
        { title: { contains: "foo", mode: "insensitive" } },
        { description: { contains: "foo", mode: "insensitive" } },
        { externalRef: { contains: "foo", mode: "insensitive" } },
        { labels: { has: "foo" } },
      ]);
    });

    it("a full UUID query adds an id-startsWith clause, additive to the text OR", async () => {
      const uuid = "8f30a6f3-1234-4abc-9def-000000000000";
      await makeApp(HUMAN).request(`/teams/team-A/tasks?q=${uuid}`);
      const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
      expect(where.OR).toEqual([
        { title: { contains: uuid, mode: "insensitive" } },
        { description: { contains: uuid, mode: "insensitive" } },
        { externalRef: { contains: uuid, mode: "insensitive" } },
        { labels: { has: uuid } },
        { id: { startsWith: uuid, mode: "insensitive" } },
      ]);
    });

    it("an 8-char hex prefix (the short id shown in the UI) adds the id-startsWith clause", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks?q=8f30a6f3");
      const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
      expect(where.OR).toContainEqual({ id: { startsWith: "8f30a6f3", mode: "insensitive" } });
    });

    it("id matching is case-insensitive (uppercase hex fragment still adds the id clause)", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks?q=DEADBEEF");
      const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
      expect(where.OR).toContainEqual({ id: { startsWith: "DEADBEEF", mode: "insensitive" } });
    });

    it("a hex-shaped query under the 4-char minimum does NOT add the id clause", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks?q=dea");
      const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
      expect(where.OR).toEqual([
        { title: { contains: "dea", mode: "insensitive" } },
        { description: { contains: "dea", mode: "insensitive" } },
        { externalRef: { contains: "dea", mode: "insensitive" } },
        { labels: { has: "dea" } },
      ]);
    });

    it("a non-hex text query (e.g. a title search) does NOT add the id clause; title search is unaffected", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks?q=onboarding%20flow");
      const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
      expect(where.OR).toEqual([
        { title: { contains: "onboarding flow", mode: "insensitive" } },
        { description: { contains: "onboarding flow", mode: "insensitive" } },
        { externalRef: { contains: "onboarding flow", mode: "insensitive" } },
        { labels: { has: "onboarding flow" } },
      ]);
    });

    // Copy-paste round-trip: the short-id chip (frontend tasks/page.tsx,
    // dashboard/TaskListView.tsx) renders a trailing ellipsis. Depending on
    // the browser, selecting/copying the chip can carry that ellipsis into
    // the clipboard even though it's meant to be presentational-only (CSS
    // ::after, globals.css); the id-prefix branch normalizes it away via
    // normalizeIdQuery so a pasted "8f30a6f3…" still finds the task. The
    // text-search clauses keep the raw query — normalization only applies
    // to the id branch.
    it("a trailing copy-paste unicode ellipsis is stripped before the id-prefix gate check", async () => {
      const raw = "8f30a6f3…";
      await makeApp(HUMAN).request(`/teams/team-A/tasks?q=${encodeURIComponent(raw)}`);
      const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
      expect(where.OR).toEqual([
        { title: { contains: raw, mode: "insensitive" } },
        { description: { contains: raw, mode: "insensitive" } },
        { externalRef: { contains: raw, mode: "insensitive" } },
        { labels: { has: raw } },
        { id: { startsWith: "8f30a6f3", mode: "insensitive" } },
      ]);
    });

    it("a trailing ASCII ellipsis ('...') is stripped before the id-prefix gate check", async () => {
      await makeApp(HUMAN).request(`/teams/team-A/tasks?q=${encodeURIComponent("8f30a6f3...")}`);
      const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where;
      expect(where.OR).toContainEqual({ id: { startsWith: "8f30a6f3", mode: "insensitive" } });
    });
  });

  describe("ID_FRAGMENT_GATE / normalizeIdQuery (id-prefix search helpers)", () => {
    // Pins the exact regex source so an accidental edit here is caught by a
    // failing assertion rather than a silent drift. Cross-reference: this
    // regex is mirrored in frontend/src/lib/taskDisplay.ts's
    // ID_FRAGMENT_GATE — if you change one, change the other and update
    // both pinned strings.
    it("pins the regex source — keep in sync with frontend/src/lib/taskDisplay.ts's ID_FRAGMENT_GATE", () => {
      expect(String(ID_FRAGMENT_GATE)).toBe("/^[0-9a-f][0-9a-f-]{3,35}$/i");
    });

    it("requires a leading hex digit — a leading dash is rejected", () => {
      expect(ID_FRAGMENT_GATE.test("-8f30a6f3")).toBe(false);
    });

    it("caps the length at 36 (a full UUID fits; longer does not)", () => {
      expect(ID_FRAGMENT_GATE.test("8f30a6f3-1234-4abc-9def-000000000000")).toBe(true); // 36 chars
      expect(ID_FRAGMENT_GATE.test("8f30a6f3-1234-4abc-9def-0000000000000")).toBe(false); // 37 chars
    });

    it("normalizeIdQuery strips a trailing unicode or ASCII ellipsis", () => {
      expect(normalizeIdQuery("8f30a6f3…")).toBe("8f30a6f3");
      expect(normalizeIdQuery("8f30a6f3...")).toBe("8f30a6f3");
    });

    it("normalizeIdQuery leaves an already-clean hex/dash query untouched", () => {
      expect(normalizeIdQuery("8f30a6f3-1234-4abc-9def-000000000000")).toBe(
        "8f30a6f3-1234-4abc-9def-000000000000",
      );
    });
  });

  describe("done recency filter + pagination", () => {
    it("recency=recent adds an updatedAt lower bound to the row query", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks?recency=recent");
      const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where as {
        updatedAt?: { gte?: Date; lt?: Date };
      };
      expect(where.updatedAt?.gte).toBeInstanceOf(Date);
      expect(where.updatedAt?.lt).toBeUndefined();
    });

    it("recency=older adds an updatedAt upper bound to the row query", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks?recency=older");
      const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where as {
        updatedAt?: { gte?: Date; lt?: Date };
      };
      expect(where.updatedAt?.lt).toBeInstanceOf(Date);
      expect(where.updatedAt?.gte).toBeUndefined();
    });

    it("recency=all (or absent) applies no updatedAt boundary", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks?recency=all");
      const where = prismaMocks.taskFindMany.mock.calls[0]![0]!.where as {
        updatedAt?: unknown;
      };
      expect(where.updatedAt).toBeUndefined();
    });

    it("?offset=N becomes the findMany skip for server-side paging", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks?offset=50");
      expect(prismaMocks.taskFindMany.mock.calls[0]![0]!.skip).toBe(50);
    });

    it("?sort=title:asc maps to an orderBy on the column", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks?sort=title:asc");
      expect(prismaMocks.taskFindMany.mock.calls[0]![0]!.orderBy).toEqual({ title: "asc" });
    });

    it("?sort=project:asc maps to an orderBy on the related project name", async () => {
      await makeApp(HUMAN).request("/teams/team-A/tasks?sort=project:asc");
      expect(prismaMocks.taskFindMany.mock.calls[0]![0]!.orderBy).toEqual({ project: { name: "asc" } });
    });

    it("returns filteredTotal and the doneRecent/doneOlder split", async () => {
      const res = await makeApp(HUMAN).request("/teams/team-A/tasks");
      const body = (await res.json()) as {
        filteredTotal: number;
        counts: { doneRecent: number; doneOlder: number; done: number };
      };
      expect(body.filteredTotal).toBe(2); // first count() in the beforeEach stack
      expect(body.counts.doneRecent).toBe(100);
      expect(body.counts.doneOlder).toBe(678);
    });
  });
});
