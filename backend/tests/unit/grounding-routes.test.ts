import { PrismaClient } from "@prisma/client";
import { beforeEach, describe, it, expect, vi, type MockInstance } from "vitest";
const mocks = vi.hoisted(() => ({ token: vi.fn(), updateToken: vi.fn() }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: { agentToken: { findUnique: mocks.token, update: mocks.updateToken } } }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("../../src/services/team-access.js", () => ({ requireProjectWrite: vi.fn(), hasProjectRole: vi.fn() }));
vi.mock("../../src/services/github-delegation.js", () => ({ findDelegationUser: vi.fn() }));
import { createApp } from "../../src/app.js";
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { GroundingDecisionError } from "../../src/services/grounding-transaction.js";
import { GroundingAccessError } from "../../src/services/grounding-context.js";
import { actor, ids, taskFixture } from "../helpers/grounding-fixtures.js";

let service: GroundingAttemptsService;
let authorize: MockInstance<GroundingAttemptsService["authorize"]>;
let issue: MockInstance<GroundingAttemptsService["issue"]>;
let ingest: MockInstance<GroundingAttemptsService["ingest"]>;
const path = `/api/tasks/${ids.task}/grounding-attempts`;
const receiptPath = `${path}/${ids.project}/receipt`;
const request = (body: unknown, route = path, authorization: string | null = "Bearer test") => new Request(`http://localhost${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
beforeEach(() => {
  mocks.token.mockResolvedValue({ id: ids.agent, teamId: ids.team, createdById: ids.user, scopes: actor.scopes, revokedAt: null, expiresAt: null });
  service = new GroundingAttemptsService({ db: {} as PrismaClient, config: { audience: "consumer.test", trust: () => [] } });
  authorize = vi.spyOn(service, "authorize").mockResolvedValue();
  issue = vi.spyOn(service, "issue").mockResolvedValue({ test: true } as never);
  ingest = vi.spyOn(service, "ingest").mockResolvedValue({ test: true } as never);
});

describe("mounted grounding routes", () => {
  it("requires real app authentication and remains dormant without injected service", async () => {
    const app = createApp("http://localhost");
    expect((await app.fetch(request({ intent: "finish" }, path, null))).status).toBe(401);
    expect((await app.fetch(request({ intent: "finish" }))).status).toBe(503);
    expect((await app.fetch(request({}, receiptPath, null))).status).toBe(401);
    mocks.token.mockResolvedValue({ revokedAt: new Date() });
    expect((await app.fetch(request({ intent: "finish" }))).status).toBe(401);
  });
  it("passes only server-resolved intent and exact receipt string plus nomination", async () => {
    const app = createApp("http://localhost", service);
    expect((await app.fetch(request({ intent: "finish" }))).status).toBe(201);
    expect(issue).toHaveBeenCalledWith(ids.task, actor, "finish");
    const receipt = ' {"format":"test","x":"é"}';
    expect((await app.fetch(request({ session: { id: "session", revision: 1 }, receipt }, receiptPath))).status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(ids.task, ids.project, actor, { id: "session", revision: 1 }, receipt);
  });
  it.each([{}, { intent: "custom" }, { intent: "finish", target: { to: "done" } }, { intent: "finish", headSha: "fake" }, { intent: "finish", metadata: { pass: true } }])("rejects non-strict challenge request %j", async body => {
    expect((await createApp("", service).fetch(request(body))).status).toBe(400);
    expect(issue).not.toHaveBeenCalled();
  });
  it.each([{ receipt: "x" }, { session: { id: "s", revision: 1 }, receipt: {}, extra: true }, { session: { id: "s", revision: 0 }, receipt: "x" }, { session: { id: "s", revision: 1, pass: true }, receipt: "x" }])("rejects non-strict upload %j", async body => {
    expect((await createApp("", service).fetch(request(body, receiptPath))).status).toBe(400); expect(ingest).not.toHaveBeenCalled();
  });
  it("project authorization precedes malformed body diagnostics", async () => {
    authorize.mockRejectedValue(new GroundingAccessError("forbidden", 403));
    const response = await createApp("", service).fetch(request("not json", receiptPath));
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "forbidden" }); expect(ingest).not.toHaveBeenCalled();
  });
  it("uses actual service scope/project/claim checks through the mounted route", async () => {
    authorize.mockRestore();
    const task = taskFixture(); const canWrite = vi.fn(async () => true);
    const db = { $transaction: async (fn: (client: unknown) => unknown) => fn(db), task: { findUnique: async () => task } };
    const real = new GroundingAttemptsService({ db: db as unknown as PrismaClient, config: { audience: "consumer.test", trust: () => [] }, authority: { canWrite, hasRole: async () => true } });
    const app = createApp("", real);
    mocks.token.mockResolvedValue({ id: ids.agent, teamId: ids.team, createdById: ids.user, scopes: [], revokedAt: null, expiresAt: null });
    expect((await app.fetch(request("not json"))).status).toBe(403);
    mocks.token.mockResolvedValue({ id: ids.agent, teamId: ids.team, createdById: ids.user, scopes: actor.scopes });
    canWrite.mockResolvedValue(false); expect((await app.fetch(request("not json"))).status).toBe(403);
    canWrite.mockResolvedValue(true); task.claimedByAgentId = null; expect((await app.fetch(request("not json"))).status).toBe(403);
  });
  it("bounds actual chunks even with a dishonest length and rejects invalid UTF-8", async () => {
    const app = createApp("", service);
    const oversized = new Request(`http://localhost${receiptPath}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test", "Content-Length": "1" }, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(200001)); c.close(); } }), duplex: "half" } as RequestInit);
    expect((await app.fetch(oversized)).status).toBe(400);
    const bad = new Request(`http://localhost${receiptPath}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test" }, body: new Uint8Array([255]) });
    expect((await app.fetch(bad)).status).toBe(400); expect(ingest).not.toHaveBeenCalled();
  });
  it("does not expose enrollment or finalization endpoints", async () => {
    const app = createApp("", service);
    expect((await app.fetch(request({}, `/api/tasks/${ids.task}/grounding-binding`))).status).toBe(404);
    expect((await app.fetch(request({}, `${path}/provision`))).status).toBe(404);
  });
});

it("mounted C02 endpoints preserve reservation collision as 409", async () => {
  issue.mockRejectedValue(new GroundingDecisionError("grounding_finalization_pending"));
  ingest.mockRejectedValue(new GroundingDecisionError("grounding_finalization_pending"));
  const app = createApp("", service);
  for (const response of [await app.fetch(request({ intent: "finish" })), await app.fetch(request({ session: { id: "s", revision: 1 }, receipt: "{}" }, receiptPath))]) {
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "grounding_finalization_pending" });
  }
});
