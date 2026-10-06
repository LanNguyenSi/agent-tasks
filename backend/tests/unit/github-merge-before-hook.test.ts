/**
 * `performPrMerge`'s `beforeGithubMerge` hook (agent-tasks eb08742f): the merge
 * paths take their merge reservation in it. It must run at the last point
 * before the irreversible GitHub call, so a merge that is refused earlier
 * never touches the task, and a refusal from the hook must stop the call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findDelegationUserMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: findDelegationUserMock,
}));
vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { performPrMerge, GITHUB_MERGE_TIMEOUT_MS, type MergeTask } from "../../src/services/github-merge.js";
import type { Actor } from "../../src/types/auth.js";
import { MERGE_RESERVATION_TTL_MS } from "../../src/services/task-merge-reservation.js";

const ACTOR: Actor = { type: "agent", tokenId: "agent-1", teamId: "team-1", userId: "owner", scopes: ["github:pr_merge"] };
const TASK: MergeTask = {
  id: "task-1",
  prNumber: 42,
  deliverableRepo: null,
  project: { id: "proj-1", teamId: "team-1", githubRepo: "acme/thing" },
};

const order: string[] = [];
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  findDelegationUserMock.mockResolvedValue({ userId: "u1", login: "delegate", githubAccessToken: "ghp_x" });
  fetchMock.mockImplementation(async () => {
    order.push("fetch");
    return new Response(JSON.stringify({ sha: "abc123", message: "merged", merged: true }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

const hook = () =>
  vi.fn(async () => {
    order.push("hook");
    return null;
  });

describe("beforeGithubMerge", () => {
  it("runs once, after every refusal that needs no GitHub call, and right before the fetch", async () => {
    const before = hook();
    const guard = vi.fn(async () => {
      order.push("guard");
      return null;
    });

    const result = await performPrMerge(TASK, "squash", ACTOR, guard, before);

    expect(result).toEqual({ ok: true, sha: "abc123", alreadyMerged: false });
    expect(before).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["guard", "hook", "fetch"]);
  });

  it("a refusal from the hook is returned as is and GitHub is never called", async () => {
    const refusal = { ok: false as const, error: "merge_in_progress" as const, message: "busy", status: 409 };

    const result = await performPrMerge(TASK, "squash", ACTOR, null, async () => refusal);

    expect(result).toBe(refusal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a foreign deliverable", { ...TASK, deliverableRepo: "other/repo" }, () => undefined],
    ["a project without a repository", { ...TASK, project: { ...TASK.project, githubRepo: null } }, () => undefined],
    ["a task without a PR number", { ...TASK, prNumber: null }, () => undefined],
    ["no delegation user", TASK, () => findDelegationUserMock.mockResolvedValue(null)],
  ])("does not run when the merge is refused before the GitHub call: %s", async (_label, task, arrange) => {
    arrange();
    const before = hook();

    const result = await performPrMerge(task, "squash", ACTOR, null, before);

    expect(result.ok).toBe(false);
    expect(before).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not run when the grounding effect-boundary guard refuses", async () => {
    const before = hook();
    const guard = vi.fn(async () => ({ error: "grounding_enrollment_required" as const, message: "no", status: 409 as const }));

    const result = await performPrMerge(TASK, "squash", ACTOR, guard, before);

    expect(result.ok).toBe(false);
    expect(before).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is optional: without a hook the merge goes straight to GitHub", async () => {
    const result = await performPrMerge(TASK, "squash", ACTOR, null);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("merge PUT timeout and unknown outcome", () => {
  it("sends the merge with an abort signal bounded by the timeout, which stays below the reservation lease", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await performPrMerge(TASK, "squash", ACTOR, null);

    expect(timeout).toHaveBeenCalledWith(GITHUB_MERGE_TIMEOUT_MS);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(GITHUB_MERGE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(GITHUB_MERGE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    expect(GITHUB_MERGE_TIMEOUT_MS).toBeLessThan(MERGE_RESERVATION_TTL_MS);
    timeout.mockRestore();
  });

  it.each([
    ["a timeout", () => new DOMException("The operation was aborted due to timeout", "TimeoutError")],
    ["a reset connection", () => new TypeError("fetch failed")],
  ])("marks the outcome unknown when the fetch ends with %s", async (_label, error) => {
    fetchMock.mockRejectedValue(error());

    const result = await performPrMerge(TASK, "squash", ACTOR, null);

    expect(result).toMatchObject({ ok: false, error: "github_error", status: 502, outcomeUnknown: true });
  });

  it("does not mark a refusal GitHub answered as unknown", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "Pull Request is not mergeable" }), { status: 405 }));

    const result = await performPrMerge(TASK, "squash", ACTOR, null);

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("outcomeUnknown");
  });
});
