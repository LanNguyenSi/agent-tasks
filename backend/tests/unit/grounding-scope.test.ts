import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Context } from "hono";
vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/config/index.js", () => ({ config: { NODE_ENV: "test", SESSION_SECRET: "test-secret-which-is-long-enough-1234", TRUSTED_PROXY_HOPS: 0 } }));
import { createGroundingRemoteTargetGuard, exactGithubRepo, groundingProjectEnforced, groundingRemoteGuardFor, groundingRemoteTargetRefusal, type GroundingEnforcedScope, type GroundingRemoteTarget } from "../../src/services/grounding-scope.js";
import { assertGroundingScopeWired, createGroundingTaskCompletionRouter, type GroundingTaskCompletionDependencies } from "../../src/routes/grounding-task-completion.js";
import { createGroundingGithubRouter } from "../../src/routes/grounding-github.js";
import { GroundingFinalizationService } from "../../src/services/grounding-finalization.js";
import type { AppVariables } from "../../src/types/hono.js";

/** A database that fails the test if the guard ever queries it. */
const untouchedDb = new Proxy({}, { get: () => { throw new Error("database must not be queried"); } }) as unknown as PrismaClient;
const emptyScope: GroundingEnforcedScope = { projectIds: new Set(), repos: new Set() };
const target = (overrides: Partial<GroundingRemoteTarget> = {}): GroundingRemoteTarget => ({ repo: "acme/widget", prNumber: 7, kind: "merge", taskId: "task", ...overrides });
/** A database whose single boundary statement answers with the given flags. */
function answering(row: { peer: boolean; fenced: boolean } | undefined) {
  const $queryRaw = vi.fn(async (..._args: unknown[]) => (row ? [row] : []));
  return { db: { $queryRaw } as unknown as PrismaClient, $queryRaw };
}
/** The values bound into the boundary statement (a tagged template call), in order. */
const bound = ($queryRaw: ReturnType<typeof answering>["$queryRaw"]) => ($queryRaw.mock.calls[0] ?? []).slice(1);

describe("exact repository identity at the effect boundary", () => {
  it.each(["acme/widget", "Acme/Widget", "a.b-c_d/e.f-g_h"])("accepts the canonical identity %s", raw => {
    expect(exactGithubRepo(raw)).toBe(raw.toLowerCase());
  });
  it.each([
    ["a dot segment", "acme/widget/."], ["an owner containing '/'", "acme/widget/x"], ["a percent-encoded name", "acme/%77idget"],
    ["a parent segment", "acme/.."], ["surrounding whitespace", " acme/widget"], ["trailing whitespace", "acme/widget "], ["an empty string", ""], ["no owner", "widget"],
  ])("rejects %s", (_label, raw) => {
    expect(exactGithubRepo(raw)).toBeNull();
  });
});

describe("effect-boundary refusal", () => {
  it("refuses every target when no scope is wired, before any query", async () => {
    expect(await groundingRemoteTargetRefusal(untouchedDb, undefined, target())).toMatchObject({ error: "grounding_enrollment_required", status: 409 });
  });
  it.each(["acme/%77idget", "acme/widget/.", " acme/widget"])("refuses the non-canonical repository %s before any query, even with an empty scope", async repo => {
    for (const kind of ["merge", "create", "comment"] as const) {
      expect(await groundingRemoteTargetRefusal(untouchedDb, emptyScope, target({ repo, kind }))).toMatchObject({ error: "grounding_enrollment_required", status: 409 });
    }
  });
  it("refuses a repository an enforced project owns, in any casing, before any query", async () => {
    const scope: GroundingEnforcedScope = { projectIds: new Set(), repos: new Set(["acme/widget"]) };
    for (const kind of ["merge", "create", "comment"] as const) {
      expect(await groundingRemoteTargetRefusal(untouchedDb, scope, target({ repo: "ACME/Widget", kind }))).toMatchObject({ error: "grounding_enrollment_required" });
    }
  });
  it("refuses a peer's PR as enrollment required, ahead of an owned fence", async () => {
    const { db } = answering({ peer: true, fenced: true });
    expect(await groundingRemoteTargetRefusal(db, emptyScope, target())).toMatchObject({ error: "grounding_enrollment_required", status: 409 });
  });
  it("refuses an owned fence as finalization pending", async () => {
    const { db } = answering({ peer: false, fenced: true });
    expect(await groundingRemoteTargetRefusal(db, emptyScope, target())).toMatchObject({ error: "grounding_finalization_pending", status: 409 });
  });
  it("lets a target with neither a peer nor an owned fence through", async () => {
    const { db } = answering({ peer: false, fenced: false });
    expect(await groundingRemoteTargetRefusal(db, emptyScope, target())).toBeNull();
  });
  it("fails closed when the boundary statement returns no row", async () => {
    const { db } = answering(undefined);
    expect(await groundingRemoteTargetRefusal(db, emptyScope, target())).toMatchObject({ error: "grounding_enrollment_required" });
  });
  it("reads peer and fence in one statement, binding the canonical repository, the exact PR number and the fence flag", async () => {
    const merge = answering({ peer: false, fenced: false });
    await groundingRemoteTargetRefusal(merge.db, emptyScope, target({ repo: "Acme/Widget", prNumber: 12 }));
    expect(merge.$queryRaw).toHaveBeenCalledOnce();
    expect(bound(merge.$queryRaw)).toEqual(expect.arrayContaining(["acme/widget", "12", true]));
    const comment = answering({ peer: false, fenced: false });
    await groundingRemoteTargetRefusal(comment.db, emptyScope, target({ kind: "comment" }));
    expect(bound(comment.$queryRaw)).toContain(false);
    expect(bound(comment.$queryRaw)).not.toContain(true);
    const create = answering({ peer: false, fenced: false });
    await groundingRemoteTargetRefusal(create.db, emptyScope, target({ kind: "create", prNumber: undefined }));
    expect(bound(create.$queryRaw)).toContain(null);
    expect(bound(create.$queryRaw)).toContain(true);
  });
  it("binds the guard to its scope and database", async () => {
    const { db, $queryRaw } = answering({ peer: false, fenced: true });
    const guard = createGroundingRemoteTargetGuard({ db, scope: emptyScope });
    expect(await guard(target())).toMatchObject({ error: "grounding_finalization_pending" });
    expect($queryRaw).toHaveBeenCalledOnce();
    expect(await createGroundingRemoteTargetGuard({ db: untouchedDb, scope: undefined })(target())).toMatchObject({ error: "grounding_enrollment_required" });
  });
});

describe("project enforcement", () => {
  it("enforces a scoped project and every project without a scope", () => {
    expect(groundingProjectEnforced({ projectIds: new Set(["p"]), repos: new Set() }, "p")).toBe(true);
    expect(groundingProjectEnforced({ projectIds: new Set(["p"]), repos: new Set() }, "q")).toBe(false);
    expect(groundingProjectEnforced(undefined, "q")).toBe(true);
  });
});

describe("guard wiring", () => {
  const context = (slot: Record<string, unknown>) => ({ get: (key: string) => slot[key] }) as unknown as Context<{ Variables: AppVariables }>;
  it("returns the installed guard, or null in the unconfigured application", () => {
    const guard = vi.fn(async () => null);
    expect(groundingRemoteGuardFor(context({ groundingRemoteTargetGuard: guard }))).toBe(guard);
    expect(groundingRemoteGuardFor(context({ groundingRemoteTargetGuard: null }))).toBeNull();
  });
  it("fails closed for a legacy handler mounted without the application's wiring", async () => {
    const guard = groundingRemoteGuardFor(context({}));
    expect(guard).toBeTypeOf("function");
    await expect(guard!(target())).rejects.toThrow("Grounding remote target guard is not wired");
  });
  const service = Object.create(GroundingFinalizationService.prototype) as GroundingFinalizationService;
  const remoteGuard = async () => null;
  it("refuses a completion service without an enforced scope", () => {
    const unscoped = { db: {} as PrismaClient, service, remoteGuard } as unknown as GroundingTaskCompletionDependencies;
    expect(() => assertGroundingScopeWired(unscoped)).toThrow("Grounding completion service requires an enforced scope");
    expect(() => createGroundingTaskCompletionRouter(unscoped)).toThrow("Grounding completion service requires an enforced scope");
    expect(() => createGroundingGithubRouter(unscoped)).toThrow("Grounding completion service requires an enforced scope");
  });
  it("refuses a completion service without a remote target guard", () => {
    const unguarded = { db: {} as PrismaClient, service, scope: emptyScope } as unknown as GroundingTaskCompletionDependencies;
    expect(() => assertGroundingScopeWired(unguarded)).toThrow("Grounding completion service requires a remote target guard");
    expect(() => createGroundingTaskCompletionRouter(unguarded)).toThrow("Grounding completion service requires a remote target guard");
    expect(() => createGroundingGithubRouter(unguarded)).toThrow("Grounding completion service requires a remote target guard");
  });
  it("accepts a service with a scope and a guard, and no service at all", () => {
    expect(() => assertGroundingScopeWired({ service, scope: emptyScope, remoteGuard })).not.toThrow();
    expect(() => assertGroundingScopeWired({})).not.toThrow();
  });
});
