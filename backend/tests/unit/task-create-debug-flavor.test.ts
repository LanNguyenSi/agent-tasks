/**
 * Route tests for the explicit `debugFlavor` opt-in/out flag on task create.
 *
 * Covers POST /projects/:projectId/tasks and the batch import endpoint.
 * Mirrors the setup of task-create-depends-on.test.ts (hoisted Prisma mocks,
 * injected actor via pre-middleware) and avoids `mockResolvedValueOnce`
 * queues per the project memory on the vitest mock-queue leak.
 *
 * The flag is create-time only: when provided it is persisted straight into
 * `metadata.debugFlavor`, which `deriveDebugFlavor` at task_pickup treats as
 * authoritative (skipping the title/label heuristic). When omitted, no
 * metadata is written and the heuristic runs lazily at pickup as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

const prismaMocks = vi.hoisted(() => ({
  taskCreate: vi.fn(),
  taskFindMany: vi.fn(),
  taskFindUnique: vi.fn(),
  // scorer-v2 T4: the create handler reads the project's confidenceThreshold +
  // taskTemplate to attach a create-time confidence object to the response.
  projectFindUnique: vi.fn().mockResolvedValue({ confidenceThreshold: 60, taskTemplate: null }),
  agentTokenFindUnique: vi.fn().mockResolvedValue({ name: "Agent" }),
  userFindUnique: vi.fn().mockResolvedValue({ name: "Human" }),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      create: prismaMocks.taskCreate,
      findMany: prismaMocks.taskFindMany,
      findUnique: prismaMocks.taskFindUnique,
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    project: { findUnique: prismaMocks.projectFindUnique },
    signal: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    workflow: { findFirst: vi.fn() },
    agentToken: { findUnique: prismaMocks.agentTokenFindUnique },
    user: { findUnique: prismaMocks.userFindUnique },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: vi.fn(),
  emitChangesRequestedSignal: vi.fn(),
  emitTaskApprovedSignal: vi.fn(),
}));
vi.mock("../../src/services/task-signal.js", () => ({
  emitTaskAvailableSignal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/force-transition-signal.js", () => ({
  emitForceTransitionedSignal: vi.fn(),
}));
vi.mock("../../src/services/github-merge.js", () => ({ performPrMerge: vi.fn() }));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));

import { taskRouter } from "../../src/routes/tasks.js";

const AGENT: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  scopes: ["tasks:create"],
  userId: "user-1",
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

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  prismaMocks.taskCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "task-new", ...data, attachments: [], artifacts: [], comments: [] }),
  );
});

async function postCreate(body: Record<string, unknown>) {
  return makeApp(AGENT).request(`/projects/${PROJECT_ID}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postImport(tasks: Array<Record<string, unknown>>) {
  return makeApp(AGENT).request(`/projects/${PROJECT_ID}/tasks/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tasks }),
  });
}

describe("POST /projects/:projectId/tasks — debugFlavor", () => {
  it("persists metadata.debugFlavor=true on explicit opt-in", async () => {
    const res = await postCreate({ title: "Add a settings panel", debugFlavor: true });

    expect(res.status).toBe(201);
    const createArg = prismaMocks.taskCreate.mock.calls[0]![0];
    expect(createArg.data.metadata).toEqual({ debugFlavor: true });
  });

  it("persists metadata.debugFlavor=false on explicit opt-out", async () => {
    const res = await postCreate({ title: "Investigate the broken login bug", debugFlavor: false });

    expect(res.status).toBe(201);
    const createArg = prismaMocks.taskCreate.mock.calls[0]![0];
    expect(createArg.data.metadata).toEqual({ debugFlavor: false });
  });

  it("explicit opt-out wins over a title the heuristic would classify as debug", async () => {
    // "bug" + "regression" + "not working" would all trip detectDebugFlavor.
    // The create handler must not run the heuristic — the persisted metadata
    // is exactly the caller's `false`, so pickup never re-classifies.
    const res = await postCreate({
      title: "bug: regression — login not working",
      debugFlavor: false,
    });

    expect(res.status).toBe(201);
    const createArg = prismaMocks.taskCreate.mock.calls[0]![0];
    expect(createArg.data.metadata).toEqual({ debugFlavor: false });
  });

  it("leaves metadata unset when debugFlavor is omitted (heuristic deferred to pickup)", async () => {
    const res = await postCreate({ title: "Investigate the broken login bug" });

    expect(res.status).toBe(201);
    const createArg = prismaMocks.taskCreate.mock.calls[0]![0];
    expect(createArg.data.metadata).toBeUndefined();
  });

  it("rejects a non-boolean debugFlavor via the zod schema", async () => {
    const res = await postCreate({ title: "Bad", debugFlavor: "yes" });

    expect(res.status).toBe(400);
    expect(prismaMocks.taskCreate).not.toHaveBeenCalled();
  });

  it("coexists with templateData and labels without clobbering them", async () => {
    // metadata, templateData and labels are three distinct Prisma columns;
    // assert the debugFlavor spread does not displace the others.
    const res = await postCreate({
      title: "Add a settings panel",
      debugFlavor: true,
      labels: ["feature"],
      templateData: { goal: "Ship the panel" },
    });

    expect(res.status).toBe(201);
    const createArg = prismaMocks.taskCreate.mock.calls[0]![0];
    expect(createArg.data.metadata).toEqual({ debugFlavor: true });
    expect(createArg.data.labels).toEqual(["feature"]);
    expect(createArg.data.templateData).toEqual({ goal: "Ship the panel" });
  });
});

describe("POST /projects/:projectId/tasks — confidence surfacing (scorer-v2 T4)", () => {
  type CreateBody = {
    task: { id: string };
    confidence: {
      score: number;
      threshold: number;
      enforcementMode: string;
      blocking: boolean;
      missing: string[];
      findings: Array<{ code: string; severity: string }>;
      nextActions: string[];
    };
  };

  it("a thin task still creates (201, non-blocking) but the response carries confidence with findings", async () => {
    const res = await postCreate({ title: "Fix the thing" }); // no description, no AC
    expect(res.status).toBe(201); // create is never blocked by a low score
    const body = (await res.json()) as CreateBody;
    expect(body.confidence).toBeDefined();
    expect(body.confidence.threshold).toBe(60);
    expect(body.confidence.score).toBeLessThan(60);
    expect(body.confidence.blocking).toBe(true); // no AC, no verification signal → evals keystone
    // enforcementMode tells the caller whether `blocking` actually rejects at
    // pickup/start; the mock project has no column set, so it resolves to WARN.
    expect(body.confidence.enforcementMode).toBe("WARN");
    expect(body.confidence.missing).toContain("acceptanceCriteria");
    expect(body.confidence.findings.length).toBeGreaterThan(0);
    expect(body.confidence.nextActions.length).toBeGreaterThan(0);
    // The suggestions actually address the gaps (not just a non-empty array):
    // the missing-AC keystone suggestion is surfaced.
    expect(body.confidence.nextActions.join(" ")).toMatch(/completion conditions|acceptance criteria/i);
  });

  it("a fully-specified task scores high with no keystone block and no missing AC", async () => {
    const res = await postCreate({
      title: "Add request-id middleware",
      description: "Add `requestId` in src/middleware/request-id.ts; verify via `curl`; expect 200",
      templateData: {
        goal: "trace requests",
        acceptanceCriteria: "- every response carries x-request-id\n- a test asserts it",
        scope: "src/middleware/request-id.ts",
        outOfScope: "no router change",
        dependencies: "none",
        risk: "low",
        agentPrompt: "1. add the middleware 2. wire it 3. test",
        // constraints lifts the scopeClarity subscore (a T1 cap reads it) so the
        // fully-specified task is not capped by low_scope_clarity.
        constraints: "no new dependencies",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateBody;
    // Comfortable pass under prose-first: a complete task with a concise (not
    // rich) description clears the threshold well; a rich description pushes ~100.
    expect(body.confidence.score).toBeGreaterThanOrEqual(70);
    expect(body.confidence.blocking).toBe(false);
    expect(body.confidence.missing).not.toContain("acceptanceCriteria");
  });

  it("degrades gracefully: a failing project lookup still returns 201 with best-effort confidence", async () => {
    // The task is already persisted; the confidence add-on must never 500 a
    // successful create. A thrown project query degrades to defaults.
    prismaMocks.projectFindUnique.mockRejectedValueOnce(new Error("db unavailable"));
    const res = await postCreate({ title: "Add a settings panel" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateBody;
    expect(body.confidence).toBeDefined();
    expect(body.confidence.threshold).toBe(60); // default fallback when the lookup fails
  });
});

describe("POST /projects/:projectId/tasks/import — debugFlavor", () => {
  it("persists per-item metadata.debugFlavor and leaves it unset when omitted", async () => {
    const res = await postImport([
      { title: "Opt-in item", debugFlavor: true },
      { title: "Opt-out item", debugFlavor: false },
      { title: "Heuristic item" },
    ]);

    expect(res.status).toBe(201);
    expect(prismaMocks.taskCreate).toHaveBeenCalledTimes(3);
    const [first, second, third] = prismaMocks.taskCreate.mock.calls.map((call) => call[0]);
    expect(first.data.metadata).toEqual({ debugFlavor: true });
    expect(second.data.metadata).toEqual({ debugFlavor: false });
    expect(third.data.metadata).toBeUndefined();
  });
});
