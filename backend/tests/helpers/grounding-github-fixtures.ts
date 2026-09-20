import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { completionActor, completionFixture, type completionStore } from "./grounding-completion-fixtures.js";
import { testIssuer } from "./grounding-fixtures.js";
import { GroundingGithubMergeService } from "../../src/services/grounding-github-merge.js";
import type { OperationInput } from "../../src/services/grounding-operations.js";

export async function githubGroupFixture(store: Awaited<ReturnType<typeof completionStore>>) {
  const seed = await completionFixture(store);
  const peer = await completionFixture(store);
  const repo = `acme/group_${randomUUID().replaceAll("-", "")}`;
  const issuer = testIssuer([seed.projectId, peer.projectId]);
  for (const fixture of [seed, peer]) {
    fixture.issuer = issuer;
    fixture.proof.repo = repo;
    await store.db.project.update({ where: { id: fixture.projectId }, data: { githubRepo: repo } });
    await store.db.task.update({ where: { id: fixture.taskId }, data: { status: "review", prUrl: `https://github.com/${repo}/pull/42` } });
  }
  const make = (db: PrismaClient = store.db) => new GroundingGithubMergeService({ db, config: { audience: "consumer.test", trust: () => issuer.trust }, now: () => seed.now, headProvider: seed.headProvider, mergeProvider: { merge: seed.merge, read: seed.read }, deliverSignal: seed.deliverSignal, legacyClient: seed.ledger });
  const service = make();
  const request: OperationInput = { action: "merge", method: "squash", route: { kind: "github_merge", transport: { endpoint: "github_merge", body: { taskId: seed.taskId, owner: "acme", repo: repo.split("/")[1], prNumber: 42, merge_method: "squash", idempotencyKey: "group" } } } };
  return { seed, peer, repo, issuer, service, make, request,
    async evidence() { await seed.evidence("merge"); await peer.evidence("merge"); },
    reserve() { return service.reserveMerge(seed.taskId, completionActor, "group", request as Parameters<typeof service.reserveMerge>[3]); },
    dispatch() { return service.dispatchMerge(seed.taskId, completionActor, "group"); },
    recover() { return service.recoverMerge(seed.taskId, completionActor, "group"); },
    async snapshot() { return { seed: await seed.snapshot(), peer: await peer.snapshot(), group: await store.db.groundingGithubMergeGroup.findUnique({ where: { seedTaskId_key: { seedTaskId: seed.taskId, key: "group" } }, include: { members: { orderBy: { taskId: "asc" } } } }), fence: await store.db.groundingGithubRepositoryFence.findUnique({ where: { repo } }), signals: await store.db.signal.findMany({ where: { taskId: { in: [seed.taskId, peer.taskId] } }, orderBy: { id: "asc" } }) }; },
  };
}
