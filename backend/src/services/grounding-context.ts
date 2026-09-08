import { createHash } from "node:crypto";
import type { GroundingBinding, Prisma, Project, Task } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "../types/auth.js";
import { approveTarget, defaultWorkflowDefinition, expectedFinishStateFromDefinition, isReviewState, isTerminalState, isWorkState } from "./default-workflow.js";
import { checkReviewApprovalGate, checkSelfMergeGate } from "./review-gate.js";
import { resolveGovernanceMode } from "../lib/governance-mode.js";
import { findDelegationUser } from "./github-delegation.js";
import { hasProjectRole, requireProjectWrite, type ProjectRole } from "./team-access.js";
import { GroundingReceiptVerificationError, type GroundingReceiptExpectedContext } from "./grounding-receipt.js";

export const GROUNDING_POLICY = Object.freeze({
  id: "debug-evidence-assessment/v1",
  revision: "1",
  sha256: "50c68e4070b5c36c2bd166f61f83377df717253f30933fe05825386d605325a4",
});
const token = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const groundingIntentSchema = z.enum(["finish", "approve", "merge"]);
export type GroundingIntent = z.infer<typeof groundingIntentSchema>;
export type GroundingTarget = GroundingReceiptExpectedContext["target"];
export class GroundingAccessError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "bad_state" | "grounding_not_provisioned", readonly status: 403 | 404 | 409) {
    super(code);
  }
}
export function unavailable(): never {
  throw new GroundingReceiptVerificationError("grounding_verification_unavailable");
}
export function mismatch(): never {
  throw new GroundingReceiptVerificationError("grounding_receipt_mismatch");
}

const definitionSchema = z.object({
  initialState: token,
  states: z.array(z.object({ name: token, label: z.string(), terminal: z.boolean() }).passthrough()).min(1),
  transitions: z.array(z.object({ from: token, to: token, requiredRole: z.enum(["any", "ADMIN", "HUMAN_MEMBER", "REVIEWER"]).optional() }).passthrough()),
}).passthrough();

export type GroundingTask = Task & { project: Project };
export interface GroundingAuthority {
  canWrite: typeof requireProjectWrite;
  hasRole: typeof hasProjectRole;
}
export const groundingAuthority: GroundingAuthority = { canWrite: requireProjectWrite, hasRole: hasProjectRole };

export async function resolveGroundingTarget(
  db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, intent: GroundingIntent,
  authority: GroundingAuthority = groundingAuthority,
): Promise<{ target: GroundingTarget; definition: unknown }> {
  if (actor.type === "agent" && !actor.scopes.includes("tasks:transition"))
    throw new GroundingAccessError("forbidden", 403);
  if (!await authority.canWrite(actor, task.projectId, db))
    throw new GroundingAccessError("forbidden", 403);
  const workflows = await db.workflow.findMany({
    where: task.workflowId ? { id: task.workflowId, projectId: task.projectId } : { projectId: task.projectId, isDefault: true },
  });
  if (workflows.length > 1 || (task.workflowId && workflows.length !== 1)) unavailable();
  const definition: unknown = workflows[0]?.definition ?? defaultWorkflowDefinition();
  const parsed = definitionSchema.safeParse(definition);
  if (!parsed.success) unavailable();
  const def = parsed.data;
  if (new Set(def.states.map(s => s.name)).size !== def.states.length ||
      !def.states.some(s => s.name === def.initialState) ||
      def.transitions.some(t => !def.states.some(s => s.name === t.from) || !def.states.some(s => s.name === t.to))) unavailable();
  const holdsWork = actor.type === "human" ? task.claimedByUserId === actor.userId : task.claimedByAgentId === actor.tokenId;
  const holdsReview = actor.type === "human" ? task.reviewClaimedByUserId === actor.userId : task.reviewClaimedByAgentId === actor.tokenId;
  const review = isReviewState(def, task.status);
  if (intent === "approve" || (intent === "merge" && review)) {
    if (!review) throw new GroundingAccessError("bad_state", 409);
    if (!holdsReview && !(holdsWork && !task.reviewClaimedByUserId && !task.reviewClaimedByAgentId))
      throw new GroundingAccessError("forbidden", 403);
    if (!checkReviewApprovalGate(task, actor, task.project).allowed)
      throw new GroundingAccessError("forbidden", 403);
  } else {
    if (!isWorkState(def, task.status) || review) throw new GroundingAccessError("bad_state", 409);
    if (!holdsWork || holdsReview) throw new GroundingAccessError("forbidden", 403);
  }
  if (intent === "merge" && !checkSelfMergeGate(task, actor, task.project).allowed)
    throw new GroundingAccessError("forbidden", 403);
  const outgoing = def.transitions.filter(t => t.from === task.status);
  const reviewEdges = outgoing.filter(t => isReviewState(def, t.to));
  const candidates = intent === "finish" && reviewEdges.length > 0
    ? reviewEdges : outgoing.filter(t => isTerminalState(def, t.to));
  if (candidates.length !== 1) throw new GroundingAccessError("bad_state", 409);
  const edge = candidates[0];
  const existingTarget = intent === "finish" ? expectedFinishStateFromDefinition(def) : approveTarget(def, task.status);
  if (edge.to !== existingTarget) throw new GroundingAccessError("bad_state", 409);
  if (edge.requiredRole && !await authority.hasRole(actor, task.projectId, edge.requiredRole as ProjectRole, db))
    throw new GroundingAccessError("forbidden", 403);
  return { target: { workflowId: workflows[0]?.id ?? null, from: task.status, to: edge.to, action: intent }, definition };
}

/** JSON values sorted by UTF-16 code units; arrays and Unicode scalars retain their exact value. */
export function canonicalGroundingJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) unavailable();
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    // Reject lone surrogates instead of silently converting to replacement bytes.
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) unavailable();
      } else if (unit >= 0xdc00 && unit <= 0xdfff) unavailable();
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalGroundingJson).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) unavailable();
  return `{${Object.keys(value).sort().map(key => `${canonicalGroundingJson(key)}:${canonicalGroundingJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export interface GroundingHeadInput {
  actor: Actor;
  teamId: string;
  repo: string;
  prNumber: number;
  db?: Prisma.TransactionClient;
}
export type GroundingHeadProvider = (input: GroundingHeadInput) => Promise<string>;

/** Uncached, bounded read using the same delegation consent as existing GitHub-backed gates. */
export const fetchGroundingHead: GroundingHeadProvider = async ({ actor, teamId, repo, prNumber, db }) => {
  try {
    const delegate = await findDelegationUser(teamId, "allowAgentPrCreate", { preferUserId: actor.userId, ...(db ? { db } : {}) });
    if (!delegate) unavailable();
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
      headers: { Authorization: `Bearer ${delegate.githubAccessToken}`, Accept: "application/vnd.github+json", "Cache-Control": "no-cache" },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.body) unavailable();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 262144) { await reader.cancel(); unavailable(); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    const parsed = z.object({
      number: z.literal(prNumber), html_url: z.literal(`https://github.com/${repo}/pull/${prNumber}`),
      base: z.object({ repo: z.object({ full_name: z.literal(repo) }) }),
      head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
    }).safeParse(body);
    if (!parsed.success) unavailable();
    return parsed.data.head.sha;
  } catch { return unavailable(); }
};

export async function projectGroundingContext(
  task: GroundingTask, binding: GroundingBinding, target: GroundingTarget, definition: unknown,
  actor: Actor, headProvider: GroundingHeadProvider, db?: Prisma.TransactionClient,
): Promise<{ bytes: Buffer; digest: string }> {
  if (binding.taskId !== task.id || binding.projectId !== task.projectId) mismatch();
  if (!binding.protected || binding.policyId !== GROUNDING_POLICY.id || binding.policyRevision !== GROUNDING_POLICY.revision || binding.policySha256 !== GROUNDING_POLICY.sha256) unavailable();
  const repo = task.deliverableRepo ?? task.project.githubRepo;
  let headSha: string | null = null;
  if (binding.subjectMode === "CODE_HEAD") {
    if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(task.prNumber) || (task.prNumber ?? 0) <= 0 ||
        task.prUrl !== `https://github.com/${repo}/pull/${task.prNumber}`) unavailable();
    try { headSha = await headProvider({ actor, teamId: task.project.teamId, repo, prNumber: task.prNumber!, ...(db ? { db } : {}) }); }
    catch { unavailable(); }
    if (!/^[0-9a-f]{40}$/.test(headSha)) unavailable();
  } else if (binding.subjectMode !== "TASK_SPEC") unavailable();
  const bytes = Buffer.from(canonicalGroundingJson({
    version: "task-context/v1", audience: binding.audience, projectId: task.projectId, taskId: task.id,
    title: task.title, description: task.description, templateData: task.templateData,
    protection: { protected: binding.protected, subjectMode: binding.subjectMode },
    policy: { id: binding.policyId, revision: binding.policyRevision, sha256: binding.policySha256 },
    project: { teamId: task.project.teamId, githubRepo: task.project.githubRepo, taskTemplate: task.project.taskTemplate, governanceMode: resolveGovernanceMode(task.project) },
    workflow: { id: target.workflowId, definition }, target,
    claims: { workUserId: task.claimedByUserId, workAgentId: task.claimedByAgentId, reviewUserId: task.reviewClaimedByUserId, reviewAgentId: task.reviewClaimedByAgentId },
    deliverable: { repo, prNumber: task.prNumber, prUrl: task.prUrl, branchName: task.branchName, headSha },
  }), "utf8");
  return { bytes, digest: createHash("sha256").update(bytes).digest("hex") };
}
