/**
 * The one-off data repair `prisma/clear-terminal-claims.sql`: it clears the
 * work claim and the review claim of every task whose status is a terminal
 * state of its own effective workflow (pinned workflow, else the project's
 * default row, else the built-in one), and nothing else. The production
 * one-shot (`Dockerfile.migrate`) and `npm run db:push` run it after the
 * schema sync on every deploy, so it has to be idempotent and has to survive a
 * task that a Grounding hold refuses to write.
 *
 * The file runs through `prisma db execute`, the way the deploy runs it, against
 * the isolated schema of the test database.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { WorkflowDefinitionShape } from "../../src/services/default-workflow.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const QA_DEFINITION: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "build", label: "Build", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "open", to: "build" },
    { from: "build", to: "qa" },
    { from: "qa", to: "shipped" },
  ],
};
const DONE_IS_WORK_DEFINITION: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "build", label: "Build", terminal: false },
    { name: "done", label: "Done", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "open", to: "build" },
    { from: "build", to: "done" },
    { from: "done", to: "shipped" },
  ],
};
const UNREADABLE_DEFINITION = { initialState: "open", states: "not-a-list", transitions: [] };

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let userId: string;
let teamId: string;
let agentId: string;

beforeAll(async () => {
  store = await groundingPostgres();
  db = store.db;
}, 60000);

afterAll(async () => {
  if (store) await store.close();
});

beforeEach(async () => {
  // Fresh rows per test; the schema is shared, so the repair is judged on
  // the tasks each test creates.
  userId = randomUUID();
  await db.user.create({ data: { id: userId, login: `u-${userId}` } });
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Repair", slug: randomUUID() } });
  agentId = randomUUID();
  await db.agentToken.create({
    data: { id: agentId, teamId, createdById: userId, name: `agent-${agentId.slice(0, 8)}`, tokenHash: agentId, scopes: ["tasks:read"] },
  });
});

function runRepair(): string {
  return execFileSync(
    process.execPath,
    [resolve("../node_modules/prisma/build/index.js"), "db", "execute", "--schema", "prisma/schema.prisma", "--file", "prisma/clear-terminal-claims.sql"],
    { env: { ...process.env, DATABASE_URL: store.datasourceUrl }, stdio: "pipe", timeout: 30000, encoding: "utf8" },
  );
}

async function project() {
  const id = randomUUID();
  await db.project.create({ data: { id, teamId, name: `P-${id.slice(0, 8)}`, slug: randomUUID() } });
  return id;
}
async function workflow(projectId: string, definition: unknown, isDefault = false) {
  const id = randomUUID();
  await db.workflow.create({ data: { id, projectId, name: `W-${id.slice(0, 8)}`, definition: definition as never, isDefault } });
  return id;
}

const CLAIMED = (when: Date) => ({
  claimedByUserId: userId,
  claimedAt: when,
  reviewClaimedByAgentId: agentId,
  reviewClaimedAt: when,
});
async function task(projectId: string, status: string, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.task.create({ data: { id, projectId, title: `T-${id.slice(0, 8)}`, status, ...overrides } });
  return id;
}
const row = (id: string) => db.task.findUniqueOrThrow({ where: { id } });
const claims = async (id: string) => {
  const t = await row(id);
  return [t.claimedByUserId, t.claimedByAgentId, t.claimedAt, t.reviewClaimedByUserId, t.reviewClaimedByAgentId, t.reviewClaimedAt];
};
const cleared = [null, null, null, null, null, null];

describe("clear-terminal-claims.sql", () => {
  const when = new Date("2026-01-01T00:00:00Z");

  it("clears both claims of a task in the built-in terminal state and keeps a task in a work or review state", async () => {
    const p = await project();
    const done = await task(p, "done", CLAIMED(when));
    const working = await task(p, "in_progress", CLAIMED(when));
    const reviewing = await task(p, "review", CLAIMED(when));
    runRepair();
    expect(await claims(done)).toEqual(cleared);
    expect((await row(working)).claimedByUserId).toBe(userId);
    expect((await row(reviewing)).reviewClaimedByAgentId).toBe(agentId);
  });

  it("clears the work claim of an agent holder as well as a human one", async () => {
    const p = await project();
    const agentHeld = await task(p, "done", { claimedByAgentId: agentId, claimedAt: when });
    runRepair();
    expect(await claims(agentHeld)).toEqual(cleared);
  });

  it("judges a task by the project's default workflow: `shipped` is terminal there, `done` is not", async () => {
    const p = await project();
    await workflow(p, QA_DEFINITION, true);
    const shipped = await task(p, "shipped", CLAIMED(when));
    const done = await task(p, "done", CLAIMED(when));
    const qa = await task(p, "qa", CLAIMED(when));
    runRepair();
    expect(await claims(shipped)).toEqual(cleared);
    expect((await row(done)).claimedByUserId).toBe(userId);
    expect((await row(qa)).reviewClaimedByAgentId).toBe(agentId);
  });

  it("judges a pinned task by its pinned workflow, not by the project default", async () => {
    const p = await project();
    await workflow(p, QA_DEFINITION, true);
    const pinned = await workflow(p, DONE_IS_WORK_DEFINITION);
    const doneInPinned = await task(p, "done", { workflowId: pinned, ...CLAIMED(when) });
    const shippedInPinned = await task(p, "shipped", { workflowId: pinned, ...CLAIMED(when) });
    runRepair();
    expect((await row(doneInPinned)).claimedByUserId).toBe(userId);
    expect(await claims(shippedInPinned)).toEqual(cleared);
  });

  it("judges a stored definition it cannot read by the built-in states", async () => {
    const p = await project();
    await workflow(p, UNREADABLE_DEFINITION, true);
    const done = await task(p, "done", CLAIMED(when));
    const shipped = await task(p, "shipped", CLAIMED(when));
    runRepair();
    expect(await claims(done)).toEqual(cleared);
    expect((await row(shipped)).claimedByUserId).toBe(userId);
  });

  it("leaves a backlog task alone even when a workflow marks a state of that name terminal", async () => {
    const p = await project();
    await workflow(
      p,
      { ...QA_DEFINITION, states: [...QA_DEFINITION.states, { name: "backlog", label: "Backlog", terminal: true }] },
      true,
    );
    const backlog = await task(p, "backlog", CLAIMED(when));
    runRepair();
    expect((await row(backlog)).claimedByUserId).toBe(userId);
  });

  it("writes only the claim columns and is idempotent", async () => {
    const p = await project();
    const done = await task(p, "done", CLAIMED(when));
    const before = await row(done);
    runRepair();
    const afterFirst = await row(done);
    expect(afterFirst).toMatchObject({ status: "done", statusVersion: before.statusVersion, title: before.title });
    expect(afterFirst.updatedAt).toEqual(before.updatedAt);

    const output = runRepair();
    expect(output).toBeDefined();
    expect(await row(done)).toEqual(afterFirst);
  });

  it("skips a task a Grounding hold refuses to write and still clears the others", async () => {
    const p = await project();
    const held = await task(p, "done", CLAIMED(when));
    const free = await task(p, "done", CLAIMED(when));
    await db.groundingMigrationState.create({ data: { taskId: held, projectId: p, held: true, revision: 1 } });
    expect(() => runRepair()).not.toThrow();
    expect((await row(held)).claimedByUserId).toBe(userId);
    expect(await claims(free)).toEqual(cleared);

    // Once the hold is lifted the next run picks the task up.
    await db.groundingMigrationState.update({ where: { taskId: held }, data: { held: false } });
    runRepair();
    expect(await claims(held)).toEqual(cleared);
  });
});
