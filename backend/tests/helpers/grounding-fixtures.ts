import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { GroundingBinding, Prisma, Project, Task } from "@prisma/client";
import type { AgentActor } from "../../src/types/auth.js";
import { GROUNDING_POLICY } from "../../src/services/grounding-context.js";
import type { GroundingChallenge, GroundingSession } from "../../src/services/grounding-attempts.js";
import type { GroundingReceiptTrustEntry } from "../../src/services/grounding-receipt.js";

export const epoch = 1700000000;
export const ids = { task: "00000000-0000-4000-8000-000000000001", project: "00000000-0000-4000-8000-000000000002", team: "00000000-0000-4000-8000-000000000003", agent: "00000000-0000-4000-8000-000000000004", user: "00000000-0000-4000-8000-000000000005" };
export const actor: AgentActor = { type: "agent", tokenId: ids.agent, teamId: ids.team, userId: ids.user, scopes: ["tasks:transition"] };
export const session: GroundingSession = { id: "session.test", revision: 1 };
export const headSha = "a".repeat(40);
export const taskFixture = (): Task & { project: Project } => ({
  id: ids.task, projectId: ids.project, title: "Exact café 😀", description: "Line one\r\nLine two", templateData: { z: "e\u0301", a: null },
  status: "in_progress", workflowId: null, claimedByAgentId: ids.agent, claimedByUserId: null,
  reviewClaimedByAgentId: null, reviewClaimedByUserId: null, metadata: { debugFlavor: true },
  deliverableRepo: null, prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42", branchName: "task/branch",
  project: { id: ids.project, teamId: ids.team, githubRepo: "acme/repo", taskTemplate: null, governanceMode: null, soloMode: false, requireDistinctReviewer: false },
} as unknown as Task & { project: Project });
export const bindingFixture = (): GroundingBinding => ({ taskId: ids.task, projectId: ids.project, audience: "consumer.test", protected: true, subjectMode: "CODE_HEAD", policyId: GROUNDING_POLICY.id, policyRevision: GROUNDING_POLICY.revision, policySha256: GROUNDING_POLICY.sha256, contextRevision: 1, contextDigest: null, activeAttemptId: null, createdAt: new Date(epoch * 1000) });
export function testIssuer(projectIds = [ids.project]) {
  const key = generateKeyPairSync("ed25519");
  const trust: GroundingReceiptTrustEntry[] = [{ issuer: "test.issuer", kid: "test.key", publicKeyPem: key.publicKey.export({ format: "pem", type: "spki" }).toString(), profileDigest: GROUNDING_POLICY.sha256, projectIds, audiences: ["consumer.test"] }];
  function receipt(challenge: GroundingChallenge, overrides: Record<string, unknown> = {}) {
    const payload = {
      schemaVersion: 1, receiptId: randomUUID(), audience: challenge.audience, projectId: challenge.projectId, taskId: challenge.taskId,
      attemptId: challenge.attemptId, nonce: challenge.nonce, contextRevision: challenge.contextRevision,
      target: challenge.target, subject: challenge.subject, policy: challenge.policy, session,
      assessment: { outcome: "pass", evidenceOrigin: "agent_asserted", factCount: 1, claimAllowed: true, reasons: [], dossierSha256: "b".repeat(64) },
      evaluatedAt: challenge.createdAt, issuedAt: challenge.createdAt, expiresAt: Math.min(challenge.expiresAt, challenge.createdAt + 900),
      producer: { name: "test-producer", version: "1", policyBuild: "test" }, ...overrides,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = sign(null, Buffer.from(`grounding-receipt/v1\nEd25519\ntest.issuer\ntest.key\n${encoded}`), key.privateKey).toString("base64url");
    return JSON.stringify({ format: "grounding-receipt/v1", alg: "Ed25519", issuer: "test.issuer", kid: "test.key", payload: encoded, signature });
  }
  return { trust, receipt };
}
export const workflowDb = (definition?: unknown, id = randomUUID()): Prisma.TransactionClient => ({ workflow: { findMany: async () => definition === undefined ? [] : [{ id, definition }] } } as unknown as Prisma.TransactionClient);
