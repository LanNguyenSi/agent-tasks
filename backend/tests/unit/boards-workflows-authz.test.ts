import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  boardFindUnique: vi.fn(),
  boardCreate: vi.fn(),
  boardUpdate: vi.fn(),
  workflowCreate: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
  isProjectAdmin: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    board: {
      findMany: vi.fn(),
      findUnique: prismaMocks.boardFindUnique,
      create: prismaMocks.boardCreate,
      update: prismaMocks.boardUpdate,
    },
    workflow: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: prismaMocks.workflowCreate,
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    project: { findUnique: vi.fn() },
    task: { findMany: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../../src/services/team-access.js", () => accessMocks);
vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { boardRouter } from "../../src/routes/boards.js";
import { workflowRouter } from "../../src/routes/workflows.js";

const VIEWER: Actor = {
  type: "human",
  userId: "viewer-1",
};

function makeApp(router: typeof boardRouter | typeof workflowRouter, actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.requireProjectWrite.mockResolvedValue(true);
  accessMocks.isProjectAdmin.mockResolvedValue(false);
  prismaMocks.boardFindUnique.mockResolvedValue({ id: "board-1", projectId: "proj-1" });
});

describe("boards/workflows write-tier authz", () => {
  it("rejects PROJECT_VIEWER-style create board attempts", async () => {
    accessMocks.requireProjectWrite.mockResolvedValue(false);

    const res = await makeApp(boardRouter, VIEWER).request("/projects/proj-1/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Board",
        config: {
          columns: [{ id: "c1", label: "Open", status: "open" }],
          groupBy: "none",
          filters: [],
        },
      }),
    });

    expect(res.status).toBe(403);
    expect(accessMocks.requireProjectWrite).toHaveBeenCalledWith(VIEWER, "proj-1");
    expect(prismaMocks.boardCreate).not.toHaveBeenCalled();
  });

  it("rejects PROJECT_VIEWER-style board updates", async () => {
    accessMocks.requireProjectWrite.mockResolvedValue(false);

    const res = await makeApp(boardRouter, VIEWER).request("/boards/board-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });

    expect(res.status).toBe(403);
    expect(accessMocks.requireProjectWrite).toHaveBeenCalledWith(VIEWER, "proj-1");
    expect(prismaMocks.boardUpdate).not.toHaveBeenCalled();
  });

  it("rejects PROJECT_VIEWER-style workflow creation", async () => {
    accessMocks.requireProjectWrite.mockResolvedValue(false);

    const res = await makeApp(workflowRouter, VIEWER).request("/projects/proj-1/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Custom flow",
        isDefault: false,
        definition: {
          states: [
            { name: "open", label: "Open", terminal: false },
            { name: "in_progress", label: "In Progress", terminal: false },
            { name: "review", label: "Review", terminal: false },
            { name: "done", label: "Done", terminal: true },
          ],
          transitions: [{ from: "open", to: "in_progress", requiredRole: "any" }],
          initialState: "open",
        },
      }),
    });

    expect(res.status).toBe(403);
    expect(accessMocks.requireProjectWrite).toHaveBeenCalledWith(VIEWER, "proj-1");
    expect(prismaMocks.workflowCreate).not.toHaveBeenCalled();
  });
});
