import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
import { candidateRepositoryFenceOwned, isEnforcedRemoteOperation, prUrlTarget, remoteOperationCandidates, type GroundingScopeTask } from "../../src/services/grounding-scope.js";
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
    expect(prUrlTarget("https://github.com/Acme/Widget/pull/12")).toEqual({ repo: "acme/widget", prNumber: 12, unresolved: false });
    expect(prUrlTarget("https://github.com/acme/widget/pull/12/files")).toEqual({ repo: "acme/widget", prNumber: 12, unresolved: false });
    expect(prUrlTarget("not a pull request")).toEqual({ repo: null, prNumber: null, unresolved: false });
    expect(prUrlTarget(null)).toEqual({ repo: null, prNumber: null, unresolved: false });
  });
  it("marks a PR URL whose repository is not a canonical identity as unresolved", () => {
    expect(prUrlTarget("https://github.com/acme/%77idget/pull/12")).toEqual({ repo: null, prNumber: 12, unresolved: true });
    expect(prUrlTarget("https://github.com/acme/../pull/12")).toEqual({ repo: null, prNumber: 12, unresolved: true });
  });
  it("collects request, deliverable, project and PR URL repositories and every PR number", () => {
    const candidates = remoteOperationCandidates(
      task({ deliverableRepo: "Deliver/Repo", prNumber: 4, prUrl: "https://github.com/stored/repo/pull/5", project: { githubRepo: "Project/Repo" } }),
      { repos: ["Body/Repo", "", null], prNumbers: [6, null], prUrls: ["https://github.com/request/repo/pull/7"] },
    );
    expect([...candidates.repos].sort()).toEqual(["body/repo", "deliver/repo", "project/repo", "request/repo", "stored/repo"]);
    expect([...candidates.prNumbers].sort()).toEqual([4, 5, 6, 7]);
    expect(candidates.unresolved).toBe(false);
  });
  it.each([
    ["a request repository with a dot segment", { targets: { repos: ["acme/widget/."] } }],
    ["a request owner containing '/'", { targets: { repos: ["acme/widget/x"] } }],
    ["a percent-encoded request repository", { targets: { repos: ["acme/%77idget"] } }],
    ["a dot-segment request repository", { targets: { repos: ["acme/.."] } }],
    ["a percent-encoded deliverable repository", { task: { deliverableRepo: "acme/%77idget" } }],
    ["a percent-encoded project repository", { task: { project: { githubRepo: "acme/%77idget" } } }],
    ["a stored PR URL with a percent-encoded repository", { task: { prUrl: "https://github.com/acme/%77idget/pull/3" } }],
    ["a request PR URL with a dot-segment repository", { targets: { prUrls: ["https://github.com/acme/./pull/3"] } }],
  ] as [string, { task?: Partial<GroundingScopeTask>; targets?: Parameters<typeof remoteOperationCandidates>[1] }][])("marks %s as unresolved", (_label, input) => {
    expect(remoteOperationCandidates(task(input.task), input.targets).unresolved).toBe(true);
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
  it.each([
    ["request", task(), { repos: ["acme/%77idget"] }],
    ["deliverable", task({ deliverableRepo: "acme/widget/." }), {}],
    ["project", task({ project: { githubRepo: "acme/%77idget" } }), {}],
    ["PR URL", task(), { prUrls: ["https://github.com/acme/%77idget/pull/3"] }],
  ] as const)("fails closed on a non-canonical %s repository before any query, even with an empty scope", async (_label, input, targets) => {
    expect(await isEnforcedRemoteOperation(untouchedDb, { projectIds: new Set(), repos: new Set() }, input, targets)).toBe(true);
  });
  it("leaves a task with no candidate PR number to the legacy handler without a peer query", async () => {
    expect(await isEnforcedRemoteOperation(untouchedDb, { projectIds: new Set(), repos: new Set() }, task({ project: { githubRepo: "acme/widget" } }))).toBe(false);
  });
});

describe("candidate repository fence", () => {
  it("does not query without a candidate repository", async () => {
    expect(await candidateRepositoryFenceOwned(untouchedDb, task())).toBe(false);
  });
  it("reports an owned fence on any canonical candidate repository", async () => {
    const findFirst = vi.fn(async () => ({ repo: "acme/widget" }));
    const db = { groundingGithubRepositoryFence: { findFirst } } as unknown as PrismaClient;
    expect(await candidateRepositoryFenceOwned(db, task({ project: { githubRepo: "Acme/Widget" } }), { repos: ["Other/Repo"] })).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({ where: { repo: { in: ["other/repo", "acme/widget"] }, ownerId: { not: null } }, select: { repo: true } });
    findFirst.mockResolvedValueOnce(null as never);
    expect(await candidateRepositoryFenceOwned(db, task({ project: { githubRepo: "acme/widget" } }))).toBe(false);
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
