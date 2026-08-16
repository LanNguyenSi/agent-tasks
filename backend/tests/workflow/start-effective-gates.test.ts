/**
 * `POST /tasks/:id/start` — effectiveGates + previousStatus (task 656ccbda).
 *
 * Before this change, `/start` resolved the effective workflow definition
 * (ADR-0008 §50-56 resolution chain: task-level workflow → project-default
 * Workflow row → built-in default) only to compute `expectedFinishState`,
 * then threw the resolved definition away. The mcp-server start-receipt
 * (rc-v1-C003) had to GUESS the gates a later `task_finish` would enforce
 * from `workflowId === null`, which is exactly the review finding this
 * fixes: `workflowId === null` does NOT prove the built-in default — a
 * project that ran `POST /projects/:projectId/workflow/customize` gets an
 * editable project-default Workflow row while every task on it keeps
 * `workflowId: null`.
 *
 * This suite exercises all three chain stages against the real
 * `taskRouter` (+ `workflowRouter` for the customize/edit stage), asserting
 * that `effectiveGates.finish` reflects the TRUE effective definition and
 * `previousStatus` carries the pre-transition status, for both claim kinds
 * (`kind: "work"` and `kind: "review"`).
 *
 * Fix-round additions (656ccbda review, commit d0a04fd findings):
 *   - `effectiveGates.finish` is `null`, not `[]`, when the previewed edge
 *     itself does not exist in the effective definition — [] stays reserved
 *     for "edge exists, nothing required" (finding L2).
 *   - The review-claim branch previews BOTH outcomes: `finish` (approve
 *     edge) and `requestChanges` (request_changes edge), since they can
 *     carry different gates under a customized workflow (finding L3).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import {
  defaultWorkflowDefinition,
  type WorkflowDefinitionShape,
} from "../../src/services/default-workflow.js";
import { BYTES_BUDGET, makeProject, measure } from "./fixtures.js";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "22222222-2222-2222-2222-222222222222";

// Hoisted Prisma mocks. Only the collaborators `/tasks/:id/start` and the
// `/workflow/customize` + `PUT /workflows/:id` pair actually touch — see the
// doc comment above for why the mock surface is narrower than the full
// round-trip suite's (fixtures.ts). `taskUpdate` is included (in addition to
// `taskUpdateMany`) for the finding-L6 round-trip test, which drives
// `/tasks/:id/finish` — that route writes via `prisma.task.update`, not
// `updateMany`.
const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskFindFirst: vi.fn().mockResolvedValue(null),
  taskFindMany: vi.fn().mockResolvedValue([]),
  taskUpdateMany: vi.fn(),
  taskUpdate: vi.fn(),
  workflowFindFirst: vi.fn(),
  workflowFindUnique: vi.fn(),
  workflowCreate: vi.fn(),
  workflowUpdate: vi.fn(),
  workflowUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  projectFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
      findFirst: prismaMocks.taskFindFirst,
      findMany: prismaMocks.taskFindMany,
      updateMany: prismaMocks.taskUpdateMany,
      update: prismaMocks.taskUpdate,
    },
    workflow: {
      findFirst: prismaMocks.workflowFindFirst,
      findUnique: prismaMocks.workflowFindUnique,
      create: prismaMocks.workflowCreate,
      update: prismaMocks.workflowUpdate,
      updateMany: prismaMocks.workflowUpdateMany,
    },
    project: { findUnique: prismaMocks.projectFindUnique },
    $transaction: prismaMocks.transaction,
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

// Only exercised by the finding-L6 round-trip test below, which finishes a
// work-claim into a review target — `/tasks/:id/finish` fires this signal
// (fire-and-forget) once the task lands in a review state. Mocked at the
// module level (rather than per-test) because the real implementation reads
// `prisma.agentToken`/`prisma.teamMember`, which this suite's narrow Prisma
// mock does not stub — leaving it unmocked would throw inside the
// unawaited call.
vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: vi.fn().mockResolvedValue([]),
  emitChangesRequestedSignal: vi.fn().mockResolvedValue(undefined),
  emitTaskApprovedSignal: vi.fn().mockResolvedValue(undefined),
}));

import { taskRouter } from "../../src/routes/tasks.js";
import { workflowRouter } from "../../src/routes/workflows.js";

const AGENT: Actor = {
  type: "agent",
  tokenId: "agent-reviewer",
  teamId: "team-1",
  userId: "user-agent",
  scopes: ["tasks:read", "tasks:claim", "tasks:transition"],
};

const HUMAN_ADMIN: Actor = {
  type: "human",
  userId: "human-admin",
  teamId: "team-1",
  role: "ADMIN",
};

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  app.route("/", workflowRouter);
  return app;
}

// soloMode: true + confidenceThreshold: 0 disable the distinct-reviewer and
// confidence gates — this suite is about effectiveGates/previousStatus, not
// those (already covered by their own dedicated suites).
const project = makeProject({ id: PROJECT_ID, confidenceThreshold: 0 });

/** Base task row shaped like the `taskInclude` + `workflow: true` include
 * `/tasks/:id/start` fetches. Title/description are deliberately free of
 * `detectDebugFlavor` keywords so the grounding path stays inert. */
function baseTaskRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-16T00:00:00Z");
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    workflowId: null,
    workflow: null,
    title: "Ship the effective-gates response field",
    description: "Fixture task for the effectiveGates/previousStatus round-trip.",
    status: "open",
    priority: "MEDIUM",
    labels: [],
    claimedByUserId: null,
    claimedByAgentId: null,
    claimedAt: null,
    reviewClaimedByUserId: null,
    reviewClaimedByAgentId: null,
    reviewClaimedAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    metadata: null,
    externalRef: null,
    result: null,
    autoMergeSha: null,
    deliverableRepo: null,
    dueAt: null,
    createdAt: now,
    updatedAt: now,
    createdByUserId: null,
    createdByAgentId: "agent-author",
    templateData: null,
    project,
    attachments: [],
    artifacts: [],
    comments: [],
    blockedBy: [],
    blocks: [],
    claimedByUser: null,
    claimedByAgent: null,
    reviewClaimedByUser: null,
    reviewClaimedByAgent: null,
    ...overrides,
  };
}

/**
 * Wires `taskFindUnique` / `taskUpdateMany` / `taskUpdate` against a single
 * mutable task row, mirroring the atomic-CAS shim the round-trip fixtures
 * use — generalised here to cover both the work-claim (`claimedBy*`) and
 * review-claim (`reviewClaimedBy*`) CAS guards `/tasks/:id/start` issues,
 * plus the plain (non-CAS) `prisma.task.update` write `/tasks/:id/finish`
 * issues (finding-L6 round-trip test).
 */
function wireTask(initial: Record<string, unknown>) {
  const box = { current: initial };
  prismaMocks.taskFindUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id !== box.current.id) return Promise.resolve(null);
      return Promise.resolve(box.current);
    },
  );
  prismaMocks.taskUpdateMany.mockImplementation(
    ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (where.id !== box.current.id) return Promise.resolve({ count: 0 });
      if (
        "claimedByAgentId" in where &&
        where.claimedByAgentId === null &&
        (box.current.claimedByAgentId !== null || box.current.claimedByUserId !== null)
      ) {
        return Promise.resolve({ count: 0 });
      }
      if (
        "reviewClaimedByAgentId" in where &&
        where.reviewClaimedByAgentId === null &&
        (box.current.reviewClaimedByAgentId !== null || box.current.reviewClaimedByUserId !== null)
      ) {
        return Promise.resolve({ count: 0 });
      }
      box.current = { ...box.current, ...data, updatedAt: new Date() };
      return Promise.resolve({ count: 1 });
    },
  );
  prismaMocks.taskUpdate.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      if (where.id !== box.current.id) return Promise.reject(new Error("task not found"));
      box.current = { ...box.current, ...data, updatedAt: new Date() };
      return Promise.resolve(box.current);
    },
  );
  return box;
}

/** The built-in default with a single edge's `requires` swapped out, so a
 * fixture can be asserted as clearly distinct from the built-in gate list. */
function defWithRequires(from: string, to: string, requires: string[]): WorkflowDefinitionShape {
  const base = defaultWorkflowDefinition();
  return {
    ...base,
    transitions: base.transitions.map((t) =>
      t.from === from && t.to === to ? { ...t, requires } : t,
    ),
  };
}

/** Like `defWithRequires` but edits several edges in one call, so a fixture
 * can give the approve and request_changes edges DIFFERENT requires in the
 * same definition (finding L3: the two review-claim preview keys need to be
 * distinguishable). */
function defWithMultiRequires(
  edits: ReadonlyArray<{ from: string; to: string; requires: string[] }>,
): WorkflowDefinitionShape {
  const base = defaultWorkflowDefinition();
  return {
    ...base,
    transitions: base.transitions.map((t) => {
      const edit = edits.find((e) => e.from === t.from && e.to === t.to);
      return edit ? { ...t, requires: edit.requires } : t;
    }),
  };
}

/** The built-in default with one transition edge REMOVED entirely — a
 * "persistable" definition (workflowDefinitionSchema does not require graph
 * connectivity) that keeps `review → done` while dropping
 * `in_progress → review` (finding L2's exact repro shape). */
function defWithoutTransition(from: string, to: string): WorkflowDefinitionShape {
  const base = defaultWorkflowDefinition();
  return {
    ...base,
    transitions: base.transitions.filter((t) => !(t.from === from && t.to === to)),
  };
}

describe("POST /tasks/:id/start — effectiveGates + previousStatus (task 656ccbda)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.taskFindFirst.mockResolvedValue(null);
    prismaMocks.taskFindMany.mockResolvedValue([]);
    prismaMocks.workflowUpdateMany.mockResolvedValue({ count: 0 });
  });

  // ── Work-claim branch: all three ADR-0008 chain stages ──────────────────

  describe("work-claim (kind: \"work\")", () => {
    it("stage 1/3 — built-in default (no task workflowId, no project-default row)", async () => {
      prismaMocks.workflowFindFirst.mockResolvedValue(null);
      const box = wireTask(baseTaskRow());

      const res = await measure<{
        kind: string;
        previousStatus: string;
        effectiveGates: { finish: string[] | null };
      }>(
        makeApp(AGENT).request(`/tasks/${TASK_ID}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("work");
      expect(res.body.previousStatus).toBe("open");
      // Default workflow's in_progress → review edge.
      expect(res.body.effectiveGates).toEqual({ finish: ["branchPresent", "prPresent"] });
      expect(box.current.status).toBe("in_progress");
      expect(res.byteLength).toBeLessThan(BYTES_BUDGET.taskStart);
    });

    it("stage 2/3 — project-default via /workflow/customize + edit: reflects the EDITED gates, not the built-in ones", async () => {
      // Reproduces the review finding directly: the task keeps
      // workflowId: null throughout. Only the project-default Workflow row
      // (forked by customize, then edited) changes.
      let projectDefaultWorkflow: {
        id: string;
        projectId: string;
        name: string;
        isDefault: boolean;
        definition: WorkflowDefinitionShape;
      } | null = null;

      prismaMocks.projectFindUnique.mockResolvedValue({ id: PROJECT_ID });
      prismaMocks.transaction.mockImplementation(
        (cb: (tx: { workflow: { findFirst: typeof prismaMocks.workflowFindFirst; create: typeof prismaMocks.workflowCreate } }) => unknown) =>
          cb({
            workflow: { findFirst: prismaMocks.workflowFindFirst, create: prismaMocks.workflowCreate },
          }),
      );
      prismaMocks.workflowFindFirst.mockImplementation(() => Promise.resolve(projectDefaultWorkflow));
      prismaMocks.workflowCreate.mockImplementation(
        ({ data }: { data: { name: string; isDefault: boolean; definition: WorkflowDefinitionShape } }) => {
          projectDefaultWorkflow = {
            id: "wf-project-default",
            projectId: PROJECT_ID,
            name: data.name,
            isDefault: data.isDefault,
            definition: data.definition,
          };
          return Promise.resolve(projectDefaultWorkflow);
        },
      );
      prismaMocks.workflowFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          projectDefaultWorkflow && projectDefaultWorkflow.id === where.id ? projectDefaultWorkflow : null,
        ),
      );
      prismaMocks.workflowUpdate.mockImplementation(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (!projectDefaultWorkflow || projectDefaultWorkflow.id !== where.id) {
            throw new Error("workflow not found");
          }
          projectDefaultWorkflow = { ...projectDefaultWorkflow, ...data } as typeof projectDefaultWorkflow;
          return Promise.resolve(projectDefaultWorkflow);
        },
      );

      // 1. Fork the default into a project-customized workflow.
      const customizeRes = await measure<{ workflowId: string }>(
        makeApp(HUMAN_ADMIN).request(`/projects/${PROJECT_ID}/workflow/customize`, { method: "POST" }),
      );
      expect(customizeRes.status).toBe(201);
      const workflowId = customizeRes.body.workflowId;

      // 2. Edit the customized default so its gates DIFFER from the
      // built-in ones (branchPresent+prPresent → ciGreen).
      const edited = defWithRequires("in_progress", "review", ["ciGreen"]);
      const putRes = await makeApp(HUMAN_ADMIN).request(`/workflows/${workflowId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition: edited }),
      });
      expect(putRes.status).toBe(200);

      // 3. The task still carries workflowId: null — the pre-fix consumer
      // would have no way to tell this apart from the built-in default.
      const box = wireTask(baseTaskRow());

      const res = await measure<{
        previousStatus: string;
        effectiveGates: { finish: string[] | null };
      }>(
        makeApp(AGENT).request(`/tasks/${TASK_ID}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.previousStatus).toBe("open");
      expect(res.body.effectiveGates).toEqual({ finish: ["ciGreen"] });
      expect(box.current.status).toBe("in_progress");
      expect(res.byteLength).toBeLessThan(BYTES_BUDGET.taskStart);
    });

    it("stage 3/3 — task-level workflow wins over an existing (different) project-default row", async () => {
      const taskLevelDef = defWithRequires("in_progress", "review", ["prMerged"]);
      // A project-default row also exists with the UNedited built-in gates.
      // If resolveEffectiveDefinition ever regressed to consult it despite
      // task.workflowId being set, this would leak through.
      prismaMocks.workflowFindFirst.mockResolvedValue({
        id: "wf-project-default-should-be-ignored",
        definition: defaultWorkflowDefinition(),
      });

      const box = wireTask(
        baseTaskRow({
          workflowId: "wf-task-level",
          workflow: { id: "wf-task-level", definition: taskLevelDef },
        }),
      );
      prismaMocks.workflowFindFirst.mockClear();

      const res = await measure<{
        previousStatus: string;
        effectiveGates: { finish: string[] | null };
      }>(
        makeApp(AGENT).request(`/tasks/${TASK_ID}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.previousStatus).toBe("open");
      expect(res.body.effectiveGates).toEqual({ finish: ["prMerged"] });
      // Task-level short-circuits resolveEffectiveDefinition before it ever
      // queries the project-default row.
      expect(prismaMocks.workflowFindFirst).not.toHaveBeenCalled();
      expect(box.current.status).toBe("in_progress");
      expect(res.byteLength).toBeLessThan(BYTES_BUDGET.taskStart);
    });

    it("missing-edge definition (in_progress → review dropped, review → done kept): effectiveGates.finish is null, not []", async () => {
      // Finding L2 repro: workflowDefinitionSchema does not require graph
      // connectivity, so this definition is persistable. expectedFinishState
      // still resolves to "review" — isReviewState is a structural check
      // (outgoing edge to a terminal state, not a direct target of the
      // initial state) that never inspects incoming edges — even though the
      // in_progress → review edge itself is gone. A caller trusting
      // `finish: []` here would wrongly conclude "nothing required" instead
      // of "this edge doesn't exist; /finish will 400 with no_transition".
      const defMissingEdge = defWithoutTransition("in_progress", "review");
      const box = wireTask(
        baseTaskRow({
          workflowId: "wf-task-level-missing-edge",
          workflow: { id: "wf-task-level-missing-edge", definition: defMissingEdge },
        }),
      );

      const res = await measure<{
        previousStatus: string;
        expectedFinishState: string;
        effectiveGates: { finish: string[] | null };
      }>(
        makeApp(AGENT).request(`/tasks/${TASK_ID}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.previousStatus).toBe("open");
      expect(res.body.expectedFinishState).toBe("review");
      expect(res.body.effectiveGates).toEqual({ finish: null });
      expect(box.current.status).toBe("in_progress");
      expect(res.byteLength).toBeLessThan(BYTES_BUDGET.taskStart);
    });
  });

  // ── Review-claim branch: field presence + non-default gate resolution ───

  describe("review-claim (kind: \"review\")", () => {
    it("customized definition with non-empty review→done requires: previousStatus stays 'review' (no status transition), effectiveGates.finish from the approve edge", async () => {
      // Deliberately NOT the built-in default (which has no requires on
      // review → done): a `gatesForTransition → []` mutant would slip past a
      // built-in-default-only assertion here undetected (finding L5) since
      // the real answer and the mutant's answer coincide. The paired "really
      // is gate-free" test below covers the true built-in-default behavior.
      const def = defWithRequires("review", "done", ["ciGreen"]);
      const box = wireTask(
        baseTaskRow({
          status: "review",
          claimedByAgentId: "agent-author-other",
          workflowId: "wf-task-level-review-gate",
          workflow: { id: "wf-task-level-review-gate", definition: def },
        }),
      );

      const res = await measure<{
        kind: string;
        previousStatus: string;
        effectiveGates: { finish: string[] | null; requestChanges: string[] | null };
      }>(
        makeApp(AGENT).request(`/tasks/${TASK_ID}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("review");
      expect(res.body.previousStatus).toBe("review");
      // review → in_progress (request_changes edge) is untouched by
      // defWithRequires, so it stays gate-free ([]) in this fixture.
      expect(res.body.effectiveGates).toEqual({ finish: ["ciGreen"], requestChanges: [] });
      expect(box.current.reviewClaimedByAgentId).toBe(AGENT.tokenId);
      expect(res.byteLength).toBeLessThan(BYTES_BUDGET.taskStart);
    });

    it("built-in default's approve edge (review → done) really is gate-free", async () => {
      prismaMocks.workflowFindFirst.mockResolvedValue(null);
      wireTask(baseTaskRow({ status: "review", claimedByAgentId: "agent-author-other" }));

      const res = await measure<{
        effectiveGates: { finish: string[] | null; requestChanges: string[] | null };
      }>(
        makeApp(AGENT).request(`/tasks/${TASK_ID}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.effectiveGates).toEqual({ finish: [], requestChanges: [] });
      expect(res.byteLength).toBeLessThan(BYTES_BUDGET.taskStart);
    });

    it("task-level workflow: approve-edge gates reflect the task-level definition, not the built-in no-gate default", async () => {
      const taskLevelDef = defWithRequires("review", "done", ["prMerged"]);
      prismaMocks.workflowFindFirst.mockResolvedValue({
        id: "wf-project-default-should-be-ignored",
        definition: defaultWorkflowDefinition(),
      });

      wireTask(
        baseTaskRow({
          status: "review",
          claimedByAgentId: "agent-author-other",
          workflowId: "wf-task-level-2",
          workflow: { id: "wf-task-level-2", definition: taskLevelDef },
        }),
      );
      prismaMocks.workflowFindFirst.mockClear();

      const res = await measure<{
        previousStatus: string;
        effectiveGates: { finish: string[] | null; requestChanges: string[] | null };
      }>(
        makeApp(AGENT).request(`/tasks/${TASK_ID}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.previousStatus).toBe("review");
      expect(res.body.effectiveGates).toEqual({ finish: ["prMerged"], requestChanges: [] });
      expect(prismaMocks.workflowFindFirst).not.toHaveBeenCalled();
      expect(res.byteLength).toBeLessThan(BYTES_BUDGET.taskStart);
    });

    it("polymorphic outcomes: finish (approve edge) and requestChanges (request_changes edge) preview DIFFERENT gates when the two edges' requires differ", async () => {
      // Finding L3 repro: the review-claim finish is polymorphic on
      // `outcome`, so a single `finish` key can only ever preview one of the
      // two edges task_finish might actually hit. This definition gives the
      // approve and request_changes edges non-overlapping requires so the
      // two response keys are distinguishable, not just both non-empty.
      const def = defWithMultiRequires([
        { from: "review", to: "done", requires: ["prMerged"] },
        { from: "review", to: "in_progress", requires: ["ciGreen"] },
      ]);
      wireTask(
        baseTaskRow({
          status: "review",
          claimedByAgentId: "agent-author-other",
          workflowId: "wf-task-level-polymorphic",
          workflow: { id: "wf-task-level-polymorphic", definition: def },
        }),
      );

      const res = await measure<{
        effectiveGates: { finish: string[] | null; requestChanges: string[] | null };
      }>(
        makeApp(AGENT).request(`/tasks/${TASK_ID}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.effectiveGates).toEqual({
        finish: ["prMerged"],
        requestChanges: ["ciGreen"],
      });
      expect(res.byteLength).toBeLessThan(BYTES_BUDGET.taskStart);
    });
  });

  // ── Round-trip: the preview is what finish actually enforces (finding L6) ─

  describe("round-trip: /start preview matches /finish enforcement", () => {
    it("drives /start then /finish on the SAME customized workflow: finish succeeds on exactly the previewed gates, no gate the preview omitted blocks it", async () => {
      prismaMocks.workflowFindFirst.mockResolvedValue(null);
      // Customized edge: in_progress → review requires ONLY prPresent. The
      // built-in default additionally requires branchPresent — leaving
      // branchName unset below and still getting a 200 proves finish
      // enforced THIS edge, not the built-in one.
      const def = defWithRequires("in_progress", "review", ["prPresent"]);
      const box = wireTask(
        baseTaskRow({
          workflowId: "wf-task-level-roundtrip",
          workflow: { id: "wf-task-level-roundtrip", definition: def },
        }),
      );

      const startRes = await measure<{
        effectiveGates: { finish: string[] | null };
      }>(
        makeApp(AGENT).request(`/tasks/${TASK_ID}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      expect(startRes.status).toBe(200);
      expect(startRes.body.effectiveGates).toEqual({ finish: ["prPresent"] });
      expect(box.current.status).toBe("in_progress");
      expect(box.current.claimedByAgentId).toBe(AGENT.tokenId);

      // Satisfy exactly the previewed gate (prPresent, via prUrl) and
      // deliberately leave branchName unset.
      const finishRes = await measure<{
        kind: string;
        targetStatus: string;
      }>(
        makeApp(AGENT).request(`/tasks/${TASK_ID}/finish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prUrl: `https://github.com/${project.githubRepo}/pull/7`,
          }),
        }),
      );

      // Neither a 400 (no_transition — the edge is right there) nor a 422
      // (precondition_failed — e.g. on branchPresent, which the preview
      // correctly omitted).
      expect(finishRes.status).toBe(200);
      expect(finishRes.body.targetStatus).toBe("review");
      expect(box.current.status).toBe("review");
    });
  });
});
