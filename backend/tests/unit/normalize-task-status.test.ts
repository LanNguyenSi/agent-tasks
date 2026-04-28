/**
 * Unit tests for `backend/prisma/normalize-task-status.ts`.
 *
 * The script runs in `Dockerfile.migrate` BEFORE `prisma db push`
 * converts `task.status` from String to the new TaskStatus enum. It
 * does two things, both load-bearing for the deploy:
 *
 *   1. Rewrites task rows whose `status` is outside the 4-state set
 *      ({open, in_progress, review, done}). `abandoned` folds into
 *      `done` + `metadata.abandoned: true`; any other foreign value
 *      goes back to `open` plus a `metadata.migratedFrom` tag and a
 *      system comment on the task.
 *   2. Deletes Workflow rows whose `definition` references state
 *      names outside the 4-state set, and nulls out `task.workflowId`
 *      for any task that pointed at the deleted row — otherwise
 *      `resolveEffectiveDefinition` would later return a definition
 *      naming `"spec"` / `"plan"` / etc. and the engine would try to
 *      write a foreign string into the now-locked enum column.
 *
 * Both branches must be idempotent. We mock prisma so the test
 * exercises the script's logic without needing a live Postgres.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  taskUpdate: vi.fn(),
  taskUpdateMany: vi.fn(),
  commentCreate: vi.fn(),
  auditCreate: vi.fn(),
  workflowDeleteMany: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    $queryRaw = prismaMocks.queryRaw;
    $disconnect = prismaMocks.disconnect;
    task = { update: prismaMocks.taskUpdate, updateMany: prismaMocks.taskUpdateMany };
    comment = { create: prismaMocks.commentCreate };
    auditLog = { create: prismaMocks.auditCreate };
    workflow = { deleteMany: prismaMocks.workflowDeleteMany };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.disconnect.mockResolvedValue(undefined);
  prismaMocks.taskUpdate.mockResolvedValue({});
  prismaMocks.taskUpdateMany.mockResolvedValue({ count: 0 });
  prismaMocks.commentCreate.mockResolvedValue({});
  prismaMocks.auditCreate.mockResolvedValue({});
  prismaMocks.workflowDeleteMany.mockResolvedValue({ count: 0 });
});

import { main } from "../../prisma/normalize-task-status.js";

async function runScript(): Promise<void> {
  await main();
}

describe("normalize-task-status — task status normalization", () => {
  it("rewrites abandoned → done + metadata.abandoned", async () => {
    prismaMocks.queryRaw
      .mockResolvedValueOnce([
        { id: "task-1", status: "abandoned", metadata: null, project_id: "proj-1" },
      ])
      .mockResolvedValueOnce([]); // no workflows

    await runScript();

    expect(prismaMocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: {
        status: "done",
        metadata: { abandoned: true, migratedFrom: "abandoned" },
      },
    });
    expect(prismaMocks.commentCreate).not.toHaveBeenCalled();
    expect(prismaMocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "task.status_migrated",
        taskId: "task-1",
        payload: expect.objectContaining({ from: "abandoned", to: "done" }),
      }),
    });
  });

  it("rewrites foreign status → open + metadata.migratedFrom + system comment", async () => {
    prismaMocks.queryRaw
      .mockResolvedValueOnce([
        { id: "task-2", status: "shipping", metadata: { existing: "keep me" }, project_id: "proj-1" },
      ])
      .mockResolvedValueOnce([]);

    await runScript();

    expect(prismaMocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: "task-2" },
      data: {
        status: "open",
        metadata: { existing: "keep me", migratedFrom: "shipping" },
      },
    });
    expect(prismaMocks.commentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: "task-2",
        content: expect.stringContaining('"shipping"'),
      }),
    });
    expect(prismaMocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ from: "shipping", to: "open" }),
      }),
    });
  });

  it("is a no-op when no foreign-status rows exist", async () => {
    prismaMocks.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await runScript();

    expect(prismaMocks.taskUpdate).not.toHaveBeenCalled();
    expect(prismaMocks.commentCreate).not.toHaveBeenCalled();
    expect(prismaMocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe("normalize-task-status — Workflow row neutralization", () => {
  it("deletes workflows whose definition references foreign state names", async () => {
    prismaMocks.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "wf-1",
          project_id: "proj-1",
          definition: {
            initialState: "backlog",
            states: [
              { name: "backlog" },
              { name: "spec" },
              { name: "review" },
              { name: "done" },
            ],
            transitions: [
              { from: "backlog", to: "spec" },
              { from: "spec", to: "review" },
              { from: "review", to: "done" },
            ],
          },
        },
      ]);

    await runScript();

    expect(prismaMocks.taskUpdateMany).toHaveBeenCalledWith({
      where: { workflowId: "wf-1" },
      data: { workflowId: null },
    });
    expect(prismaMocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "workflow.reset",
        payload: expect.objectContaining({
          foreignStateNames: expect.arrayContaining(["backlog", "spec"]),
        }),
      }),
    });
    expect(prismaMocks.workflowDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["wf-1"] } },
    });
  });

  it("preserves Workflow rows whose definition only uses the 4 allowed states", async () => {
    prismaMocks.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "wf-default-equivalent",
          project_id: "proj-1",
          definition: {
            initialState: "open",
            states: [
              { name: "open" },
              { name: "in_progress" },
              { name: "review" },
              { name: "done" },
            ],
            transitions: [
              { from: "open", to: "in_progress" },
              { from: "in_progress", to: "review" },
              { from: "review", to: "done" },
            ],
          },
        },
      ]);

    await runScript();

    expect(prismaMocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(prismaMocks.workflowDeleteMany).not.toHaveBeenCalled();
  });

  it("handles a definition with malformed shape gracefully (no foreign names → no action)", async () => {
    prismaMocks.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "wf-empty", project_id: "proj-1", definition: null },
        { id: "wf-no-states", project_id: "proj-1", definition: {} },
      ]);

    await runScript();

    expect(prismaMocks.workflowDeleteMany).not.toHaveBeenCalled();
  });
});
