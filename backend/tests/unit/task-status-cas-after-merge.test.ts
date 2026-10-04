/**
 * casUpdateTaskStatusAfterMerge against an in-memory stand-in for the task
 * delegate: the retry-lost re-read, the loss reason and the result policy of
 * the fresh-row completion, without a database.
 */
import { describe, it, expect } from "vitest";
import { casUpdateTaskStatusAfterMerge, type TaskStatusCasSnapshot } from "../../src/services/task-status-cas.js";

type Row = TaskStatusCasSnapshot & { result: string | null };

const BASE: Row = {
  id: "t1",
  status: "review",
  statusVersion: 3,
  claimedByUserId: "u1",
  claimedByAgentId: null,
  reviewClaimedByUserId: null,
  reviewClaimedByAgentId: null,
  result: null,
};

/** `reads` yields the row for each successive findUnique; `lose` makes the matching updateMany calls write nothing. */
function fakeDb(reads: Array<Row | null>, writes: Array<boolean>) {
  const updates: Array<Record<string, unknown>> = [];
  const wheres: Array<Record<string, unknown>> = [];
  let readIndex = 0;
  let writeIndex = 0;
  const db = {
    task: {
      findUnique: async () => reads[Math.min(readIndex++, reads.length - 1)] ?? null,
      updateMany: async (args: { where: Row; data: Record<string, unknown> }) => {
        updates.push(args.data);
        wheres.push(args.where);
        return { count: writes[writeIndex++] ? 1 : 0 };
      },
    },
  };
  return { db: db as never, updates, wheres, reads: () => readIndex };
}

const DATA = { status: "done", result: "mine" };

describe("casUpdateTaskStatusAfterMerge", () => {
  it("a lost retry re-reads the row and reports its current status, not the one the retry was built from", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4 };
    const reopened = { ...BASE, status: "open", statusVersion: 5 };
    // reads: the post-write findUnique is never reached; current = done, then the re-read = reopened.
    const { db, reads } = fakeDb([done, reopened], [false, false]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toEqual({ kind: "lost", currentStatus: "open", reason: "status_changed" });
    expect(reads()).toBe(2);
  });

  it("a row that vanished during the re-read is reported as unknown", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4 };
    const { db } = fakeDb([done, null], [false, false]);

    expect(await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {})).toEqual({
      kind: "lost",
      currentStatus: null,
      reason: "status_changed",
    });
  });

  it("another status is a status change; same status and version with a moved claim is claim_moved; a version bump alone is a status change", async () => {
    const other = (row: Row) => casUpdateTaskStatusAfterMerge(fakeDb([row], [false]).db, BASE, DATA, "done", {});

    expect(await other({ ...BASE, status: "in_progress", statusVersion: 4 })).toMatchObject({ reason: "status_changed" });
    expect(await other({ ...BASE, claimedByUserId: "u2" })).toMatchObject({
      kind: "lost",
      currentStatus: "review",
      reason: "claim_moved",
    });
    expect(await other({ ...BASE, statusVersion: 5 })).toMatchObject({ reason: "status_changed" });
  });

  it("the fresh-row completion keeps a result the other writer set and reports the prior status and version", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: "theirs" };
    const { db, updates } = fakeDb([done], [false, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toMatchObject({
      kind: "written",
      webhookFirst: true,
      prior: { status: "done", statusVersion: 4, resultKept: true },
    });
    expect(updates[1]).not.toHaveProperty("result");
    expect(updates[1]).toHaveProperty("status", "done");
  });

  it("the fresh-row completion writes the result while the other writer left none", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: null };
    const { db, updates } = fakeDb([done], [false, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toMatchObject({ kind: "written", webhookFirst: true, prior: { resultKept: false } });
    expect(updates[1]).toHaveProperty("result", "mine");
  });

  it("the retry writes result only while it is still null: the WHERE carries result null, and a miss re-reads and retries without it", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: null };
    const edited = { ...done, result: "late edit" };
    const { db, updates, wheres } = fakeDb([done, edited], [false, false, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(wheres[1]).toHaveProperty("result", null);
    expect(updates[1]).toHaveProperty("result", "mine");
    expect(updates[2]).not.toHaveProperty("result");
    expect(wheres[2]).not.toHaveProperty("result");
    expect(outcome).toMatchObject({ kind: "written", webhookFirst: true, prior: { status: "done", resultKept: true } });
  });

  it("a retry without a result to write carries no result condition", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: null };
    const { db, wheres } = fakeDb([done], [false, true]);

    await casUpdateTaskStatusAfterMerge(db, BASE, { status: "done" }, "done", {});

    expect(wheres[1]).not.toHaveProperty("result");
  });

  it("a first write that wins reports no webhook-first completion", async () => {
    const { db } = fakeDb([BASE], [true]);

    expect(await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {})).toMatchObject({
      kind: "written",
      webhookFirst: false,
    });
  });
});
