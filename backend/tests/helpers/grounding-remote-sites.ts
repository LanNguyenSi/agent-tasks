import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { vi } from "vitest";
import { ids } from "./grounding-fixtures.js";
import { GROUNDING_POLICY } from "../../src/services/grounding-context.js";

/**
 * The seven legacy handlers that write to GitHub: five merge sites (all
 * through performPrMerge), the PR creator and the PR commenter.
 */
export const mergeSites = ["github-merge", "task-merge", "review-finish", "self-approve", "work-finish"] as const;
export const remoteSites = [...mergeSites, "create", "comment"] as const;
export type RemoteSite = (typeof remoteSites)[number];

/** Strictly increasing PR numbers: the alias-peer check matches by number alone. */
let nextPr = 300000;
export const uniquePr = () => ++nextPr;
export const canonicalRepo = () => `acme/r${randomUUID().replaceAll("-", "")}`;
/** The same repository with its name's first character percent-encoded. */
export const aliasOf = (repo: string) => { const [owner, name] = repo.split("/"); return `${owner}/%${name!.charCodeAt(0).toString(16)}${name!.slice(1)}`; };

/**
 * An unprovisioned task in its own project, in the state its site's legacy
 * gates accept, so the request reaches the handler's effect boundary: done
 * for the GitHub and task merges, review-claimed for the review finish,
 * work-claimed in review for the self-approve finish, work-claimed in
 * progress for the work finish, in an AUTONOMOUS project for the finishes.
 */
export async function requesterTask(db: PrismaClient, site: RemoteSite, repo: string, prNumber: number | null) {
  const projectId = randomUUID(); const taskId = randomUUID();
  const autonomous = site === "review-finish" || site === "self-approve" || site === "work-finish";
  await db.project.create({ data: { id: projectId, teamId: ids.team, name: "Requester", slug: randomUUID(), githubRepo: repo, ...(autonomous ? { governanceMode: "AUTONOMOUS" as const } : {}) } });
  const state = site === "github-merge" || site === "task-merge" ? { status: "done", claimedByAgentId: ids.agent }
    : site === "review-finish" ? { status: "review", reviewClaimedByAgentId: ids.agent }
      : site === "self-approve" ? { status: "review", claimedByAgentId: ids.agent }
        : { status: "in_progress", claimedByAgentId: ids.agent };
  await db.task.create({ data: { id: taskId, projectId, title: "Requester", createdByAgentId: ids.agent, branchName: "feature", prNumber, prUrl: prNumber === null ? null : `https://github.com/${repo}/pull/${prNumber}`, ...state } });
  return { taskId, projectId, repo, prNumber };
}
export type Requester = Awaited<ReturnType<typeof requesterTask>>;

/** The site's request, naming `repo` and `prNumber` wherever the request carries a target. */
export function siteRequest(site: RemoteSite, taskId: string, repo: string, prNumber: number, auth: string, key: string | null = null) {
  const slash = repo.indexOf("/");
  const owner = repo.slice(0, slash); const name = repo.slice(slash + 1);
  const [path, body] = site === "github-merge" ? [`/api/github/pull-requests/${prNumber}/merge`, { taskId, owner, repo: name }]
    : site === "task-merge" ? [`/api/tasks/${taskId}/merge`, {}]
      : site === "review-finish" || site === "self-approve" ? [`/api/tasks/${taskId}/finish`, { outcome: "approve", autoMerge: true }]
        : site === "work-finish" ? [`/api/tasks/${taskId}/finish`, { autoMerge: true }]
          : site === "create" ? ["/api/github/pull-requests", { taskId, owner, repo: name, head: "feature", title: "Create" }]
            : [`/api/github/pull-requests/${prNumber}/comments`, { taskId, owner, repo: name, body: "A comment" }];
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}`, ...(key === null ? {} : { "Idempotency-Key": key }) }, body: JSON.stringify(body) });
}

/** The GitHub write the site sends for `repo` and `prNumber`. */
export function siteWrite(site: RemoteSite, repo: string, prNumber: number) {
  if (site === "create") return `POST https://api.github.com/repos/${repo}/pulls`;
  if (site === "comment") return `POST https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  return `PUT https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`;
}

/** A GitHub stand-in that answers every write successfully and records each call as "METHOD url". */
export function githubStub() {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (method === "PUT" && url.endsWith("/merge")) return Response.json({ sha: "c".repeat(40), merged: true, message: "Pull Request successfully merged" });
    if (method === "POST" && url.endsWith("/pulls")) {
      const repo = /repos\/(.+)\/pulls$/.exec(url)![1];
      return Response.json({ number: 501, html_url: `https://github.com/${repo}/pull/501`, title: "Create" }, { status: 201 });
    }
    if (method === "POST" && url.endsWith("/comments")) return Response.json({ id: 9, html_url: "https://github.com/comment/9", body: "A comment" }, { status: 201 });
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
  return { fetcher, calls, writes: () => calls.filter(call => !call.startsWith("GET ")) };
}

/**
 * A task of its own project, stored with the given repository, PR number and
 * PR URL, in the given Grounding class: a peer (protected cohort, EXTERNAL_V1
 * cohort, binding, hold) or a non-peer (no enrollment, OFF cohort, released
 * hold).
 */
export type PeerClass = "protected" | "external" | "bound" | "held" | "none" | "off" | "released";
export async function peerTask(db: PrismaClient, kind: PeerClass, row: { repo: string; prNumber: number | null; prUrl: string | null }) {
  const projectId = randomUUID(); const taskId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId: ids.team, name: "Peer", slug: randomUUID(), githubRepo: row.repo } });
  await db.task.create({ data: { id: taskId, projectId, title: "Peer", status: "review", prNumber: row.prNumber, prUrl: row.prUrl } });
  if (kind === "protected") await db.groundingCohort.create({ data: { taskId, projectId, mode: "LEGACY_LOCAL", protected: true, provenance: "test-server", legacySessionId: "legacy.session", legacyPhase: "claim-evaluation" } });
  // An unprotected EXTERNAL_V1 cohort row is not a valid enrollment, which is
  // exactly why it isolates the EXTERNAL_V1 condition from protection.
  if (kind === "external") await db.groundingCohort.create({ data: { taskId, projectId, mode: "EXTERNAL_V1", protected: false, provenance: "test-server" } });
  if (kind === "off") await db.groundingCohort.create({ data: { taskId, projectId, mode: "OFF", protected: false, provenance: "test-server" } });
  if (kind === "bound") await db.groundingBinding.create({ data: { taskId, projectId, audience: "consumer.test", protected: true, subjectMode: "CODE_HEAD", policyId: GROUNDING_POLICY.id, policyRevision: GROUNDING_POLICY.revision, policySha256: GROUNDING_POLICY.sha256 } });
  if (kind === "held" || kind === "released") await db.groundingMigrationState.create({ data: { taskId, projectId, held: kind === "held", revision: 1 } });
  return { taskId, projectId };
}
export const pullUrl = (repo: string, prNumber: number) => `https://github.com/${repo}/pull/${prNumber}`;

/** Another operation owns `repo`'s fence. */
export async function ownFence(db: PrismaClient, repo: string) {
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId: ids.team, name: "Fence owner", slug: randomUUID(), githubRepo: null } });
  const other = await db.task.create({ data: { projectId, title: "In-flight grouped operation", status: "in_progress" } });
  const intent = await db.groundingGithubFenceIntent.create({ data: { id: randomUUID(), repo: repo.toLowerCase(), kind: "MERGE", taskId: other.id, state: "ACTIVE" } });
  await db.groundingGithubRepositoryFence.upsert({ where: { repo: repo.toLowerCase() }, create: { repo: repo.toLowerCase(), ownerId: intent.id }, update: { ownerId: intent.id } });
}
