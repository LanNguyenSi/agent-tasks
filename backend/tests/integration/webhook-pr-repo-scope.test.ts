/**
 * PR lookup (number, branch and title arms) of the legacy GitHub webhook against a real database.
 *
 * PR numbers repeat across repositories and one project can hold tasks that
 * deliver into several repos (`deliverableRepo`). A delivery from repo A must
 * only match, by PR number, branch name or `[PR #N]` title (not by the exact
 * prUrl), the tasks whose PR lives in repo A: the task's
 * `deliverableRepo` when set (compared case-insensitively and literally),
 * otherwise the project's own repo.
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

import {
  findTasksByPr,
  handlePullRequestEvent,
  handlePullRequestReviewEvent,
  type GitHubPullRequestPayload,
  type GitHubPullRequestReviewPayload,
} from "../../src/services/github-webhook.js";
import { logger } from "../../src/lib/logger.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let userId: string;
let teamId: string;
let projectId: string;
let repoA: string;
let repoB: string;
let warn: ReturnType<typeof vi.spyOn>;

const PR = 42;

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
  await db.team.create({ data: { id: teamId, name: "PR repo scope", slug: randomUUID() } });
  await db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  const suffix = randomUUID().slice(0, 8);
  repoA = `Acme/Main-${suffix}`;
  repoB = `Acme/Other-${suffix}`;
  projectId = randomUUID();
  await db.project.create({
    data: { id: projectId, teamId, name: `P ${suffix}`, slug: randomUUID(), githubRepo: repoA, governanceMode: "AUTONOMOUS", soloMode: true },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function task(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.task.create({
    data: { id, projectId, title: `Task ${id.slice(0, 8)}`, status: "in_progress", createdByUserId: userId, prNumber: PR, ...overrides },
  });
  return id;
}

function mergedDelivery(fullName: string, number = PR, extra: { ref?: string; title?: string } = {}): GitHubPullRequestPayload {
  return {
    action: "closed",
    pull_request: {
      number,
      state: "closed",
      title: extra.title ?? "work",
      body: null,
      html_url: `https://github.com/${fullName}/pull/${number}`,
      merged: true,
      merged_by: { login: "merger" },
      head: { ref: extra.ref ?? `branch-${randomUUID().slice(0, 8)}` },
    },
    repository: { full_name: fullName },
  } as GitHubPullRequestPayload;
}

const statusOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).status;
const unmatched = () =>
  db.auditLog.findMany({ where: { projectId, action: "task.reviewed", payload: { path: ["event"], equals: "pr_merged_unmatched" } } });

describe("findTasksByPr: the prNumber arm is scoped to the delivery's repo", () => {
  it("same PR number in two repos of one project: only the task of the delivery's repo is found", async () => {
    const inA = await task({ deliverableRepo: null });
    const inB = await task({ deliverableRepo: repoB });

    expect((await findTasksByPr(projectId, { prNumber: PR }, repoA)).map((t) => t.id)).toEqual([inA]);
    // A null deliverableRepo means "the project's own repo"; the handler only asks about
    // projects bound to the delivery's repo, so repo B is exercised with the task bound to B.
    expect((await findTasksByPr(projectId, { prNumber: PR }, repoB)).map((t) => t.id)).toContain(inB);
  });

  it("a task with deliverableRepo null matches the project's own repo", async () => {
    const id = await task({ deliverableRepo: null });
    expect((await findTasksByPr(projectId, { prNumber: PR }, repoA)).map((t) => t.id)).toEqual([id]);
  });

  it("a task with deliverableRepo equal to the project's repo matches it", async () => {
    const id = await task({ deliverableRepo: repoA });
    expect((await findTasksByPr(projectId, { prNumber: PR }, repoA)).map((t) => t.id)).toEqual([id]);
  });

  it("owner/name case differences between the stored deliverableRepo and the delivery do not matter", async () => {
    const id = await task({ deliverableRepo: repoB });
    expect((await findTasksByPr(projectId, { prNumber: PR }, repoB.toLowerCase())).map((t) => t.id)).toEqual([id]);
    expect((await findTasksByPr(projectId, { prNumber: PR }, repoB.toUpperCase())).map((t) => t.id)).toEqual([id]);
  });

  it("the compare is literal: an underscore in the delivery's repo does not match a hyphen", async () => {
    await task({ deliverableRepo: "acme/my-repo" });
    expect(await findTasksByPr(projectId, { prNumber: PR }, "acme/my_repo")).toEqual([]);
  });

  it("branch arm: a task of another repo is not found, a null or equal-repo task is, case-insensitively", async () => {
    const other = await task({ prNumber: null, branchName: "feat/scope", deliverableRepo: repoB });
    const own = await task({ prNumber: null, branchName: "feat/scope", deliverableRepo: null });
    const equal = await task({ prNumber: null, branchName: "feat/scope", deliverableRepo: repoA.toLowerCase() });

    const found = (await findTasksByPr(projectId, { prNumber: PR + 1, headBranch: "feat/scope" }, repoA)).map((t) => t.id);
    expect(found).not.toContain(other);
    expect(found.sort()).toEqual([own, equal].sort());
  });

  it("title arm: a task of another repo is not found, a null or equal-repo task is, case-insensitively", async () => {
    const title = `[PR #${PR}] work`;
    const other = await task({ prNumber: null, title, deliverableRepo: repoB });
    const own = await task({ prNumber: null, title, deliverableRepo: null });
    const equal = await task({ prNumber: null, title, deliverableRepo: repoA.toUpperCase() });

    const found = (await findTasksByPr(projectId, { prNumber: PR }, repoA)).map((t) => t.id);
    expect(found).not.toContain(other);
    expect(found.sort()).toEqual([own, equal].sort());
  });

  it("prUrl arm stays unscoped: a full PR URL is repo-specific, so it matches whatever the deliverableRepo", async () => {
    const byUrl = await task({ prNumber: null, prUrl: "https://github.com/x/y/pull/7", deliverableRepo: repoB });
    const found = await findTasksByPr(projectId, { prNumber: PR + 1, prUrl: "https://github.com/x/y/pull/7" }, repoA);
    expect(found.map((t) => t.id)).toEqual([byUrl]);
  });
});

describe("a merged delivery moves only the task bound to the PR in its own repo", () => {
  it("repo A's merge moves A's task and leaves the task with the same number in repo B alone", async () => {
    const inA = await task({ deliverableRepo: null });
    const inB = await task({ deliverableRepo: repoB });

    await handlePullRequestEvent(mergedDelivery(repoA));

    expect(await statusOf(inA)).toBe("done");
    expect(await statusOf(inB)).toBe("in_progress");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a delivery whose only same-number task lives in another repo is unmatched", async () => {
    const inB = await task({ deliverableRepo: repoB });

    await handlePullRequestEvent(mergedDelivery(repoA));

    expect(await statusOf(inB)).toBe("in_progress");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ reason: "no_task", prNumber: PR });
    expect(await unmatched()).toHaveLength(1);
  });

  it("a reused branch name in repo A does not move the task of repo B, but moves the task of repo A", async () => {
    const inB = await task({ prNumber: null, branchName: "feat/reused", deliverableRepo: repoB });
    const inA = await task({ prNumber: null, branchName: "feat/reused", deliverableRepo: null });

    await handlePullRequestEvent(mergedDelivery(repoA, PR + 5, { ref: "feat/reused" }));

    expect(await statusOf(inB)).toBe("in_progress");
    expect(await statusOf(inA)).toBe("done");
  });

  it("a [PR #N] title in repo A's delivery does not move the task of repo B, but moves the task of repo A", async () => {
    const inB = await task({ prNumber: null, title: `[PR #${PR + 6}] work`, deliverableRepo: repoB });
    const inA = await task({ prNumber: null, title: `[PR #${PR + 6}] work`, deliverableRepo: null });

    await handlePullRequestEvent(mergedDelivery(repoA, PR + 6));

    expect(await statusOf(inB)).toBe("in_progress");
    expect(await statusOf(inA)).toBe("done");
  });

  it("the delivery's repo in another letter case still moves the null and the equal-repo task", async () => {
    const inNull = await task({ deliverableRepo: null });
    const inEqual = await task({ deliverableRepo: repoA.toLowerCase() });

    await handlePullRequestEvent(mergedDelivery(repoA.toUpperCase()));

    expect(await statusOf(inNull)).toBe("done");
    expect(await statusOf(inEqual)).toBe("done");
  });

  it("echo of an earlier merge is unchanged: a done task of the delivery's repo is silent, one of another repo is unmatched", async () => {
    await task({ status: "done", deliverableRepo: null });
    await handlePullRequestEvent(mergedDelivery(repoA));
    expect(warn).not.toHaveBeenCalled();
    expect(await unmatched()).toHaveLength(0);

    const other = await db.project.create({
      data: { id: randomUUID(), teamId, name: "Other", slug: randomUUID(), githubRepo: `Acme/Third-${randomUUID().slice(0, 8)}`, soloMode: true },
    });
    await db.task.create({
      data: { id: randomUUID(), projectId: other.id, title: "t", status: "done", createdByUserId: userId, prNumber: PR, deliverableRepo: repoB },
    });
    await handlePullRequestEvent(mergedDelivery(other.githubRepo!));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("the delivery's repo reaches every other findTasksByPr call site", () => {
  const commentsOf = async (id: string) => (await db.comment.findMany({ where: { taskId: id } })).map((c) => c.content);

  it("opened: a task with the equal repo is found by prNumber alone and gets the url and branch backfilled", async () => {
    const inA = await task({ deliverableRepo: repoA.toLowerCase() });
    const inB = await task({ deliverableRepo: repoB });
    const delivery = { ...mergedDelivery(repoA.toUpperCase()), action: "opened" } as GitHubPullRequestPayload;
    delivery.pull_request.merged = false;

    await handlePullRequestEvent(delivery);

    expect(await db.task.findUniqueOrThrow({ where: { id: inA } })).toMatchObject({
      prUrl: delivery.pull_request.html_url,
      branchName: delivery.pull_request.head!.ref,
    });
    expect(await db.task.findUniqueOrThrow({ where: { id: inB } })).toMatchObject({ prUrl: null, branchName: null });
  });

  it("closed without merge: the timeline entry goes only to the task of the delivery's repo", async () => {
    const inA = await task({ deliverableRepo: repoA.toLowerCase() });
    const inB = await task({ deliverableRepo: repoB });
    const delivery = mergedDelivery(repoA.toUpperCase());
    delivery.pull_request.merged = false;

    await handlePullRequestEvent(delivery);

    expect(await commentsOf(inA)).toEqual([`[webhook] PR #${PR} closed without merge`]);
    expect(await commentsOf(inB)).toEqual([]);
    expect(await statusOf(inA)).toBe("in_progress");
  });

  it("pull_request_review changes_requested: only the task of the delivery's repo moves review -> in_progress", async () => {
    const inA = await task({ status: "review", deliverableRepo: repoA.toLowerCase() });
    const inB = await task({ status: "review", deliverableRepo: repoB });
    const review = {
      action: "submitted",
      review: { state: "changes_requested", user: { login: "rev" }, html_url: "https://github.com/x" },
      pull_request: { number: PR, title: "work", html_url: `https://github.com/${repoA}/pull/${PR}`, head: { ref: "some-branch" } },
      repository: { full_name: repoA.toUpperCase() },
    } as GitHubPullRequestReviewPayload;

    await handlePullRequestReviewEvent(review);

    expect(await statusOf(inA)).toBe("in_progress");
    expect(await statusOf(inB)).toBe("review");
    expect(await commentsOf(inB)).toEqual([]);
  });
});
