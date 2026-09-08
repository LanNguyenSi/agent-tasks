import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { vi } from "vitest";
import { groundingPostgres } from "./grounding-postgres.js";
import { actor as baseActor, ids, epoch, headSha, session, testIssuer } from "./grounding-fixtures.js";
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { GroundingFinalizationService } from "../../src/services/grounding-finalization.js";
import type { GroundingMergeProvider, MergeProof } from "../../src/services/grounding-merge-provider.js";
import { provisionGroundingCohort } from "../../src/services/grounding-cohort.js";

export const completionActor = { ...baseActor, scopes: ["tasks:transition", "tasks:update", "tasks:claim", "github:pr_merge"] };
export async function completionStore() {
  const store = await groundingPostgres();
  await store.db.user.create({ data: { id: ids.user, login: "completion", githubAccessToken: "test-only", githubConnectedAt: new Date(), allowAgentPrCreate: true, allowAgentPrMerge: true } });
  await store.db.team.create({ data: { id: ids.team, name: "Completion", slug: "completion" } });
  await store.db.teamMember.create({ data: { teamId: ids.team, userId: ids.user, role: "ADMIN" } });
  await store.db.agentToken.create({ data: { id: ids.agent, teamId: ids.team, createdById: ids.user, name: "Test", tokenHash: "test", scopes: completionActor.scopes } });
  return store;
}
export async function completionFixture(store: Awaited<ReturnType<typeof completionStore>>, mode: "EXTERNAL_V1" | "OFF" | "LEGACY_LOCAL" = "EXTERNAL_V1") {
  const db = store.db; const taskId = randomUUID(); const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId: ids.team, name: "Test", slug: randomUUID(), githubRepo: "acme/repo" } });
  await db.task.create({ data: { id: taskId, projectId, title: "Exact task", description: "Original", templateData: { goal: "Exact" }, status: "in_progress", claimedByAgentId: ids.agent, createdByAgentId: ids.agent, prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42", branchName: "branch" } });
  const f = { db, taskId, projectId, now: epoch, head: headSha, issuer: testIssuer([projectId]), proof: { repo: "acme/repo", prNumber: 42, headSha, merged: false, mergeCommitSha: null } as MergeProof };
  const deliverSignal = vi.fn(async () => {});
  const ledger = { getLedgerSummary: vi.fn(async () => ({ entryCount: 1 })) };
  const merge = vi.fn<GroundingMergeProvider["merge"]>(async () => { f.proof = { ...f.proof, merged: true, mergeCommitSha: "b".repeat(40) }; });
  const read = vi.fn<GroundingMergeProvider["read"]>(async () => ({ ...f.proof }));
  const head = vi.fn(async () => f.head);
  const deps = (client: PrismaClient = db) => ({ db: client, config: { audience: "consumer.test", trust: () => f.issuer.trust }, now: () => f.now, deliverSignal, headProvider: head, legacyClient: ledger, mergeProvider: { merge, read } });
  const attempts = new GroundingAttemptsService(deps());
  const make = (client = db) => new GroundingFinalizationService(deps(client));
  if (mode === "EXTERNAL_V1") await attempts.provision({ taskId, projectId, subjectMode: "CODE_HEAD" });
  else await provisionGroundingCohort(db, { taskId, projectId, cohort: mode === "OFF" ? { mode, protected: false, provenance: "test-server", legacySessionId: null, legacyPhase: null } : { mode, protected: true, provenance: "test-server", legacySessionId: "legacy.session", legacyPhase: "claim-evaluation" } });
  return Object.assign(f, { attempts, service: make(), make, headProvider: head, merge, read, ledger, deliverSignal,
    async evidence(intent: "finish" | "approve" | "merge" = "finish", actor = completionActor) {
      const challenge = await attempts.issue(taskId, actor, intent);
      const receipt = f.issuer.receipt(challenge);
      await attempts.ingest(taskId, challenge.attemptId, actor, session, receipt);
      return { challenge, receipt };
    },
    task() { return db.task.findUniqueOrThrow({ where: { id: taskId } }); },
    async snapshot() {
      return { task: await db.task.findUnique({ where: { id: taskId } }), cohort: await db.groundingCohort.findUnique({ where: { taskId } }), binding: await db.groundingBinding.findUnique({ where: { taskId } }),
        attempts: await db.groundingAttempt.findMany({ where: { taskId }, orderBy: { id: "asc" } }), receipts: await db.groundingReceipt.findMany({ where: { taskId } }), operations: await db.groundingOperation.findMany({ where: { taskId } }), finalizations: await db.groundingFinalization.findMany({ where: { taskId } }), audit: await db.auditLog.findMany({ where: { taskId } }) };
    },
    async workflow(requires: string[] = []) {
      await db.workflow.create({ data: { projectId, name: "Test", isDefault: true, definition: { initialState: "queued", states: [{ name: "queued", label: "Queued", terminal: false }, { name: "working", label: "Working", terminal: false }, { name: "checking", label: "Checking", terminal: false }, { name: "shipped", label: "Shipped", terminal: true }], transitions: [{ from: "queued", to: "working" }, { from: "working", to: "checking", requires }, { from: "checking", to: "shipped", requires }, { from: "checking", to: "working" }] } as Prisma.InputJsonValue } });
      await db.task.update({ where: { id: taskId }, data: { status: "working" } });
    },
  });
}
