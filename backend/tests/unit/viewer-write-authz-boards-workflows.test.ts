/**
 * Regression tests pinning the authz gates on board and workflow WRITE handlers.
 *
 * Audit findings H1+H2 (2026-06-10): POST /projects/:id/boards,
 * PUT /boards/:id, and POST /projects/:id/workflows used to gate on bare
 * `hasProjectAccess`, which admits PROJECT_VIEWER (read-only). These tests
 * ensure:
 *  - a PROJECT_VIEWER actor is denied (403) on each write handler
 *  - a PROJECT_CONTRIBUTOR/PROJECT_ADMIN actor is NOT denied (negative control)
 *
 * For workflow-create the gate is now `isProjectAdmin` (matching customize,
 * apply-template, update, reset), so PROJECT_CONTRIBUTOR is also correctly
 * denied; the negative control uses PROJECT_ADMIN only.
 *
 * Implementation: mock `requireProjectWrite` / `isProjectAdmin` return values
 * to simulate each role tier, then drive the real route handler via a
 * throw-away Hono app (same pattern as tasks-v2-routes.test.ts and
 * task-merge-route.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

// ── Prisma mocks ──────────────────────────────────────────────────────────────

const prismaMocks = vi.hoisted(() => ({
  boardCreate: vi.fn(),
  boardFindUnique: vi.fn(),
  boardUpdate: vi.fn(),
  taskFindMany: vi.fn(),
  workflowCreate: vi.fn(),
  workflowFindFirst: vi.fn(),
  workflowUpdateMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    board: {
      create: prismaMocks.boardCreate,
      findUnique: prismaMocks.boardFindUnique,
      update: prismaMocks.boardUpdate,
    },
    task: {
      findMany: prismaMocks.taskFindMany,
    },
    workflow: {
      create: prismaMocks.workflowCreate,
      findFirst: prismaMocks.workflowFindFirst,
      updateMany: prismaMocks.workflowUpdateMany,
    },
  },
}));

// ── Team-access gate mocks ────────────────────────────────────────────────────

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn(),
  requireProjectWrite: vi.fn(),
  isProjectAdmin: vi.fn(),
}));

vi.mock("../../src/services/team-access.js", () => accessMocks);

// ── Audit mock (boards.ts does not call audit; workflows.ts does) ─────────────

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// ── Import routers AFTER mocks are registered ─────────────────────────────────

import { boardRouter } from "../../src/routes/boards.js";
import { workflowRouter } from "../../src/routes/workflows.js";

// ── Actors ────────────────────────────────────────────────────────────────────

const viewerActor: Actor = { type: "human", userId: "viewer-user" };
const contributorActor: Actor = { type: "human", userId: "contributor-user" };
const adminActor: Actor = { type: "human", userId: "admin-user" };

// ── App factories ─────────────────────────────────────────────────────────────

function makeBoardApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", boardRouter);
  return app;
}

function makeWorkflowApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", workflowRouter);
  return app;
}

// ── Request bodies ────────────────────────────────────────────────────────────

const validBoardBody = {
  name: "Test Board",
  config: {
    columns: [{ id: "col-open", label: "Open", status: "open" }],
    groupBy: "none" as const,
    filters: [],
  },
};

// Full workflow definition satisfying the fixed-state-vocabulary constraint.
const validWorkflowBody = {
  name: "Test Workflow",
  isDefault: false,
  definition: {
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "in_progress", label: "In Progress", terminal: false },
      { name: "review", label: "Review", terminal: false },
      { name: "done", label: "Done", terminal: true },
    ],
    transitions: [],
    initialState: "open",
  },
};

// ── DB fixtures for success-path tests ────────────────────────────────────────

const baseBoardRow = {
  id: "board-1",
  projectId: "proj-1",
  name: "Test Board",
  config: validBoardBody.config,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseWorkflowRow = {
  id: "wf-1",
  projectId: "proj-1",
  name: "Test Workflow",
  isDefault: false,
  definition: validWorkflowBody.definition,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── Global beforeEach ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default all gates to OPEN and DB calls to succeed; individual tests
  // override gates to simulate a specific role tier.
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(true);

  prismaMocks.boardCreate.mockResolvedValue(baseBoardRow);
  prismaMocks.boardFindUnique.mockResolvedValue(baseBoardRow);
  prismaMocks.boardUpdate.mockResolvedValue(baseBoardRow);
  prismaMocks.taskFindMany.mockResolvedValue([]);
  prismaMocks.workflowCreate.mockResolvedValue(baseWorkflowRow);
  prismaMocks.workflowFindFirst.mockResolvedValue(null);
  prismaMocks.workflowUpdateMany.mockResolvedValue({ count: 0 });
});

// ── Board CREATE ──────────────────────────────────────────────────────────────

describe("POST /projects/:projectId/boards (board create)", () => {
  it("denies a PROJECT_VIEWER with 403 (regression H1)", async () => {
    accessMocks.requireProjectWrite.mockResolvedValue(false);

    const res = await makeBoardApp(viewerActor).request("/projects/proj-1/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBoardBody),
    });

    expect(res.status).toBe(403);
    // Gate fired before DB — board must not have been created.
    expect(prismaMocks.boardCreate).not.toHaveBeenCalled();
  });

  it("admits a PROJECT_CONTRIBUTOR (requireProjectWrite → true, not 403)", async () => {
    accessMocks.requireProjectWrite.mockResolvedValue(true);

    const res = await makeBoardApp(contributorActor).request("/projects/proj-1/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBoardBody),
    });

    expect(res.status).not.toBe(403);
    expect(prismaMocks.boardCreate).toHaveBeenCalled();
  });

  it("admits a PROJECT_ADMIN (requireProjectWrite → true, not 403)", async () => {
    accessMocks.requireProjectWrite.mockResolvedValue(true);

    const res = await makeBoardApp(adminActor).request("/projects/proj-1/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBoardBody),
    });

    expect(res.status).not.toBe(403);
    expect(prismaMocks.boardCreate).toHaveBeenCalled();
  });
});

// ── Board UPDATE ──────────────────────────────────────────────────────────────

describe("PUT /boards/:id (board update config)", () => {
  it("denies a PROJECT_VIEWER with 403 (regression H2)", async () => {
    accessMocks.requireProjectWrite.mockResolvedValue(false);

    const res = await makeBoardApp(viewerActor).request("/boards/board-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });

    expect(res.status).toBe(403);
    expect(prismaMocks.boardUpdate).not.toHaveBeenCalled();
  });

  it("admits a PROJECT_CONTRIBUTOR (requireProjectWrite → true, not 403)", async () => {
    accessMocks.requireProjectWrite.mockResolvedValue(true);

    const res = await makeBoardApp(contributorActor).request("/boards/board-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });

    expect(res.status).not.toBe(403);
    expect(prismaMocks.boardUpdate).toHaveBeenCalled();
  });

  it("admits a PROJECT_ADMIN (requireProjectWrite → true, not 403)", async () => {
    accessMocks.requireProjectWrite.mockResolvedValue(true);

    const res = await makeBoardApp(adminActor).request("/boards/board-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });

    expect(res.status).not.toBe(403);
    expect(prismaMocks.boardUpdate).toHaveBeenCalled();
  });
});

// ── Workflow CREATE ───────────────────────────────────────────────────────────

describe("POST /projects/:projectId/workflows (workflow create)", () => {
  it("denies a PROJECT_VIEWER with 403 (regression H1+H2)", async () => {
    accessMocks.isProjectAdmin.mockResolvedValue(false);

    const res = await makeWorkflowApp(viewerActor).request("/projects/proj-1/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validWorkflowBody),
    });

    expect(res.status).toBe(403);
    expect(prismaMocks.workflowCreate).not.toHaveBeenCalled();
  });

  it("denies a PROJECT_CONTRIBUTOR with 403 (create is admin-tier gate)", async () => {
    // isProjectAdmin returns false for PROJECT_CONTRIBUTOR, same as for VIEWER.
    // Gating create at admin tier is intentional: create can set isDefault:true,
    // which unsets the existing default and drives every task transition's
    // requiredRole. This must be consistently admin-tier with update/reset.
    accessMocks.isProjectAdmin.mockResolvedValue(false);

    const res = await makeWorkflowApp(contributorActor).request("/projects/proj-1/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validWorkflowBody),
    });

    expect(res.status).toBe(403);
    expect(prismaMocks.workflowCreate).not.toHaveBeenCalled();
  });

  it("admits a PROJECT_ADMIN (isProjectAdmin → true, not 403)", async () => {
    accessMocks.isProjectAdmin.mockResolvedValue(true);

    const res = await makeWorkflowApp(adminActor).request("/projects/proj-1/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validWorkflowBody),
    });

    expect(res.status).not.toBe(403);
    expect(prismaMocks.workflowCreate).toHaveBeenCalled();
  });
});
