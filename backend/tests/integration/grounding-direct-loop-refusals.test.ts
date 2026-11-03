/**
 * The Grounding direct transition, review, PATCH, respec and DELETE routes in
 * the mounted app against a real database (tracker task 97615ee1):
 *
 *   - a missing task, a project viewer, a caller without project access and
 *     an agent without the endpoint's scope get the REST handler's status and
 *     body, in the REST handler's order, whether or not the task is
 *     provisioned. The oracle is the REST task router mounted alone. Order:
 *     transition, review and respec refuse the scope before the task lookup,
 *     PATCH after the access check, DELETE refuses every agent first; DELETE
 *     checks write access alone, so a non-member reads the viewer's refusal;
 *   - the routes that read an Idempotency-Key (transition, review, PATCH)
 *     treat an absent header as no key and refuse any present value that is
 *     not a valid key, the empty string included, with the REST /advance 400
 *     (the REST transition, review and PATCH handlers read no key), writing
 *     nothing; an empty-key retry of a disposition therefore never executes;
 *   - respec and DELETE read no key on either handler.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { completionStore, completionFixture } from "../helpers/grounding-completion-fixtures.js";
import { ids } from "../helpers/grounding-fixtures.js";
import { createApp } from "../../src/app.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { taskRouter } from "../../src/routes/tasks.js";
import { createGroundingRemoteTargetGuard } from "../../src/services/grounding-scope.js";
import { createSessionToken } from "../../src/services/session.js";
import type { AppVariables } from "../../src/types/hono.js";

const harness = vi.hoisted(() => ({ db: null as PrismaClient | null, wrapper: { start: vi.fn(), getLedgerSummary: vi.fn() } }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, p) => {
        const v = Reflect.get(harness.db!, p);
        return typeof v === "function" ? v.bind(harness.db) : v;
      },
    },
  ),
}));
vi.mock("../../src/config/index.js", () => ({
  config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 },
}));
vi.mock("../../src/services/grounding-client.js", () => ({ getGroundingClient: () => harness.wrapper }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const SECRET = "test-secret-which-is-long-enough-1234";
const FULL_SCOPES = ["tasks:transition", "tasks:update", "tasks:claim", "tasks:read"];
const SCOPELESS = ["tasks:read", "tasks:claim"];
const agentToken = "grounding-direct-loop-agent";
const foreign = { user: randomUUID(), team: randomUUID(), agent: randomUUID(), token: "grounding-direct-loop-foreign" };
const outsider = randomUUID();
const viewer = randomUUID();
const auth = { agent: agentToken, foreign: foreign.token, human: "", outsider: "", viewer: "" };
let store: Awaited<ReturnType<typeof completionStore>>;
let f: Awaited<ReturnType<typeof completionFixture>>;

const ENDPOINTS = ["transition", "review", "patch", "respec", "delete"] as const;
type Endpoint = (typeof ENDPOINTS)[number];
type Kind = "provisioned" | "unprovisioned";
const KINDS: Kind[] = ["provisioned", "unprovisioned"];
/** The scope each REST handler requires of an agent (DELETE refuses every agent). */
const SCOPE: Record<Endpoint, string> = { transition: "tasks:transition", review: "tasks:transition", patch: "tasks:update", respec: "tasks:update", delete: "" };
const READ_ONLY = { error: "forbidden", message: "Requires write access (PROJECT_VIEWER is read-only)" };
const NO_ACCESS = { error: "forbidden", message: "Access denied to this project" };
const NOT_FOUND = { error: "not_found", message: "Resource not found" };
const AGENT_DELETE = { error: "forbidden", message: "Agents cannot delete tasks" };
const scopeRefusal = (endpoint: Endpoint) => (endpoint === "delete" ? AGENT_DELETE : { error: "forbidden", message: `Missing scope: ${SCOPE[endpoint]}` });
const INVALID_KEY = { error: "validation_error", message: "Invalid Idempotency-Key header" };

/** A body every handler (REST and Grounding) accepts for the fixture task in in_progress. */
function bodyFor(endpoint: Endpoint, caller: keyof typeof auth): unknown {
  if (endpoint === "transition") return { status: "open" };
  if (endpoint === "review") return { action: "request_changes" };
  if (endpoint === "patch") return caller === "agent" || caller === "foreign" ? { branchName: "renamed" } : { title: "Renamed" };
  if (endpoint === "respec") return { description: "Respecified" };
  return undefined;
}
function request(endpoint: Endpoint, taskId: string, caller: keyof typeof auth, key: string | null = null, body = bodyFor(endpoint, caller)) {
  return new Request(`http://localhost/api/tasks/${taskId}${endpoint === "patch" || endpoint === "delete" ? "" : `/${endpoint}`}`, {
    method: endpoint === "patch" ? "PATCH" : endpoint === "delete" ? "DELETE" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth[caller]}`, ...(key === null ? {} : { "Idempotency-Key": key }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function mounted() {
  const scope = { projectIds: new Set([f.projectId]), repos: new Set<string>() };
  return createApp("http://localhost", f.attempts, { db: store.db, service: f.service, scope, remoteGuard: createGroundingRemoteTargetGuard({ db: store.db, scope }) });
}
/** The REST task router alone, without any Grounding router in front of it. */
function rest() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("/api/tasks/*", authMiddleware);
  app.route("/api", taskRouter);
  return app;
}
async function send(app: { fetch: (request: Request) => Response | Promise<Response> }, req: Request) {
  const res = await app.fetch(req);
  return { status: res.status, body: (await res.json()) as any };
}
/** Every row a refused request must leave unchanged. */
async function written(taskId: string) {
  return {
    task: await store.db.task.findUnique({ where: { id: taskId } }),
    operations: await store.db.groundingOperation.findMany({ where: { taskId } }),
    attempts: await store.db.groundingAttempt.findMany({ where: { taskId } }),
    audits: await store.db.auditLog.findMany({ where: { taskId } }),
    comments: await store.db.comment.findMany({ where: { taskId } }),
  };
}
/** An unprovisioned task in the fixture project, in the provisioned task's state. */
async function twin(data: Record<string, unknown> = {}) {
  const id = randomUUID();
  await store.db.task.create({
    data: {
      id, projectId: f.projectId, title: "Twin", description: "Unprovisioned", status: "in_progress", claimedByAgentId: ids.agent, createdByAgentId: ids.agent,
      branchName: "branch", prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42", ...data,
    },
  });
  return id;
}
const taskOf = (kind: Kind) => (kind === "provisioned" ? Promise.resolve(f.taskId) : twin());
const setTask = (id: string, data: Prisma.TaskUncheckedUpdateInput) => store.db.task.update({ where: { id }, data });
const scopes = (list: string[]) => store.db.agentToken.update({ where: { id: ids.agent }, data: { scopes: list } });

/** The configured app's answer, checked against the REST router's own answer to the same request, with nothing written. */
async function refusal(endpoint: Endpoint, taskId: string, caller: keyof typeof auth) {
  const before = await written(taskId);
  const grounded = await send(mounted(), request(endpoint, taskId, caller));
  const legacy = await send(rest(), request(endpoint, taskId, caller));
  expect(grounded).toEqual(legacy);
  expect(await written(taskId)).toEqual(before);
  return grounded;
}

beforeAll(async () => {
  store = await completionStore();
  harness.db = store.db;
  await store.db.agentToken.update({ where: { id: ids.agent }, data: { tokenHash: createHash("sha256").update(agentToken).digest("hex") } });
  await store.db.user.create({ data: { id: foreign.user, login: `foreign-${foreign.user}` } });
  await store.db.team.create({ data: { id: foreign.team, name: "Foreign", slug: `foreign-${foreign.team}` } });
  await store.db.teamMember.create({ data: { teamId: foreign.team, userId: foreign.user, role: "ADMIN" } });
  await store.db.agentToken.create({ data: { id: foreign.agent, teamId: foreign.team, createdById: foreign.user, name: "Foreign", tokenHash: createHash("sha256").update(foreign.token).digest("hex"), scopes: FULL_SCOPES } });
  await store.db.user.create({ data: { id: outsider, login: `outsider-${outsider}` } });
  await store.db.user.create({ data: { id: viewer, login: `viewer-${viewer}` } });
  auth.human = await createSessionToken(ids.user, SECRET);
  auth.outsider = await createSessionToken(outsider, SECRET);
  auth.viewer = await createSessionToken(viewer, SECRET);
}, 60000);
afterAll(async () => {
  await store?.close();
});
beforeEach(async () => {
  vi.stubEnv("REDIS_URL", "");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("outbound fetch disabled")));
  harness.wrapper.start.mockReset().mockRejectedValue(new Error("wrapper must not run"));
  harness.wrapper.getLedgerSummary.mockReset().mockRejectedValue(new Error("legacy must not run"));
  await scopes(FULL_SCOPES);
  await store.db.agentToken.update({ where: { id: foreign.agent }, data: { scopes: FULL_SCOPES } });
  f = await completionFixture(store);
  await store.db.projectMember.create({ data: { projectId: f.projectId, userId: viewer, role: "PROJECT_VIEWER", invitedById: ids.user } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("refusals answered before the enrollment is read keep the REST body and order", () => {
  for (const endpoint of ENDPOINTS) {
    describe(endpoint, () => {
      it("a task that does not exist: 404 for a human and for an agent holding the scope (DELETE refuses the agent first)", async () => {
        const missing = randomUUID();
        expect(await refusal(endpoint, missing, "human")).toEqual({ status: 404, body: NOT_FOUND });
        expect(await refusal(endpoint, missing, "agent")).toEqual(endpoint === "delete" ? { status: 403, body: AGENT_DELETE } : { status: 404, body: NOT_FOUND });
      });

      it(`an agent without ${endpoint === "delete" ? "a human actor" : SCOPE[endpoint]} on a task that does not exist: ${endpoint === "patch" ? "404, PATCH checks the scope after the task lookup" : "the scope refusal comes first"}`, async () => {
        await scopes(SCOPELESS);
        expect(await refusal(endpoint, randomUUID(), "agent")).toEqual(endpoint === "patch" ? { status: 404, body: NOT_FOUND } : { status: 403, body: scopeRefusal(endpoint) });
      });

      it.each(KINDS)("a project viewer on a %s task: 403 Requires write access", async kind => {
        expect(await refusal(endpoint, await taskOf(kind), "viewer")).toEqual({ status: 403, body: READ_ONLY });
      });

      it.each(KINDS)(`a human without project access on a %s task: ${endpoint === "delete" ? "the viewer's refusal, DELETE checks write access alone" : "403 Access denied to this project"}`, async kind => {
        expect(await refusal(endpoint, await taskOf(kind), "outsider")).toEqual({ status: 403, body: endpoint === "delete" ? READ_ONLY : NO_ACCESS });
      });

      it.each(KINDS)("an agent without project access on a %s task: the access refusal (DELETE refuses the agent)", async kind => {
        expect(await refusal(endpoint, await taskOf(kind), "foreign")).toEqual({ status: 403, body: endpoint === "delete" ? AGENT_DELETE : NO_ACCESS });
      });

      it.each(KINDS)(`an agent without project access and without the scope on a %s task: ${endpoint === "patch" ? "the access refusal, PATCH checks the scope after it" : "the scope refusal comes first"}`, async kind => {
        await store.db.agentToken.update({ where: { id: foreign.agent }, data: { scopes: SCOPELESS } });
        expect(await refusal(endpoint, await taskOf(kind), "foreign")).toEqual({ status: 403, body: endpoint === "patch" ? NO_ACCESS : scopeRefusal(endpoint) });
      });

      it.each(KINDS)(`an agent with project access but without ${endpoint === "delete" ? "a human actor" : SCOPE[endpoint]} on a %s task: the REST scope refusal`, async kind => {
        await scopes(SCOPELESS);
        expect(await refusal(endpoint, await taskOf(kind), "agent")).toEqual({ status: 403, body: scopeRefusal(endpoint) });
      });
    });
  }
});

describe("Idempotency-Key on the routes that read one", () => {
  // Each body is a disposition on the provisioned task: without a key it
  // executes under a generated key, so a key taken as absent would write.
  const dispositions: { endpoint: "transition" | "review" | "patch"; status: string; body: unknown; caller: keyof typeof auth }[] = [
    { endpoint: "transition", status: "in_progress", body: { status: "open" }, caller: "agent" },
    { endpoint: "review", status: "review", body: { action: "request_changes" }, caller: "agent" },
    { endpoint: "patch", status: "in_progress", body: { status: "open" }, caller: "human" },
  ];
  for (const { endpoint, status, body, caller } of dispositions) {
    it.each([
      ["an empty", ""],
      ["a malformed", "bad key"],
      ["a too long", "k".repeat(129)],
    ])(`${endpoint}: %s key is the REST /advance 400, nothing written`, async (_label, key) => {
      await setTask(f.taskId, { status });
      const before = await written(f.taskId);
      expect(await send(mounted(), request(endpoint, f.taskId, caller, key, body))).toEqual({ status: 400, body: INVALID_KEY });
      expect(await written(f.taskId)).toEqual(before);
    });

    it(`${endpoint}: an empty-key retry of a disposition never executes, a keyless call executes once`, async () => {
      await setTask(f.taskId, { status });
      const before = await written(f.taskId);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await send(mounted(), request(endpoint, f.taskId, caller, "", body))).toEqual({ status: 400, body: INVALID_KEY });
      }
      expect(await written(f.taskId)).toEqual(before);
      const keyless = await send(mounted(), request(endpoint, f.taskId, caller, null, body));
      expect(keyless.status, JSON.stringify(keyless.body)).toBe(200);
      expect(await store.db.groundingOperation.count({ where: { taskId: f.taskId } })).toBe(1);
    });

    it(`${endpoint}: a valid key executes the disposition once and replays it`, async () => {
      await setTask(f.taskId, { status });
      const first = await send(mounted(), request(endpoint, f.taskId, caller, "loop-key-1", body));
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const retry = await send(mounted(), request(endpoint, f.taskId, caller, "loop-key-1", body));
      expect(retry).toEqual(first);
      expect(await store.db.groundingOperation.count({ where: { taskId: f.taskId } })).toBe(1);
    });
  }

  it("PATCH: an invalid key refuses a no-op edit too, before anything is written", async () => {
    const before = await written(f.taskId);
    expect(await send(mounted(), request("patch", f.taskId, "human", "", { title: "Renamed" }))).toEqual({ status: 400, body: INVALID_KEY });
    expect(await written(f.taskId)).toEqual(before);
  });

  it.each(["", "bad key"])("respec and DELETE read no key, on either handler: %j is ignored", async key => {
    await setTask(f.taskId, { status: "open", claimedByAgentId: null, claimedAt: null });
    const respec = await send(mounted(), request("respec", f.taskId, "agent", key));
    expect(respec.status, JSON.stringify(respec.body)).toBe(200);
    expect((await store.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).description).toBe("Respecified");
    const deleted = await send(mounted(), request("delete", f.taskId, "human", key));
    expect(deleted).toMatchObject({ status: 409, body: { error: "grounding_history_retained" } });
    const plain = await twin({ status: "open", claimedByAgentId: null });
    expect((await send(mounted(), request("respec", plain, "agent", key))).status).toBe(200);
    expect(await send(mounted(), request("delete", plain, "human", key))).toEqual({ status: 200, body: { success: true } });
  });
});
