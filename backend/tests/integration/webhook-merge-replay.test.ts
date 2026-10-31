/**
 * Replay of a merged-PR delivery through the legacy webhook handler against a
 * real database: an AUTONOMOUS project whose task was merged outside
 * agent-tasks (the task stayed in `review` with its work claim, or in
 * `in_progress`) is moved to `done`, its claims are cleared and the
 * `[webhook]` timeline comment is written. The same delivery against a
 * confirmation-required project keeps the review gate.
 *
 * The second half covers the diagnostics of a merged delivery that matched
 * nothing: the handler logs a warning naming the repo and the PR number and
 * writes a `pr_merged_unmatched` audit row, so a green delivery that did not
 * move a task leaves a trace.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

import { handlePullRequestEvent, type GitHubPullRequestPayload } from "../../src/services/github-webhook.js";
import { logger } from "../../src/lib/logger.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let userId: string;
let teamId: string;
let projectId: string;
let repo: string;
let warn: ReturnType<typeof vi.spyOn>;

const NO_CLAIMS = {
  claimedByUserId: null,
  claimedByAgentId: null,
  claimedAt: null,
  reviewClaimedByUserId: null,
  reviewClaimedByAgentId: null,
  reviewClaimedAt: null,
};

beforeAll(async () => {
  store = await groundingPostgres();
  db = store.db;
  shared.db = db;
}, 60000);

afterAll(async () => {
  if (store) await store.close();
});

beforeEach(async () => {
  warn = vi.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
  userId = randomUUID();
  await db.user.create({ data: { id: userId, login: `u-${userId}` } });
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Merge replay", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  repo = `LanNguyenSi/depsight-${randomUUID().slice(0, 8)}`;
  projectId = await project({ governanceMode: "AUTONOMOUS", soloMode: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function project(data: Record<string, unknown>, githubRepo: string = repo) {
  const id = randomUUID();
  await db.project.create({ data: { id, teamId, name: `P ${id.slice(0, 8)}`, slug: randomUUID(), githubRepo, ...data } });
  return id;
}

async function task(status: string, overrides: Record<string, unknown> = {}, forProject: string = projectId) {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      projectId: forProject,
      title: `Task ${id.slice(0, 8)}`,
      status,
      claimedByUserId: userId,
      claimedAt: new Date(),
      createdByUserId: userId,
      ...overrides,
    },
  });
  return id;
}

/** The shape GitHub sends for a merged PR of the depsight repo, with the fields the handler ignores left in. */
function mergedDelivery(number: number, fullName: string = repo, branch = "fix/age-report"): GitHubPullRequestPayload {
  return {
    action: "closed",
    number,
    pull_request: {
      url: `https://api.github.com/repos/${fullName}/pulls/${number}`,
      id: 1_900_000_000 + number,
      number,
      state: "closed",
      title: "fix(deps): age report per lockfile",
      body: "Closes the age report gap.",
      html_url: `https://github.com/${fullName}/pull/${number}`,
      merged: true,
      merged_at: "2026-10-30T09:12:44Z",
      merged_by: { login: "LanNguyenSi", type: "User" },
      head: { ref: branch, sha: "a".repeat(40) },
      base: { ref: "master" },
    },
    repository: { id: 7, name: "depsight", full_name: fullName },
    sender: { login: "LanNguyenSi" },
  } as unknown as GitHubPullRequestPayload;
}

const unmatchedAudit = (where: Record<string, unknown> = {}) =>
  db.auditLog.findMany({ where: { action: "task.reviewed", payload: { path: ["event"], equals: "pr_merged_unmatched" }, ...where } });

describe("merged PR replay on an AUTONOMOUS project", () => {
  it.each([
    ["review", "a task in review that still holds its work claim"],
    ["in_progress", "a task in in_progress"],
  ])("moves %s to done, clears the claims and writes the [webhook] comment (%s)", async (status) => {
    const id = await task(status, {
      prNumber: 214,
      prUrl: `https://github.com/${repo}/pull/214`,
      branchName: "fix/age-report",
      ...(status === "review" ? { reviewClaimedByUserId: userId, reviewClaimedAt: new Date() } : {}),
    });

    await handlePullRequestEvent(mergedDelivery(214));

    const row = await db.task.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "done", ...NO_CLAIMS });
    const comments = await db.comment.findMany({ where: { taskId: id } });
    expect(comments.map((c) => c.content)).toEqual(["[webhook] PR #214 merged by LanNguyenSi"]);
    const transitions = await db.auditLog.findMany({ where: { taskId: id, action: "task.transitioned" } });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.payload).toMatchObject({ event: "pr_merged", from: status, to: "done", merged_by: "LanNguyenSi" });
    expect(await unmatchedAudit()).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("finds the task by branch name alone, as a task whose PR was never recorded", async () => {
    const id = await task("in_progress", { branchName: "fix/age-report" });

    await handlePullRequestEvent(mergedDelivery(215));

    expect(await db.task.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "done", ...NO_CLAIMS });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not touch a task of another PR in the same project (the delivery is then unmatched, not applied to it)", async () => {
    const other = await task("review", { prNumber: 99, prUrl: `https://github.com/${repo}/pull/99`, branchName: "other" });

    await handlePullRequestEvent(mergedDelivery(214));

    expect(await db.task.findUniqueOrThrow({ where: { id: other } })).toMatchObject({ status: "review", claimedByUserId: userId });
  });
});

describe("merged PR replay on a confirmation-required project keeps the review gate", () => {
  it("hands in_progress to review and leaves review in review, claims kept", async () => {
    const gated = await project({ governanceMode: "AWAITS_CONFIRMATION", soloMode: false }, repo + "-gated");
    const working = await task("in_progress", { prNumber: 214 }, gated);
    const reviewing = await task("review", { prNumber: 215 }, gated);

    await handlePullRequestEvent(mergedDelivery(214, repo + "-gated"));
    await handlePullRequestEvent(mergedDelivery(215, repo + "-gated"));

    expect(await db.task.findUniqueOrThrow({ where: { id: working } })).toMatchObject({ status: "review", claimedByUserId: userId });
    expect(await db.task.findUniqueOrThrow({ where: { id: reviewing } })).toMatchObject({ status: "review", claimedByUserId: userId });
  });
});

describe("a merged delivery that matched nothing leaves a trace", () => {
  it("repo bound to no project: a warn with repo and PR number and a project-less audit row", async () => {
    const unbound = `LanNguyenSi/unbound-${randomUUID().slice(0, 8)}`;

    await handlePullRequestEvent(mergedDelivery(77, unbound));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ repo: unbound, prNumber: 77, reason: "no_project", event: "pr_merged_unmatched" });
    const rows = await unmatchedAudit({ payload: { path: ["repo"], equals: unbound } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: null, taskId: null });
    expect(rows[0]!.payload).toMatchObject({ source: "github_webhook", event: "pr_merged_unmatched", pr_number: 77, repo: unbound, reason: "no_project" });
  });

  it("repo bound to a project but no task carries the PR: a warn and an audit row on that project", async () => {
    await handlePullRequestEvent(mergedDelivery(88));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ repo, prNumber: 88, reason: "no_task", projectId });
    const rows = await unmatchedAudit({ projectId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ pr_number: 88, repo, reason: "no_task" });
  });

  it("a task bound to the PR that is already done is the echo of an earlier merge: no warn, no audit row", async () => {
    await task("done", { prNumber: 88, claimedByUserId: null, claimedAt: null });

    await handlePullRequestEvent(mergedDelivery(88));

    expect(warn).not.toHaveBeenCalled();
    expect(await unmatchedAudit({ projectId })).toHaveLength(0);
  });

  it("a PR closed without merge that matches nothing writes no unmatched-merge diagnostics (bound and unbound repo)", async () => {
    const unbound = `LanNguyenSi/unbound-${randomUUID().slice(0, 8)}`;
    for (const fullName of [repo, unbound]) {
      const closed = mergedDelivery(88, fullName);
      (closed.pull_request as { merged: boolean }).merged = false;
      await handlePullRequestEvent(closed);
    }

    expect(warn).not.toHaveBeenCalled();
    expect(await unmatchedAudit({ projectId })).toHaveLength(0);
    expect(await unmatchedAudit({ payload: { path: ["repo"], equals: unbound } })).toHaveLength(0);
  });
});
