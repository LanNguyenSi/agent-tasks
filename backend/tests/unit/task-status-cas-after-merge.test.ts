/**
 * casUpdateTaskStatusAfterMerge against an in-memory stand-in for the task
 * delegate: the retry-lost re-read, the loss reason and the result policy of
 * the fresh-row completion, without a database.
 */
import { describe, it, expect } from "vitest";
import { casUpdateTaskStatusAfterMerge, type TaskStatusCasSnapshot } from "../../src/services/task-status-cas.js";

// `result` is optional so a test can hand the function a row whose read
// carried no result value at all (undefined rather than null).
type Row = TaskStatusCasSnapshot & { result?: string | null };

/** The row as a read that carried no `result` value returns it. */
function withoutResultValue(row: Row): Row {
  const copy = { ...row };
  delete copy.result;
  return copy;
}

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
        wheres.push({ ...args.where });
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

  it("a guard miss whose re-read finds the task reopened with a result does not retry: the loss reports the reopened status", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: null };
    const reopened = { ...BASE, status: "in_progress", statusVersion: 5, result: "x" };
    const { db, updates } = fakeDb([done, reopened], [false, false, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toEqual({ kind: "lost", currentStatus: "in_progress", reason: "status_changed" });
    // No write lands on the reopened row: only the first write and the guarded retry ran.
    expect(updates).toHaveLength(2);
  });

  it("a retry without result that loses again reports the status of a fresh read, not the row the retry was built from", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: null };
    const edited = { ...done, result: "late" };
    const reopened = { ...BASE, status: "open", statusVersion: 5, result: "late", claimedByUserId: null };
    const { db, updates, reads } = fakeDb([done, edited, reopened], [false, false, false]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toEqual({ kind: "lost", currentStatus: "open", reason: "status_changed" });
    expect(updates).toHaveLength(3);
    expect(reads()).toBe(3);
  });

  it("a retry without result completes against the re-read row and reports that row as the prior state", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: null };
    const bumped = { ...done, statusVersion: 6, result: "x", claimedByUserId: null };
    const writtenRow = { ...bumped, statusVersion: 7 };
    const { db, updates, wheres } = fakeDb([done, bumped, writtenRow], [false, false, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toMatchObject({
      kind: "written",
      webhookFirst: true,
      prior: { status: "done", statusVersion: 6, resultKept: true },
    });
    expect(wheres[2]).toHaveProperty("statusVersion", 6);
    expect(wheres[2]).toHaveProperty("claimedByUserId", null);
    expect(wheres[2]).not.toHaveProperty("result");
    expect(updates[2]).not.toHaveProperty("result");
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

  it("a row that is gone at the first fresh read is reported as unknown, without a retry", async () => {
    const { db, updates } = fakeDb([null], [false, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toEqual({ kind: "lost", currentStatus: null, reason: "status_changed" });
    expect(updates).toHaveLength(1);
  });

  it("a fresh row in another status is reported without a retry, even when a retry would land", async () => {
    const elsewhere = { ...BASE, status: "in_progress", statusVersion: 4 };
    const { db, updates, reads } = fakeDb([elsewhere], [false, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toEqual({ kind: "lost", currentStatus: "in_progress", reason: "status_changed" });
    expect(updates).toHaveLength(1);
    expect(reads()).toBe(1);
  });

  it("another status with an unchanged status version is still a status change, not a moved claim", async () => {
    // A writer that skipped the version bump: the status alone must decide.
    const { db } = fakeDb([{ ...BASE, status: "in_progress" }], [false]);

    expect(await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {})).toEqual({
      kind: "lost",
      currentStatus: "in_progress",
      reason: "status_changed",
    });
  });

  it("a fresh row read without a result value counts as having none: the retry writes the result under the null guard", async () => {
    const done = withoutResultValue({ ...BASE, status: "done", statusVersion: 4 });
    const { db, updates, wheres } = fakeDb([done], [false, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toMatchObject({ kind: "written", webhookFirst: true, prior: { resultKept: false } });
    expect(updates[1]).toHaveProperty("result", "mine");
    expect(wheres[1]).toHaveProperty("result", null);
  });

  it("a guarded retry that lands completes against the fresh row: no re-read, no second write", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: null };
    const writtenRow = { ...done, statusVersion: 5, result: "mine", claimedByUserId: null };
    const { db, updates, wheres, reads } = fakeDb([done, writtenRow], [false, true, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toEqual({
      kind: "written",
      task: writtenRow,
      webhookFirst: true,
      prior: { status: "done", statusVersion: 4, resultKept: false },
    });
    // The retry is conditioned on the fresh row, not on the request's own snapshot.
    expect(wheres[1]).toMatchObject({ status: "done", statusVersion: 4, claimedByUserId: "u1", result: null });
    expect(updates).toHaveLength(2);
    expect(reads()).toBe(2);
  });

  it("a guard miss whose re-read is still done without a result does not retry again: the loss reports done", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: null };
    const bumped = { ...done, statusVersion: 5, result: null, claimedByUserId: null };
    const { db, updates } = fakeDb([done, bumped], [false, false, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toEqual({ kind: "lost", currentStatus: "done", reason: "status_changed" });
    expect(updates).toHaveLength(2);
  });

  it("a guard miss whose re-read carries no result value does not retry without it", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: null };
    const bumped = withoutResultValue({ ...done, statusVersion: 5 });
    const { db, updates } = fakeDb([done, bumped], [false, false, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toEqual({ kind: "lost", currentStatus: "done", reason: "status_changed" });
    expect(updates).toHaveLength(2);
  });

  it("a retry without a result to write that loses is not retried: the loss reports a fresh read", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: "theirs" };
    const bumped = { ...done, statusVersion: 5 };
    const { db, updates, reads } = fakeDb([done, bumped], [false, false, true]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toEqual({ kind: "lost", currentStatus: "done", reason: "status_changed" });
    expect(updates).toHaveLength(2);
    expect(reads()).toBe(2);
  });

  it("a row that vanished during the guard-miss re-read is not read a third time", async () => {
    const done = { ...BASE, status: "done", statusVersion: 4, result: null };
    const { db, updates, reads } = fakeDb([done, null], [false, false]);

    const outcome = await casUpdateTaskStatusAfterMerge(db, BASE, DATA, "done", {});

    expect(outcome).toEqual({ kind: "lost", currentStatus: null, reason: "status_changed" });
    expect(updates).toHaveLength(2);
    expect(reads()).toBe(2);
  });

  it("a lost retry takes its loss reason from the fresh read: claims that moved again are claim_moved, a version bump is a status change", async () => {
    // The request already targets the status the row has, so only the claims
    // and the status version separate the rows.
    const snapshot = { ...BASE, status: "done", statusVersion: 4 };
    const current = { ...snapshot, claimedByUserId: "u2" };
    const lose = (latest: Row) =>
      casUpdateTaskStatusAfterMerge(fakeDb([current, latest], [false, false]).db, snapshot, DATA, "done", {});

    expect(await lose({ ...snapshot, claimedByUserId: "u3" })).toEqual({
      kind: "lost",
      currentStatus: "done",
      reason: "claim_moved",
    });
    expect(await lose({ ...snapshot, statusVersion: 5, claimedByUserId: null })).toEqual({
      kind: "lost",
      currentStatus: "done",
      reason: "status_changed",
    });
  });
});
