import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
import { isEnforcedRemoteOperation, prUrlTarget, remoteOperationCandidates, type GroundingScopeTask } from "../../src/services/grounding-scope.js";
import { assertGroundingScopeWired, createGroundingTaskCompletionRouter, type GroundingTaskCompletionDependencies } from "../../src/routes/grounding-task-completion.js";
import { createGroundingGithubRouter } from "../../src/routes/grounding-github.js";
import { GroundingFinalizationService } from "../../src/services/grounding-finalization.js";

const task = (overrides: Partial<GroundingScopeTask> = {}): GroundingScopeTask => ({
  id: "task", projectId: "project", deliverableRepo: null, prNumber: null, prUrl: null, project: { githubRepo: null }, ...overrides,
});
/** A database that fails the test if the guard ever queries it. */
const untouchedDb = new Proxy({}, { get: () => { throw new Error("database must not be queried"); } }) as unknown as PrismaClient;

describe("remote operation candidates", () => {
  it("reads a PR URL's repository and number the way the legacy handlers do", () => {
    expect(prUrlTarget("https://github.com/Acme/Widget/pull/12")).toEqual({ repo: "acme/widget", prNumber: 12 });
    expect(prUrlTarget("https://github.com/acme/widget/pull/12/files")).toEqual({ repo: "acme/widget", prNumber: 12 });
    expect(prUrlTarget("not a pull request")).toEqual({ repo: null, prNumber: null });
    expect(prUrlTarget(null)).toEqual({ repo: null, prNumber: null });
  });
  it("collects request, deliverable, project and PR URL repositories and every PR number", () => {
    const candidates = remoteOperationCandidates(
      task({ deliverableRepo: "Deliver/Repo", prNumber: 4, prUrl: "https://github.com/stored/repo/pull/5", project: { githubRepo: "Project/Repo" } }),
      { repos: ["Body/Repo", "not a repo", null], prNumbers: [6, null], prUrls: ["https://github.com/request/repo/pull/7"] },
    );
    expect([...candidates.repos].sort()).toEqual(["body/repo", "deliver/repo", "project/repo", "request/repo", "stored/repo"]);
    expect([...candidates.prNumbers].sort()).toEqual([4, 5, 6, 7]);
  });
});

describe("enforced remote operation guard", () => {
  it("fails closed when no scope is wired", async () => {
    expect(await isEnforcedRemoteOperation(untouchedDb, undefined, task())).toBe(true);
  });
  it("enforces an in-scope project without a repository before any query", async () => {
    expect(await isEnforcedRemoteOperation(untouchedDb, { projectIds: new Set(["project"]), repos: new Set() }, task())).toBe(true);
  });
  it("enforces a request-named repository that belongs to an enforced project", async () => {
    expect(await isEnforcedRemoteOperation(untouchedDb, { projectIds: new Set(), repos: new Set(["acme/widget"]) }, task(), { repos: ["ACME/widget"] })).toBe(true);
  });
  it("leaves a task with no candidate PR number to the legacy handler without a peer query", async () => {
    expect(await isEnforcedRemoteOperation(untouchedDb, { projectIds: new Set(), repos: new Set() }, task({ project: { githubRepo: "acme/widget" } }))).toBe(false);
  });
});

describe("scope wiring", () => {
  const service = Object.create(GroundingFinalizationService.prototype) as GroundingFinalizationService;
  const unscoped = { db: {} as PrismaClient, service } as unknown as GroundingTaskCompletionDependencies;
  it("refuses a completion service without an enforced scope", () => {
    expect(() => assertGroundingScopeWired(unscoped)).toThrow("Grounding completion service requires an enforced scope");
    expect(() => createGroundingTaskCompletionRouter(unscoped)).toThrow("Grounding completion service requires an enforced scope");
    expect(() => createGroundingGithubRouter(unscoped)).toThrow("Grounding completion service requires an enforced scope");
  });
  it("accepts a service with a scope and no service at all", () => {
    expect(() => assertGroundingScopeWired({ service, scope: { projectIds: new Set(), repos: new Set() } })).not.toThrow();
    expect(() => assertGroundingScopeWired({})).not.toThrow();
  });
});
