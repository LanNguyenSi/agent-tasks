/**
 * Direct unit tests for `performPrMerge`'s foreign-deliverable hard
 * refusal (ADR-0010 §5c). Route-level "does the caller map the refusal to
 * the right HTTP status" wiring is covered separately in
 * deliverable-repo-routes.test.ts (with `performPrMerge` mocked); this file
 * exercises the REAL function so the refusal logic itself is pinned.
 *
 * Per the project feedback memory: prefer `mockResolvedValue` over stacked
 * `mockResolvedValueOnce` queues (not drained by `vi.clearAllMocks`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findDelegationUserMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: findDelegationUserMock,
}));

const logAuditEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: logAuditEventMock,
}));

import { performPrMerge, type MergeTask } from "../../src/services/github-merge.js";
import type { Actor } from "../../src/types/auth.js";

const ACTOR: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  userId: "agent-owner",
  scopes: ["github:pr_merge"],
};

const SAME_REPO_TASK: MergeTask = {
  id: "task-1",
  prNumber: 42,
  deliverableRepo: null,
  project: { id: "proj-1", teamId: "team-1", githubRepo: "acme/thing" },
};

const FOREIGN_TASK: MergeTask = {
  id: "task-2",
  prNumber: 7,
  deliverableRepo: "foreign-org/foreign-repo",
  project: { id: "proj-1", teamId: "team-1", githubRepo: "acme/thing" },
};

const NOOP_OVERRIDE_TASK: MergeTask = {
  id: "task-3",
  prNumber: 7,
  deliverableRepo: "acme/thing",
  project: { id: "proj-1", teamId: "team-1", githubRepo: "acme/thing" },
};

beforeEach(() => {
  vi.clearAllMocks();
  findDelegationUserMock.mockResolvedValue({
    userId: "u1",
    login: "delegate",
    githubAccessToken: "ghp_delegate",
  });
});

describe("performPrMerge — foreign-deliverable hard refusal", () => {
  it("refuses with 409 foreign_deliverable_merge_refused when deliverableRepo diverges from project.githubRepo", async () => {
    const result = await performPrMerge(FOREIGN_TASK, "squash", ACTOR);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("foreign_deliverable_merge_refused");
      expect(result.status).toBe(409);
      expect(result.message).toContain("foreign-org/foreign-repo");
    }
    // Refuses BEFORE any GitHub delegation lookup or API call.
    expect(findDelegationUserMock).not.toHaveBeenCalled();
  });

  it("does not refuse a task with no deliverableRepo override (unchanged behavior)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sha: "abc123", merged: true }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await performPrMerge(SAME_REPO_TASK, "squash", ACTOR);
    expect(result.ok).toBe(true);

    globalThis.fetch = originalFetch;
  });

  it("treats a deliverableRepo equal to project.githubRepo as a harmless no-op (does not refuse)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sha: "abc123", merged: true }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await performPrMerge(NOOP_OVERRIDE_TASK, "squash", ACTOR);
    expect(result.ok).toBe(true);

    globalThis.fetch = originalFetch;
  });

  // Mutation sanity check (per task brief): with the refusal removed, this
  // exact test would fail because performPrMerge would proceed to resolve
  // delegation / call GitHub for a task whose PR lives in a repo this
  // project has no business touching.
  it("[mutation guard] a foreign task never reaches delegation resolution", async () => {
    await performPrMerge(FOREIGN_TASK, "squash", ACTOR);
    expect(findDelegationUserMock).not.toHaveBeenCalled();
  });
});
