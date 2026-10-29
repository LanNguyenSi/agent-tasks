/**
 * DB-backed test: both GitHub `issues.opened` creators (the legacy
 * handleIssuesEvent and the Grounding webhook handler) create the task in the
 * initial state of the project's stored default workflow, not in the literal
 * `open`, and tell the claim-eligible agents of the team about it
 * (`task_available`, with the created state in the context).
 *
 * The workflow API only accepts the four built-in state names, so the custom
 * definition is stored directly.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const shared = vi.hoisted(() => ({ db: undefined as PrismaClient | undefined }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, key) => {
        if (!shared.db) throw new Error("test database not connected");
        const value = Reflect.get(shared.db, key);
        return typeof value === "function" ? value.bind(shared.db) : value;
      },
    },
  ),
}));

// The real delivery runs (a project without a notification webhook sends nothing); the spy records the calls.
vi.mock("../../src/services/signal.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/services/signal.js")>();
  return { ...original, maybeDeliverSignalWebhook: vi.fn(original.maybeDeliverSignalWebhook) };
});

import { maybeDeliverSignalWebhook } from "../../src/services/signal.js";
import { handleIssuesEvent } from "../../src/services/github-webhook.js";
import { GroundingGithubWebhookService } from "../../src/services/grounding-github-webhook.js";

const queuedDefinition = {
  initialState: "queued",
  states: [
    { name: "queued", label: "Queued", terminal: false },
    { name: "working", label: "Working", terminal: false },
    { name: "checking", label: "Checking", terminal: false },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "queued", to: "working" },
    { from: "working", to: "checking" },
    { from: "checking", to: "shipped" },
  ],
};
const todoDefinition = {
  initialState: "todo",
  states: [
    { name: "todo", label: "Todo", terminal: false },
    { name: "doing", label: "Doing", terminal: false },
    { name: "released", label: "Released", terminal: true },
  ],
  transitions: [{ from: "todo", to: "doing" }, { from: "doing", to: "released" }],
};

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let userId: string;
let repo: string;
let deliveryCounter = 0;

/** One `issues.opened` delivery through the creator under test. */
type Creator = { name: string; open: (issueNumber?: number) => Promise<unknown> };
const legacy: Creator = {
  name: "legacy handleIssuesEvent",
  open: (issueNumber = 17) =>
    handleIssuesEvent({
      action: "opened",
      repository: { full_name: repo },
      issue: { number: issueNumber, title: "Issue", body: "Description", html_url: `https://github.com/${repo}/issues/${issueNumber}`, state: "open" },
    }),
};
const grounding: Creator = {
  name: "grounding webhook handler",
  open: (issueNumber = 17) =>
    new GroundingGithubWebhookService(db).handle({
      deliveryId: `delivery-${randomUUID()}-${deliveryCounter++}`,
      event: "issues",
      rawBody: JSON.stringify({
        action: "opened",
        repository: { full_name: repo },
        issue: { number: issueNumber, title: "Issue", body: "Description", html_url: `https://github.com/${repo}/issues/${issueNumber}`, state: "open" },
      }),
    }),
};

async function seedProject(definition?: unknown) {
  const id = randomUUID();
  await db.project.create({ data: { id, teamId, name: "P", slug: id, githubRepo: repo } });
  if (definition !== undefined) await db.workflow.create({ data: { projectId: id, name: "stored", isDefault: true, definition: definition as object } });
  return id;
}
async function seedAgent(opts: { scopes?: string[]; revoked?: boolean } = {}) {
  const id = randomUUID();
  await db.agentToken.create({
    data: { id, teamId, createdById: userId, name: `agent-${id}`, tokenHash: randomUUID(), scopes: opts.scopes ?? ["tasks:read", "tasks:claim"], revokedAt: opts.revoked ? new Date() : null },
  });
  return id;
}
const tasksOf = (projectId: string) => db.task.findMany({ where: { projectId }, orderBy: { id: "asc" } });
const signalsOf = (projectId: string) => db.signal.findMany({ where: { projectId, type: "task_available" }, orderBy: { id: "asc" } });

beforeAll(async () => {
  store = await groundingPostgres();
  db = store.db;
  shared.db = db;
}, 60000);
afterAll(async () => {
  if (store) await store.close();
});
beforeEach(async () => {
  vi.mocked(maybeDeliverSignalWebhook).mockClear();
  userId = randomUUID();
  await db.user.create({ data: { id: userId, login: `u-${userId}` } });
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Issues", slug: teamId } });
  await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  repo = `acme/issue_opened_${randomUUID().replaceAll("-", "")}`;
});

describe.each([legacy, grounding])("issues.opened through the $name", (creator) => {
  it("creates the task in the initial state of a stored custom default workflow and signals it there", async () => {
    const projectId = await seedProject(queuedDefinition);
    const agentId = await seedAgent();

    await creator.open();

    const [task, ...rest] = await tasksOf(projectId);
    expect(rest).toHaveLength(0);
    expect(task).toMatchObject({ title: "[GH #17] Issue", status: "queued" });
    const signals = await signalsOf(projectId);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      taskId: task!.id,
      recipientAgentId: agentId,
      context: { taskStatus: "queued", taskTitle: "[GH #17] Issue", actor: { type: "webhook", name: "GitHub" } },
    });
  });

  it("keeps a project without a stored workflow at open and signals it there", async () => {
    const projectId = await seedProject();
    await seedAgent();

    await creator.open();

    const [task] = await tasksOf(projectId);
    expect(task!.status).toBe("open");
    const signals = await signalsOf(projectId);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ taskId: task!.id, context: { taskStatus: "open" } });
  });

  it("keeps a stored four-state workflow at open", async () => {
    const projectId = await seedProject({
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "in_progress", label: "In progress", terminal: false },
        { name: "review", label: "Review", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [{ from: "open", to: "in_progress" }, { from: "in_progress", to: "review" }, { from: "review", to: "done" }],
    });

    await creator.open();

    expect((await tasksOf(projectId))[0]!.status).toBe("open");
  });

  it("falls back to the built-in initial state when the stored definition cannot be read", async () => {
    const projectId = await seedProject({ unreadable: true });

    await creator.open();

    expect((await tasksOf(projectId))[0]!.status).toBe("open");
  });

  it("gives each linked project the initial state of its own workflow", async () => {
    const queued = await seedProject(queuedDefinition);
    const todo = await seedProject(todoDefinition);
    const builtin = await seedProject();
    await seedAgent();

    await creator.open();

    expect((await tasksOf(queued))[0]!.status).toBe("queued");
    expect((await tasksOf(todo))[0]!.status).toBe("todo");
    expect((await tasksOf(builtin))[0]!.status).toBe("open");
    expect((await signalsOf(queued))[0]!.context).toMatchObject({ taskStatus: "queued" });
    expect((await signalsOf(todo))[0]!.context).toMatchObject({ taskStatus: "todo" });
    expect((await signalsOf(builtin))[0]!.context).toMatchObject({ taskStatus: "open" });
  });

  it("signals only the team's claim-eligible agents and still creates the task when there are none", async () => {
    const withoutAgents = await seedProject(queuedDefinition);
    await seedAgent({ scopes: ["tasks:read"] });
    await seedAgent({ revoked: true });
    const otherTeam = randomUUID();
    await db.team.create({ data: { id: otherTeam, name: "Other", slug: otherTeam } });
    await db.agentToken.create({ data: { id: randomUUID(), teamId: otherTeam, createdById: userId, name: "foreign", tokenHash: randomUUID(), scopes: ["tasks:claim"] } });

    await creator.open();

    expect((await tasksOf(withoutAgents))[0]!.status).toBe("queued");
    expect(await signalsOf(withoutAgents)).toHaveLength(0);
  });

  it("never creates a backlog task and signals once per eligible agent", async () => {
    const projectId = await seedProject(queuedDefinition);
    const first = await seedAgent();
    const second = await seedAgent();

    await creator.open();

    expect((await tasksOf(projectId)).map((t) => t.status)).toEqual(["queued"]);
    expect((await signalsOf(projectId)).map((s) => s.recipientAgentId).sort()).toEqual([first, second].sort());
  });
});

describe("issues.opened through the grounding webhook handler: replay", () => {
  it("a replayed delivery returns its stored result and adds neither a task nor a signal", async () => {
    const projectId = await seedProject(queuedDefinition);
    await seedAgent();
    const service = new GroundingGithubWebhookService(db);
    const input = {
      deliveryId: `replay-${randomUUID()}`,
      event: "issues",
      rawBody: JSON.stringify({ action: "opened", repository: { full_name: repo }, issue: { number: 3, title: "Issue", body: null, html_url: `https://github.com/${repo}/issues/3`, state: "open" } }),
    };

    await service.handle(input);
    const replay = await service.handle(input);

    expect(replay).toMatchObject({ duplicate: true, changed: 1 });
    expect(await tasksOf(projectId)).toHaveLength(1);
    expect(await signalsOf(projectId)).toHaveLength(1);
  });

  it("hands each signal to the outbound notification webhook once, after the commit, and not again on a replay", async () => {
    const projectId = await seedProject(queuedDefinition);
    await seedAgent();
    await seedAgent();
    const service = new GroundingGithubWebhookService(db);
    const input = {
      deliveryId: `notify-${randomUUID()}`,
      event: "issues",
      rawBody: JSON.stringify({ action: "opened", repository: { full_name: repo }, issue: { number: 4, title: "Issue", body: null, html_url: `https://github.com/${repo}/issues/4`, state: "open" } }),
    };

    await service.handle(input);
    const stored = await signalsOf(projectId);
    expect(stored).toHaveLength(2);
    // Every delivered signal is a committed row: the spy gets the rows the transaction wrote.
    expect(vi.mocked(maybeDeliverSignalWebhook).mock.calls.map(([signal]) => signal.id).sort()).toEqual(stored.map((s) => s.id).sort());

    vi.mocked(maybeDeliverSignalWebhook).mockClear();
    await service.handle(input);
    expect(vi.mocked(maybeDeliverSignalWebhook)).not.toHaveBeenCalled();
  });

  it("after a serialization failure retries the transaction, delivers only the signals the committed attempt wrote", async () => {
    const projectId = await seedProject(queuedDefinition);
    await seedAgent();
    let failed = false;
    // The first attempt writes its rows, then fails on the delivery-result update and rolls back; the retry commits.
    const flaky = store.connect(2).$extends({
      query: {
        groundingGithubWebhookDelivery: {
          async update({ args, query }) {
            if (!failed) {
              failed = true;
              throw new Prisma.PrismaClientKnownRequestError("serialization failure", { code: "P2034", clientVersion: "test" });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    await new GroundingGithubWebhookService(flaky).handle({
      deliveryId: `retry-${randomUUID()}`,
      event: "issues",
      rawBody: JSON.stringify({ action: "opened", repository: { full_name: repo }, issue: { number: 9, title: "Issue", body: null, html_url: `https://github.com/${repo}/issues/9`, state: "open" } }),
    });

    expect(failed).toBe(true);
    const stored = await signalsOf(projectId);
    expect(stored).toHaveLength(1);
    // The rolled-back attempt's rows are never handed to the notification webhook.
    expect(vi.mocked(maybeDeliverSignalWebhook).mock.calls.map(([signal]) => signal.id)).toEqual(stored.map((s) => s.id));
  });
});
